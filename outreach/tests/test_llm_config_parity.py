#!/usr/bin/env python3
"""llm_config 的 Python/JS 一致性对拍。

    python3 tests/test_llm_config_parity.py

`llm_config.py` 与 `llm_config.mjs` 是同一套解析规则的两份实现,分别被
mail_sweeper(Python)和 agent_submit(Node)使用。**两边算出不同端点 = 两个组件
连到不同的 LLM**,而且这种分叉不会报错,只会表现为"某个组件行为莫名不对"。
所以规则不能靠"改的时候记得同步",得有对拍。

改了任一侧的解析规则,先跑这个;失败就说明两份分叉了。
不需要网络,不需要真 key(只比解析结果,不发请求)。
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUTREACH = os.path.dirname(HERE)

# 抛错也是要对拍的行为:两边必须在同样的输入上同样地拒绝(见 §同源绑定)
PY_SNIPPET = (
    "import json,llm_config\n"
    "try:\n"
    "    c=llm_config.load()\n"
    "    print(json.dumps({'url':c['url'],'key':c['key'],'models':c['models'],"
    "'warn':len(c['warnings'])},sort_keys=True))\n"
    "except RuntimeError:\n"
    "    print(json.dumps({'refused':True}))\n"
)
JS_SNIPPET = (
    "import('./llm_config.mjs').then(m=>{"
    "  let o; try { const c=m.load();"
    "    o={key:c.key,models:c.models,url:c.url,warn:c.warnings.length}; }"
    "  catch { o={refused:true}; }"
    "  console.log(JSON.stringify(o)); })"
)


def _run(cmd, env):
    base = {k: v for k, v in os.environ.items()
            if not k.startswith(("LLM_", "OPENAI_"))}
    base.update(env)
    r = subprocess.run(cmd, env=base, capture_output=True, text=True, cwd=OUTREACH)
    if r.returncode != 0:
        raise AssertionError(f"{cmd[0]} 退出码 {r.returncode}:{(r.stderr or '')[:400]}")
    out = r.stdout.strip()
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out                     # 纯文本用例(如 SAME/DIFF)


def cases(tmp):
    """(用例名, env)。LLM_CONFIG 指到不存在的文件 = 只测 env 分支。"""
    none = os.path.join(tmp, "nope.json")
    llmj = os.path.join(tmp, "llm.json")
    sitej = os.path.join(tmp, "my_site.json")
    with open(llmj, "w") as f:
        json.dump({"base_url": "https://fromfile.com/v1", "api_key": "sk-file1234567890",
                   "model": "file-m", "fallbacks": ["fb-a", "fb-b"]}, f)
    with open(sitej, "w") as f:
        json.dump({"llm_endpoint": "https://fromsite.com/v1", "llm_key": "sk-site1234567890",
                   "llm_model": "site-m"}, f)
    E = {"LLM_CONFIG": none, "OUTREACH_MY_SITE": os.path.join(tmp, "absent.json")}
    F = {"LLM_CONFIG": llmj, "OUTREACH_MY_SITE": os.path.join(tmp, "absent.json")}
    S = {"LLM_CONFIG": none, "OUTREACH_MY_SITE": sitej}
    return [
        # --- base URL 归一:六种写法 ---
        ("只给根域", {**E, "LLM_BASE_URL": "https://api.x.com"}),
        ("给 base URL(标准)", {**E, "LLM_BASE_URL": "https://openrouter.ai/api/v1"}),
        ("base URL 带尾斜杠", {**E, "LLM_BASE_URL": "https://api.deepseek.com/v1/"}),
        ("给完整地址", {**E, "LLM_BASE_URL": "https://api.x.com/v1/chat/completions"}),
        ("Gemini v1beta", {**E, "LLM_BASE_URL": "https://x.googleapis.com/v1beta"}),
        ("Azure 带 query", {**E, "LLM_BASE_URL":
                            "https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-02-01"}),
        ("本机 Ollama", {**E, "LLM_BASE_URL": "http://127.0.0.1:11434/v1"}),
        ("末尾多个斜杠", {**E, "LLM_BASE_URL": "https://api.x.com/v1///"}),
        # --- 来源优先级 ---
        ("旧 env 兼容", {**E, "LLM_ENDPOINT": "https://old.com/v1/chat/completions",
                         "LLM_KEY": "sk-oldname123456"}),
        ("通用 OPENAI_*", {**E, "OPENAI_BASE_URL": "https://api.openai.com/v1",
                           "OPENAI_API_KEY": "sk-generic99999999"}),
        ("新名压旧名", {**E, "LLM_BASE_URL": "https://new.com/v1", "LLM_ENDPOINT": "https://old.com/v1",
                        "LLM_API_KEY": "sk-new888888888", "LLM_KEY": "sk-old"}),
        ("llm.json 生效", F),
        ("env 压 llm.json", {**F, "LLM_BASE_URL": "https://env.com/v1",
                             "LLM_API_KEY": "sk-env12345678901"}),
        ("my_site 旧字段兜底", S),
        ("llm.json 压 my_site", {**F, "OUTREACH_MY_SITE": sitej}),
        # --- 模型链 ---
        ("降级链去重保序", {**E, "LLM_MODEL": "a", "LLM_FALLBACKS": " b , a ,c ,"}),
        ("降级链空串", {**E, "LLM_MODEL": "a", "LLM_FALLBACKS": " , , "}),
        # --- 同源绑定:base 与 key 必须成对(Codex P1)---
        ("同源:env 成对", {**E, "LLM_BASE_URL": "https://a.com/v1", "LLM_API_KEY": "sk-a1234567890"}),
        ("同源:只给 key 走缺省地址", {**E, "OPENAI_API_KEY": "sk-generic99999999"}),
        ("歧义:env 地址 + 文件 key → 拒", {**F, "LLM_BASE_URL": "https://other.com/v1"}),
        ("歧义:env key + 文件地址 → 拒", {**F, "LLM_API_KEY": "sk-envkey12345678"}),
        ("歧义:放行开关", {**F, "LLM_API_KEY": "sk-envkey12345678",
                            "LLM_ALLOW_SPLIT_CONFIG": "1"}),
        ("同 origin 不算歧义", {**F, "LLM_BASE_URL": "https://fromfile.com/v1/",
                                "LLM_API_KEY": "sk-envkey12345678"}),
        # --- origin 归一化(同源绑定的判据本身,两边不一致=一边拒一边放)---
        ("origin:主机大小写", {**F, "LLM_BASE_URL": "https://FROMFILE.com/v1",
                               "LLM_API_KEY": "sk-envkey12345678"}),
        ("origin:显式默认端口", {**F, "LLM_BASE_URL": "https://fromfile.com:443/v1",
                                 "LLM_API_KEY": "sk-envkey12345678"}),
        ("origin:非默认端口算不同", {**F, "LLM_BASE_URL": "https://fromfile.com:8443/v1",
                                     "LLM_API_KEY": "sk-envkey12345678"}),
        ("origin:scheme 不同算不同", {**F, "LLM_BASE_URL": "http://fromfile.com/v1",
                                      "LLM_API_KEY": "sk-envkey12345678"}),
        ("origin:IPv6", {**E, "LLM_BASE_URL": "http://[::1]:8080/v1", "LLM_API_KEY": "sk-v6123456789"}),
        # --- 畸形/不可解析地址:两边必须同样拒绝(R8 P1-1 / P2-8)---
        ("畸形:反斜杠+userinfo", {**E, "LLM_BASE_URL": "https://old.com\\@new.com/v1",
                                   "LLM_API_KEY": "sk-mal123456789"}),
        ("畸形:userinfo", {**E, "LLM_BASE_URL": "https://a@b.com/v1", "LLM_API_KEY": "sk-mal223456789"}),
        ("畸形:端口越界", {**E, "LLM_BASE_URL": "https://example.com:99999/v1",
                            "LLM_API_KEY": "sk-mal323456789"}),
        ("畸形:非 http(s)", {**E, "LLM_BASE_URL": "ftp://example.com/v1", "LLM_API_KEY": "sk-mal423456789"}),
        ("畸形:地址里有空格", {**E, "LLM_BASE_URL": "https://exa mple.com/v1", "LLM_API_KEY": "sk-mal523456789"}),
        # --- ALLOW_SPLIT 的布尔解析与"不反向覆盖"---
        ("split=0 不该开启", {**F, "LLM_API_KEY": "sk-envkey12345678",
                              "LLM_ALLOW_SPLIT_CONFIG": "0"}),
        ("split=false 不该开启", {**F, "LLM_API_KEY": "sk-envkey12345678",
                                  "LLM_ALLOW_SPLIT_CONFIG": "false"}),
        ("split=true 放行且不反向覆盖", {**F, "LLM_BASE_URL": "https://winner.com/v1",
                                        "LLM_API_KEY": "sk-envkey12345678",
                                        "LLM_ALLOW_SPLIT_CONFIG": "true"}),
        # --- 无 key 分支(此前 38 组用例**每组都带 key**,正好漏掉这一整条分支)---
        ("无key:畸形地址也要拒", {**E, "LLM_BASE_URL": "https://old.com\\@new.com/v1"}),
        ("无key:userinfo 也要拒", {**E, "LLM_BASE_URL": "https://a@b.com/v1"}),
        ("无key:端口越界也要拒", {**E, "LLM_BASE_URL": "https://example.com:99999/v1"}),
        ("无key:合法地址正常解析", {**E, "LLM_BASE_URL": "https://api.openai.com/v1"}),
        ("无key:全缺省", {**E}),
        # --- 路径 env 的边界(空串曾让 py/js 分叉)---
        ("LLM_CONFIG 空串", {"LLM_CONFIG": "", "OUTREACH_MY_SITE": "",
                             "LLM_BASE_URL": "https://z.com/v1", "LLM_API_KEY": "sk-z1234567890"}),
        # --- 缺省 ---
        ("全缺省", E),
    ]


def redirect_origin_cases():
    """跨源重定向摘 Authorization 的判据,py 与 js 必须同口径。
    曾经 py 用 (scheme, hostname, port) 裸比 —— https://x.com 与 https://x.com:443
    被判成跨源,合法重定向被摘头拿 401。"""
    PAIRS = [("https://x.com/v1", "https://x.com:443/v1", True),
             ("https://x.com:443/v1", "https://x.com/v1", True),
             ("http://x.com/v1", "http://x.com:80/v1", True),
             ("https://x.com/v1", "https://x.com/v2", True),
             ("https://x.com/v1", "https://evil.com/v1", False),
             ("https://x.com/v1", "http://x.com/v1", False),
             ("https://x.com/v1", "https://x.com:8443/v1", False)]
    env = {"OUTREACH_STATE_DIR": tempfile.mkdtemp()}
    bad = []
    for a, b, want_same in PAIRS:
        code = ("import llm_config as c;"
                f"print('SAME' if c.origin_of({a!r})==c.origin_of({b!r}) else 'DIFF')")
        got = _run([sys.executable, "-c", code], env)
        same = got == "SAME" if isinstance(got, str) else None
        ok = same is want_same
        if not ok:
            bad.append(f"{a} vs {b}")
        print(f"{'✅' if ok else '❌'} 重定向同源判定 {a} vs {b} → {'同源' if same else '跨源'}")
    return bad


def shared_constants():
    """py/js 共享常量对拍。两边是两份实现、共用同一个账本与 claims/ 目录,
    常量一旦分叉就是"一边认为该拒、另一边放行"。手工对齐必须有对拍兜着。"""
    KEYS = ["STATUSES", "DELIVERED", "CONFIRMED_DELIVERED", "CLAIM_BLOCKING",
            "REGRESSIVE", "AMBIGUOUS_UPGRADES", "AUTHORITATIVE_REASONS"]
    env = {"OUTREACH_STATE_DIR": tempfile.mkdtemp()}
    py = _run([sys.executable, "-c",
               "import json,state;print(json.dumps({k:sorted(getattr(state,k)) for k in "
               + repr(KEYS) + "},sort_keys=True))"], env)
    js = _run(["node", "-e",
               "import('./state.mjs').then(m=>{const o={};for(const k of "
               + repr(KEYS).replace("'", '"') + ")o[k]=[...m[k]].sort();console.log(JSON.stringify(o))})"], env)
    bad = [k for k in KEYS if py.get(k) != js.get(k)]
    for k in KEYS:
        same = py.get(k) == js.get(k)
        print(f"{'✅' if same else '❌'} 常量 {k}")
        if not same:
            print(f"     PY {py.get(k)}\n     JS {js.get(k)}")
    return bad


def main():
    with tempfile.TemporaryDirectory() as tmp:
        bad = []
        for name, env in cases(tmp):
            py = _run([sys.executable, "-c", PY_SNIPPET], env)
            js = _run(["node", "-e", JS_SNIPPET], env)
            ok = py == js
            shown = "拒绝(配置有歧义)" if py.get("refused") else py.get("url", "?")
            print(f"{'✅' if ok else '❌'} {name:<26} {shown}")
            if not ok:
                bad.append(name)
                print(f"     PY {py}\n     JS {js}")
        n = len(cases(tmp))
    print()
    bad += shared_constants()
    print()
    bad += redirect_origin_cases()
    print(f"\n{n} 个配置用例 + 7 组共享常量 + 7 组重定向同源,不一致 {len(bad)} 个" + (f":{bad}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
