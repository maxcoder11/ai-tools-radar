#!/usr/bin/env python3
"""check_llm.py — LLM 端点自检:配置解析对不对 + 真的连得上 + 支不支持 json_object。

agent_submit.mjs 的注释("加回来之前请先用 check_llm.py 实测")一直指向这个文件,
但它此前不在仓里 —— 现在补上,并且是 mail_sweeper 启动预检共用的那一份实现。

## 为什么单独测 json_object

mail_sweeper.py 的 `_llm_once` 恒发 `response_format: {"type":"json_object"}`,
并且**直接 json.loads 模型返回的 content**。它判的是不可逆动作:
approved→写 pending_review、rejected→写 failed、verification_link→点一次性验证链接。
所以这里不给自由文本降级(能容忍脏输出的地方才配有降级,这里不配),
改成**开跑前就把不支持的端点拦下来**。

不测的话失败长这样:每轮打一行"LLM 全降级失败,下轮再判",信越堆越多、
验证链一条不点,而且没有任何东西会升级 —— 典型的静默永久失效。

用法:
    python3 check_llm.py            # 全测,人话报告
    python3 check_llm.py --quiet    # 只在失败时输出(给预检/CI 用)
退出码:0 全通 / 2 主模型不可用 / 3 缺配置
"""
import json
import sys
import urllib.error
import urllib.request

import llm_config

PROBE = [{"role": "user", "content": 'Reply with exactly this JSON: {"ok":true}'}]


def probe(url, key, model, timeout=45):
    """回 (ok, 结论, 详情)。ok=True 表示这个模型可以拿来跑 mail_sweeper。"""
    body = json.dumps({"model": model, "messages": PROBE,
                       "response_format": {"type": "json_object"}}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + key})
    try:
        with llm_config.urlopen(req, timeout=timeout) as r:   # 本机端点绕开代理
            raw = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        low = detail.lower()
        if e.code in (401, 403):
            return False, "认证失败", f"HTTP {e.code} —— key 不对或没权限。{detail[:120]}"
        if "response_format" in low or "json_object" in low or "json mode" in low:
            return False, "不支持 json_object", (
                f"HTTP {e.code}:端点/模型不认 response_format。"
                f"mail_sweeper 强依赖这个参数 —— 换个模型,或换一个会翻译该参数的网关"
                f"(LiteLLM / OpenRouter 都可以)。{detail[:120]}")
        if e.code == 404:
            return False, "404", (
                f"地址或模型名不对。当前 POST 的是 {url} —— "
                f"注意 LLM_BASE_URL 填 base URL 即可(如 https://x.com/v1),"
                f"不用自己拼 /chat/completions。{detail[:120]}")
        return False, f"HTTP {e.code}", detail[:160]
    except Exception as e:
        return False, "连不上", f"{type(e).__name__}: {str(e)[:140]}"

    try:
        content = raw["choices"][0]["message"]["content"]
    except Exception:
        return False, "响应结构异常", f"没有 choices[0].message.content:{str(raw)[:160]}"
    try:
        json.loads(content)
    except Exception:
        # 没报错但吐的不是 JSON:比直接 400 更阴险 —— sweeper 会每封信都解析失败
        return False, "json_object 形同虚设", (
            f"端点收下了 response_format 却返回了非 JSON,sweeper 会逐封解析失败。"
            f"实际返回:{str(content)[:120]}")
    return True, "可用", f"json_object 生效,返回 {str(content)[:60]}"


def run(quiet=False):
    try:
        cfg = llm_config.require_llm("check_llm")
    except RuntimeError as e:
        print(e)
        return 3

    out = []
    out.append(f"端点  {cfg['url']}")
    out.append(f"      (来源:{cfg['sources']['base']})")
    out.append(f"key   {llm_config.mask(cfg['key'])}  (来源:{cfg['sources']['key']})")
    out.append(f"模型  {' → '.join(cfg['models'])}")
    for w in cfg["warnings"]:
        out.append(f"提示  {w}")
    out.append("")

    results = []
    for i, m in enumerate(cfg["models"]):
        ok, verdict, detail = probe(cfg["url"], cfg["key"], m)
        results.append((m, ok, verdict))
        mark = "✅" if ok else ("❌" if i == 0 else "⚠️ ")
        role = "主模型" if i == 0 else "降级链"
        out.append(f"{mark} [{role}] {m} —— {verdict}")
        out.append(f"        {detail}")

    primary_ok = results[0][1] if results else False
    dead_fallbacks = [m for m, ok, _ in results[1:] if not ok]
    out.append("")
    if primary_ok:
        out.append("结论:主模型可用,agent_submit 与 mail_sweeper 都能跑。")
    else:
        out.append("结论:**主模型不可用**。mail_sweeper 会每轮静默判不出意图、"
                   "验证信无人处置;先修好再开跑。")
    if dead_fallbacks:
        out.append(f"另外:降级链里这些当前不可用 —— {', '.join(dead_fallbacks)}。"
                   f"留着的唯一作用是让每次主模型抖动都白等一轮握手,建议摘掉。")

    if not quiet or not primary_ok:
        print("\n".join(out))
    return 0 if primary_ok else 2


if __name__ == "__main__":
    sys.exit(run(quiet="--quiet" in sys.argv))
