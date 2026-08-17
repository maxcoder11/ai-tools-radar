#!/usr/bin/env python3
"""llm_config.py — LLM 端点配置的唯一解析口(Python 侧)。

JS 侧是 llm_config.mjs,**两份规则逐条一致**(同 rootdomain.py/.mjs 的做法)。
改任何一条,另一份必须同步改,否则 agent_submit 和 mail_sweeper 会连到不同端点。

## 为什么要有这个文件

原来 agent_submit.mjs / mail_sweeper.py / driver.py 三处各读各的 env,而且
`LLM_ENDPOINT` 要求填**完整**的 `https://…/v1/chat/completions` —— 但全行业
(OpenAI SDK、LiteLLM、OpenRouter、vLLM、Ollama、Gemini 兼容层)文档里给的都是
**base URL**(`https://…/v1`)。用户照着供应商文档粘 base URL 进来,请求会打到
`https://…/v1` 上静默 404,而且要等到跑起来才暴露。

现在:base URL 和完整地址都收,内部归一;配置既可走 env,也可走 llm.json
(与 kit.json / my_site.json 同风格,gitignore)。

## 解析顺序(高 → 低)

1. 本项目 env(推荐):`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_FALLBACKS`
2. 旧 env(仍支持,读到时提示已改名):`LLM_ENDPOINT` / `LLM_KEY`
3. 通用 env(直接吃现成的):`OPENAI_BASE_URL` / `OPENAI_API_KEY`
4. 配置文件 `outreach/llm.json`(`cp llm.example.json llm.json` 后改)
5. 旧位置 `outreach/my_site.json` 的 `llm_endpoint`/`llm_key`/`llm_model`
   —— 这三个字段在 example 里存在很久,但**此前代码从没读过**,填了也不生效;
   现在认它们(并提示迁移到 llm.json),免得有人填了以为配好了
6. 缺省:`https://api.openai.com/v1` + `gpt-4o-mini`

## base URL 归一(四种写法都认)

    https://x.com                       → https://x.com/v1/chat/completions
    https://x.com/v1                    → https://x.com/v1/chat/completions
    https://x.com/v1/                   → https://x.com/v1/chat/completions
    https://x.com/v1/chat/completions   → 原样(已经是完整地址)
    https://x.com/v1beta                → https://x.com/v1beta/chat/completions
    带 ?query 的(Azure 部署式地址)     → 原样,不猜

用法:
    from llm_config import load
    cfg = load()          # {url, key, models, sources, warnings}
"""
import ipaddress
import json
import os
import re
import urllib.request
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
def _resolve_path(env_name, default_name):
    """env 指定的配置文件路径。空串=未设(否则 py 得到 '' 而 node 的 || 会落到默认,
    两边分叉);相对路径锚到 outreach/ 而不是 cwd(mail_sweeper 与 agent_submit 的
    工作目录不同,锚 cwd 会让两者读到不同文件)。"""
    v = (os.environ.get(env_name) or "").strip()
    if not v:
        return os.path.join(HERE, default_name)
    return v if os.path.isabs(v) else os.path.join(HERE, v)


CONFIG_FILE = _resolve_path("LLM_CONFIG", "llm.json")

DEFAULT_BASE = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini"


def chat_url(base):
    """base URL 或完整地址 → 可直接 POST 的 chat/completions 地址。空进空出。"""
    u = (base or "").strip().rstrip("/")
    if not u:
        return ""
    if "?" in u:                                  # Azure 部署式带 api-version,不动
        return u
    if u.endswith("/chat/completions"):
        return u
    if re.search(r"/v\d+[a-z]*$", u):             # 已经指到 /v1、/v1beta 这层
        return u + "/chat/completions"
    return u + "/v1/chat/completions"             # 只给了根域


def mask(key):
    """日志/界面里显示用:sk-abc…wxyz,永远不回显完整 key。"""
    k = (key or "").strip()
    if not k:
        return "(未配置)"
    return k[:6] + "…" + k[-4:] if len(k) > 14 else k[:2] + "…"


def _warn_perms(path):
    """密钥文件权限过宽就吵一声。`cp llm.example.json llm.json` 默认给 0644,
    同机其他用户可读 —— configure.py 写的是 0600,手工 cp 的没人管。"""
    try:
        import stat
        mode = stat.S_IMODE(os.stat(path).st_mode)
        if mode & 0o077:
            print(f"[llm_config] ⚠️ {path} 权限 {oct(mode)} 过宽(含 API key),"
                  f"建议 chmod 600 {path}", file=__import__("sys").stderr)
    except Exception:
        pass


def _file_cfg():
    try:
        with open(CONFIG_FILE) as f:
            c = json.load(f)
        if isinstance(c, dict) and str(c.get("api_key") or "").strip():
            _warn_perms(CONFIG_FILE)
        return c if isinstance(c, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        # 配置文件存在但坏了要响亮 —— 静默回落到默认端点比报错更难查
        raise RuntimeError(f"{CONFIG_FILE} 解析失败({e});修好它或删掉改用环境变量")


def _env(name):
    return (os.environ.get(name) or "").strip()


MY_SITE = _resolve_path("OUTREACH_MY_SITE", "my_site.json")


def _legacy_site_cfg():
    """my_site.json 里的旧 LLM 字段(历史遗留,优先级最低)。读不到就空。"""
    try:
        with open(MY_SITE) as f:
            c = json.load(f)
        return c if isinstance(c, dict) else {}
    except Exception:
        return {}


def _units():
    """配置来源单元,优先级高→低。**base 与 key 必须成对来自同一个单元** ——
    按字段各自降级会造成"A 供应商的 key 发给 B 供应商的地址"(Codex 复现)。
    每个单元要么给出自己的 base+key,要么整体让位。"""
    fc = _file_cfg()
    sc = _legacy_site_cfg()
    return [
        {"name": "env LLM_BASE_URL/LLM_API_KEY", "base": _env("LLM_BASE_URL"),
         "key": _env("LLM_API_KEY"), "model": _env("LLM_MODEL"), "fallbacks": None},
        {"name": "env LLM_ENDPOINT/LLM_KEY(旧名)", "base": _env("LLM_ENDPOINT"),
         "key": _env("LLM_KEY"), "model": "", "fallbacks": None, "legacy_env": True},
        {"name": "env OPENAI_BASE_URL/OPENAI_API_KEY", "base": _env("OPENAI_BASE_URL"),
         "key": _env("OPENAI_API_KEY"), "model": "", "fallbacks": None},
        {"name": CONFIG_FILE, "base": str(fc.get("base_url") or "").strip(),
         "key": str(fc.get("api_key") or "").strip(),
         "model": str(fc.get("model") or "").strip(),
         "fallbacks": fc.get("fallbacks") if isinstance(fc.get("fallbacks"), list) else None},
        {"name": MY_SITE + "(旧字段)", "base": str(sc.get("llm_endpoint") or "").strip(),
         "key": str(sc.get("llm_key") or "").strip(),
         "model": str(sc.get("llm_model") or "").strip(), "fallbacks": None,
         "legacy_site": True},
    ]


def _origin(u):
    from urllib.parse import urlparse
    p = urlparse(chat_url(u))
    return (p.scheme, p.netloc)


def load():
    """返回 {url, key, models, sources, warnings}。不校验连通性(那是 check_llm.py 的活)。

    **base 与 key 同源绑定**:选出第一个带 key 的单元,base 取它自己的;
    别的单元若指了一个不同 origin 的 base,配置就是有歧义的 —— 直接抛错,不猜。
    (LLM_ALLOW_SPLIT_CONFIG=1 可放行旧的按字段降级行为,自担风险。)
    """
    units = _units()
    warnings, sources = [], {}
    allow_split = bool(_env("LLM_ALLOW_SPLIT_CONFIG"))

    winner = next((u for u in units if u["key"]), None)
    if winner is None:
        # 没有任何 key:base 仍按字段取第一个有值的,好让报错信息能说清当前指向哪
        based = next((u for u in units if u["base"]), None)
        base = based["base"] if based else DEFAULT_BASE
        sources["base"] = based["name"] if based else "缺省"
        sources["key"] = "(未配置)"
        key = ""
    else:
        key = winner["key"]
        sources["key"] = winner["name"]
        base = winner["base"] or DEFAULT_BASE
        sources["base"] = winner["name"] if winner["base"] else f"缺省(跟随 {winner['name']} 的 key)"
        # 歧义检测:别的单元指了不同 origin 的 base
        chosen = _origin(base)
        for u in units:
            if u is winner or not u["base"]:
                continue
            if _origin(u["base"]) != chosen:
                msg = (f"LLM 配置有歧义,拒绝猜:\n"
                       f"  key 来自 {winner['name']},对应地址 {chat_url(base)}\n"
                       f"  但 {u['name']} 指定了另一个地址 {chat_url(u['base'])}\n"
                       f"把 base_url 和 api_key 放在同一处(同一组环境变量、或同一个 llm.json),"
                       f"别一半在 env 一半在文件 —— 否则会把一个供应商的 key 发给另一个供应商。\n"
                       f"确实要这么配就设 LLM_ALLOW_SPLIT_CONFIG=1。")
                if not allow_split:
                    raise RuntimeError(msg)
                warnings.append("已放行 split 配置(LLM_ALLOW_SPLIT_CONFIG=1):"
                                f"key 来自 {winner['name']},地址来自 {u['name']} —— key 会发给后者")
                base = u["base"]
                sources["base"] = u["name"]
                break

    for u in units:
        if u.get("legacy_env") and (u["base"] or u["key"]):
            warnings.append("LLM_ENDPOINT/LLM_KEY 已改名为 LLM_BASE_URL/LLM_API_KEY(仍然可用);"
                            "新名字收 base URL,不必再写 /chat/completions")
        if u.get("legacy_site") and (u["base"] or u["key"] or u["model"]):
            warnings.append("my_site.json 里的 llm_endpoint/llm_key/llm_model 是旧位置"
                            "(此前根本没被读过);已认下,但建议搬到 llm.json 或环境变量")

    # ---- 模型(主 + 降级链):可以跨源,模型名不是凭据 ----
    model = next((u["model"] for u in units if u["model"]), "") or DEFAULT_MODEL
    msrc = next((u["name"] for u in units if u["model"]), "缺省")
    sources["model"] = msrc
    raw_fb = _env("LLM_FALLBACKS")
    if raw_fb:
        fallbacks = [m.strip() for m in raw_fb.split(",") if m.strip()]
    else:
        fb = next((u["fallbacks"] for u in units if u["fallbacks"]), None) or []
        fallbacks = [str(m).strip() for m in fb if str(m).strip()]

    models, seen = [], set()
    for m in [model] + fallbacks:                 # 主模型在前,去重保序
        if m and m not in seen:
            seen.add(m)
            models.append(m)

    return {"url": chat_url(base), "base_url": base, "key": key,
            "models": models, "sources": sources, "warnings": warnings}


class _NoCrossOriginAuthRedirect(urllib.request.HTTPRedirectHandler):
    """跟随重定向时,跨 origin 就把 Authorization 摘掉。

    urllib 默认把原请求的自定义头**原样带到重定向目标**(它只丢 Content-*),
    于是对方一个 302 就能把 API key 引到别的域 —— 对 LLM 端点来说这是明确的凭据外泄面。
    同源(scheme+host+port 全同)才继续带;否则摘掉,调用方拿到 401 也远好过泄 key。
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        a, b = urlparse(req.full_url), urlparse(newurl)
        if (a.scheme, a.hostname, a.port) != (b.scheme, b.hostname, b.port):
            for h in [h for h in new.headers if h.lower() == "authorization"]:
                del new.headers[h]
            new.unredirected_hdrs.pop("Authorization", None)
        return new


def _is_loopback(host):
    h = (host or "").lower().strip("[]")
    if h == "localhost":
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def urlopen(req, timeout=45):
    """发请求。两条约束:

    1. **本机地址绕开代理** —— 国内环境普遍设了 http_proxy,而 urllib 默认连
       127.0.0.1 也往代理里塞,于是「本机 Ollama / vLLM」必然探测失败(代理回 503,
       错误信息还完全看不出是代理干的)。远端端点照旧走代理。
    2. **跨 origin 重定向摘 Authorization**(见 _NoCrossOriginAuthRedirect)。

    JS 侧 agent_submit 用 Node fetch:它默认不认 http_proxy,且不会跨 origin 转发
    Authorization —— 所以这两条对齐之后,两边对本机端点的行为才一致。
    """
    url = req.full_url if hasattr(req, "full_url") else str(req)
    handlers = [_NoCrossOriginAuthRedirect()]
    if _is_loopback(urlparse(url).hostname):
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers).open(req, timeout=timeout)


def require_llm(purpose="LLM"):
    """要 key 的调用方用这个(JS 侧同名函数是 requireLlm):缺 key 直接给出人话指引,不让它跑到一半才炸。"""
    cfg = load()
    if not cfg["key"]:
        raise RuntimeError(
            f"{purpose} 缺 API key。三选一:\n"
            f"  export LLM_API_KEY=...(配合 LLM_BASE_URL / LLM_MODEL)\n"
            f"  export OPENAI_API_KEY=...(直接吃现成的)\n"
            f"  cp llm.example.json llm.json 后填进去\n"
            f"当前端点 {cfg['url']},模型 {'/'.join(cfg['models'])}")
    return cfg


if __name__ == "__main__":                        # python3 llm_config.py 看解析结果
    c = load()
    print(f"端点  {c['url']}\n         (来源:{c['sources']['base']})")
    print(f"key   {mask(c['key'])}\n         (来源:{c['sources']['key']})")
    print(f"模型  {' → '.join(c['models'])}\n         (主模型来源:{c['sources']['model']})")
    for w in c["warnings"]:
        print(f"提示  {w}")
