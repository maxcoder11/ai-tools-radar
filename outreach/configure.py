#!/usr/bin/env python3
"""configure.py — 本机配置界面(LLM 端点 + 打码/收信凭据)。

    python3 configure.py            # 起在 127.0.0.1:8790,终端会打印带 token 的地址
    python3 configure.py --port 9001
    python3 configure.py --no-open  # 不自动开浏览器

管两个文件:
  llm.json      base_url / api_key / model / fallbacks   —— 解析规则见 llm_config.py
  my_site.json  capsolver_key / twocaptcha_key / agentmail_api_key / agentmail_inbox_id

## 为什么不做进公开站(index.html)

index.html 是要发 GitHub Pages 的**纯静态公开站**:浏览器写不了本地文件,Python/Node
也读不了 localStorage —— 技术上就做不成。更要紧的是,在一个公开域名的页面上放 API key
输入框本身就是坏模式(不管本意如何,用户会往里粘真 key)。所以配置界面只存在于本机,
由这个脚本临时起,关掉终端就没了。

## 安全边界(都是必须的,别为了省事去掉)

1. **只绑 127.0.0.1**,永不 0.0.0.0 —— 否则同网段任何人都能读写你的 key;
2. **一次性 token**:每次启动随机生成,所有请求都要带。防的是"你浏览器里另开的
   恶意页面对着 localhost 发请求"(经典的本地服务 CSRF);
3. **Host 头必须是环回地址** —— 防 DNS 重绑定(攻击者把 evil.com 解析到 127.0.0.1,
   浏览器就会带着 Host: evil.com 打进来);
4. **Origin 跨源即拒**;
5. **key 只出不进**:读接口永远只回掩码(sk-ab…yz),真值不出本进程;
   页面留空 = 不修改,不会把已有 key 冲成空;
6. 写文件 **0600**,并且**保留界面不认识的字段**(如 my_site.json 里的 agentmail
   webhook 块)—— 配置界面不该把它没显示的东西删掉;
7. 页面自包含,零外部资源 —— 不给任何第三方发 Referer(那上面带着 token)。
"""
import argparse
import http.server
import json
import os
import secrets
import socketserver
import sys
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_config  # noqa: E402
import check_llm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MY_SITE = llm_config.MY_SITE          # 同一份路径(env OUTREACH_MY_SITE 可覆盖)
DEFAULT_BASE = llm_config.DEFAULT_BASE   # 旧配置 base 为空时运行期就回落到它
TOKEN = secrets.token_urlsafe(12)
PORT = 8790

PRESETS = [
    ("OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"),
    ("OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini"),
    ("DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"),
    ("硅基流动", "https://api.siliconflow.cn/v1", "Qwen/Qwen2.5-7B-Instruct"),
    ("本机 Ollama", "http://127.0.0.1:11434/v1", "qwen2.5"),
    ("本机 vLLM", "http://127.0.0.1:8000/v1", ""),
    ("自定义", "", ""),
]

SECRET_FIELDS = ("capsolver_key", "twocaptcha_key", "agentmail_api_key")


def _read(path):
    try:
        with open(path) as f:
            c = json.load(f)
        return c if isinstance(c, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        raise RuntimeError(f"{os.path.basename(path)} 解析失败({e}),先修好再配")


def _write(path, obj):
    """原子写 + 0600。含 key,不给同组/其他人读。"""
    tmp = f"{path}.tmp.{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _origin(u):
    """复用 llm_config.origin_of —— 同源判定全仓只能有一份实现,
    否则 configure 与 llm_config 会对同一组配置给出相反结论。
    歧义写法(反斜杠/userinfo 等)会抛 AmbiguousUrl,调用方转成人话拒绝。"""
    return llm_config.origin_of(u)


def _keep(old, new_val):
    """页面留空 = 不修改(不会把已有 key 冲成空)。"""
    v = (new_val or "").strip()
    return v if v else (old or "")


def state():
    """给页面的当前状态。**key 一律只回掩码**。"""
    cfg = llm_config.load()
    site = _read(MY_SITE)
    llm_file = _read(llm_config.CONFIG_FILE)
    return {
        "llm": {
            "base_url": cfg["base_url"],
            "model": cfg["models"][0] if cfg["models"] else "",
            "fallbacks": ", ".join(cfg["models"][1:]),
            "key_masked": llm_config.mask(cfg["key"]),
            "key_set": bool(cfg["key"]),
            "url": cfg["url"],
            "sources": cfg["sources"],
            "warnings": cfg["warnings"],
            # env 里配了的话,写文件也白搭(env 优先)—— 页面要如实说
            "env_wins": cfg["sources"]["base"].startswith("env") or cfg["sources"]["key"].startswith("env"),
            "file_has": bool(llm_file),
        },
        "site": {
            k: {"masked": llm_config.mask(site.get(k, "")), "set": bool(str(site.get(k) or "").strip())}
            for k in SECRET_FIELDS
        },
        "inbox_id": str(site.get("agentmail_inbox_id") or ""),   # 不是密钥,可明文回显
        "files": {"llm": llm_config.CONFIG_FILE, "site": MY_SITE},
    }


def save(body):
    written = []
    if body.get("section") in (None, "llm"):
        cur = _read(llm_config.CONFIG_FILE)
        # 【安全】换了 endpoint 就必须重填 key。原来 _keep() 会把**上一个供应商的 key**
        # 原样留给新地址 —— 下一次请求就把 A 的 key 发给 B(Codex P1)。
        new_base = (body.get("base_url") or "").strip()
        typed = (body.get("api_key") or "").strip()
        # 【二修】base_url 留空曾能绕过这道闸:`and new_base` 直接短路 → 不拦 → 写进空
        # base → load() 回落到默认 OpenAI,把上一个供应商的 key 发过去(两个方向都复现过)。
        # 现在:空 base 直接拒(它本来就不是合法配置),再比 origin。
        if not new_base:
            return {"ok": False, "error": "Base URL 不能为空 —— 留空会回落到默认 OpenAI 地址,"
                                          "把已保存的 key 发过去。填供应商文档给的 base URL。"}
        # 【修】要比的是**运行期实际生效的**旧 endpoint,不是文件里的原始字符串:
        # 旧 llm.json 只有 api_key、base_url 为空时,load() 会回落到默认 OpenAI ——
        # 而这里读到空字符串就跳过了换源检查,旧 key 被留给新 endpoint(已复现)。
        has_old_key = bool(str(cur.get("api_key") or "").strip())
        old_base = (str(cur.get("base_url") or "").strip() or DEFAULT_BASE) if has_old_key else ""
        if old_base and not typed and _origin(new_base) != _origin(old_base):
            return {"ok": False, "error":
                    f"换了 endpoint({_origin(old_base)[1]} → {_origin(new_base)[1]})就必须重填 API Key。"
                    f"留空 = 沿用旧 key,那会把上一个供应商的 key 发给新地址。"}
        fb, seen = [], set()                       # 去重保序,别把重复模型写进文件
        for m in (body.get("fallbacks") or "").split(","):
            m = m.strip()
            if m and m not in seen:
                seen.add(m)
                fb.append(m)
        cur.update({
            "base_url": (body.get("base_url") or "").strip(),
            "api_key": _keep(cur.get("api_key"), body.get("api_key")),
            "model": (body.get("model") or "").strip(),
            "fallbacks": fb,
        })
        _write(llm_config.CONFIG_FILE, cur)
        written.append(os.path.basename(llm_config.CONFIG_FILE))
    if body.get("section") in (None, "site"):
        cur = _read(MY_SITE)                       # 读改写:保留界面不认识的字段
        for k in SECRET_FIELDS:
            v = _keep(cur.get(k), body.get(k))
            if v:
                cur[k] = v
        cur["agentmail_inbox_id"] = (body.get("agentmail_inbox_id") or "").strip()
        _write(MY_SITE, cur)
        written.append(os.path.basename(MY_SITE))
    return {"ok": True, "written": written, "state": state()}


def test(body):
    """实测端点。页面没填 key 就用已存的(掩码不回传,真值不出进程)。

    ⚠️ 【凭据外泄闸,别删】页面能自由指定 base_url,而"key 留空 = 用已存的真 key"
    —— 两者相加,一个「改 base_url + key 留空」的请求就能让本服务把用户的真 key
    发到任意地址(实测可复现)。token/Host/Origin 三道闸只是把门槛提到"先拿到 token",
    不构成纵深防御。所以:**已存的 key 只发给已存的那个主机**;换了地址就必须
    在页面上重新填一次 key(那是用户自己刚敲进去的,他知道要发给谁)。
    与 JS 侧 outbound_guard.mjs 同一类闸,只是这里防的是 key 出域而不是 SSRF。
    """
    from urllib.parse import urlparse
    cfg = llm_config.load()
    base = (body.get("base_url") or "").strip() or cfg["base_url"]
    url = llm_config.chat_url(base)
    sp = urlparse(url)
    if sp.scheme not in ("http", "https"):
        return {"ok": False, "verdict": "地址不合法", "detail": f"只支持 http/https,收到 {url[:60]}"}

    typed = (body.get("api_key") or "").strip()
    if typed:
        key = typed                                   # 用户当场敲的,发给他自己填的地址
    else:
        if not cfg["key"]:
            return {"ok": False, "verdict": "缺 key", "detail": "先填 API Key,或先保存一次"}
        saved, target = _origin(cfg["base_url"]), _origin(base)
        if saved != target:
            # 只比 netloc 会放过 https→http:同主机、明文发 key。这里比整个 origin。
            return {"ok": False, "verdict": "换了地址,需重填 key",
                    "detail": f"目标 {target[0]}://{target[1]}:{target[2]} 与已保存的 "
                              f"{saved[0]}://{saved[1]}:{saved[2]} 不是同一个 origin"
                              f"(scheme/host/port 任一不同都算)。"
                              f"为防止把已保存的 key 发到别处,请在上面重新填一次 API Key 再测。"}
        key = cfg["key"]

    model = (body.get("model") or "").strip() or (cfg["models"] or [""])[0]
    ok, verdict, detail = check_llm.probe(url, key, model)
    return {"ok": ok, "verdict": verdict, "detail": detail, "url": url}


PAGE = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>outreach 配置</title><meta name="referrer" content="no-referrer">
<style>
:root{--ink:#111827;--mut:#6b7280;--line:#e5e7eb;--bg:#f8fafc;--acc:#2563eb;--good:#047857;--bad:#b91c1c}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,"PingFang SC","Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:660px;margin:28px auto 60px;padding:0 18px}
h1{font-size:19px;margin:0 0 4px}
.sub{color:var(--mut);font-size:12.5px;margin-bottom:20px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 3px}
.card .hint{color:var(--mut);font-size:12px;margin-bottom:14px}
label{display:block;font-size:12px;color:var(--mut);margin:12px 0 4px;font-weight:600}
input,select{width:100%;padding:8px 11px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;background:#fff}
input:focus,select:focus{outline:none;border-color:var(--acc)}
.row{display:flex;gap:12px}.row>div{flex:1}
.btns{margin-top:18px;display:flex;gap:9px;align-items:center;flex-wrap:wrap}
button{border:1px solid var(--acc);background:var(--acc);color:#fff;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;font-family:inherit}
button.ghost{background:#fff;color:var(--acc)}
button:disabled{opacity:.5;cursor:default}
.msg{font-size:12.5px;margin-top:12px;padding:9px 12px;border-radius:8px;display:none;white-space:pre-wrap;word-break:break-word}
.msg.ok{display:block;background:#ecfdf5;color:var(--good);border:1px solid #a7f3d0}
.msg.err{display:block;background:#fef2f2;color:var(--bad);border:1px solid #fecaca}
.msg.info{display:block;background:#f8fafc;color:var(--mut);border:1px solid var(--line)}
code{background:var(--bg);padding:1px 6px;border-radius:5px;font-size:12px}
.set{color:var(--good);font-size:11.5px}.unset{color:var(--mut);font-size:11.5px}
.warn{background:#fffbeb;color:#b45309;border:1px solid #fde68a;border-radius:8px;padding:9px 12px;font-size:12.5px;margin-bottom:14px}
footer{color:var(--mut);font-size:11.5px;text-align:center;margin-top:26px;line-height:1.8}
</style></head><body><main>
<h1>outreach 配置</h1>
<div class="sub">只跑在本机,关掉终端即停。填完的值写进 <code>outreach/</code> 下的配置文件(权限 0600,均已 gitignore)。</div>
<div id="envwarn" class="warn" style="display:none"></div>

<div class="card">
  <h2>LLM 端点</h2>
  <div class="hint">提交代理每一步决策、邮件意图判定都用它。<b>模型必须支持 <code>response_format: json_object</code></b> —— 点「测试连接」会实测这一项。</div>
  <label>服务商预设</label>
  <select id="preset"></select>
  <label>Base URL <span class="unset">填供应商文档给的 base URL 即可,不用自己拼 /chat/completions</span></label>
  <input id="base_url" placeholder="https://api.openai.com/v1" spellcheck="false">
  <label>API Key <span id="keystate"></span></label>
  <input id="api_key" type="password" placeholder="留空 = 不修改" autocomplete="off" spellcheck="false">
  <div class="row">
    <div><label>模型</label><input id="model" placeholder="gpt-4o-mini" spellcheck="false"></div>
    <div><label>降级链(逗号分隔,可空)</label><input id="fallbacks" placeholder="只放实测可用的" spellcheck="false"></div>
  </div>
  <div class="btns">
    <button class="ghost" onclick="doTest()">测试连接</button>
    <button onclick="save('llm')">保存到 llm.json</button>
    <span id="posturl" class="unset"></span>
  </div>
  <div id="m_llm" class="msg"></div>
</div>

<div class="card">
  <h2>打码与收信(可选)</h2>
  <div class="hint">没配打码 key → 验证码站标 <code>manual</code> 进人工队列,不硬刚。AgentMail 是两条收信腿之一(另一条 agently-cli 不在这里配)。</div>
  <label>CapSolver Key <span id="s_capsolver_key"></span></label>
  <input id="capsolver_key" type="password" placeholder="留空 = 不修改" autocomplete="off" spellcheck="false">
  <label>2Captcha Key <span id="s_twocaptcha_key"></span> <span class="unset">—— 目前只作 CapSolver 的降级通道,不能单独用</span></label>
  <input id="twocaptcha_key" type="password" placeholder="留空 = 不修改" autocomplete="off" spellcheck="false">
  <div class="row">
    <div><label>AgentMail API Key <span id="s_agentmail_api_key"></span></label>
      <input id="agentmail_api_key" type="password" placeholder="留空 = 不修改" autocomplete="off" spellcheck="false"></div>
    <div><label>AgentMail Inbox ID</label>
      <input id="agentmail_inbox_id" placeholder="收件箱地址/ID" spellcheck="false"></div>
  </div>
  <div class="btns"><button onclick="save('site')">保存到 my_site.json</button></div>
  <div id="m_site" class="msg"></div>
</div>

<footer>配完关掉终端即可 · 命令行等价物:<code>python3 check_llm.py</code>(实测端点)</footer>
</main><script>
const PRESETS = __PRESETS__;
const T = new URLSearchParams(location.search).get('t') || '';
const $ = i => document.getElementById(i);
const api = (p, b) => fetch(p + '?t=' + encodeURIComponent(T), {
  method: b ? 'POST' : 'GET', headers: {'Content-Type': 'application/json'},
  body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
function show(id, cls, txt){ const e = $(id); e.className = 'msg ' + cls; e.textContent = txt; }
function llmBody(){ return { base_url: $('base_url').value, api_key: $('api_key').value,
  model: $('model').value, fallbacks: $('fallbacks').value }; }

PRESETS.forEach((p, i) => $('preset').add(new Option(p[0], i)));
$('preset').onchange = () => { const p = PRESETS[+$('preset').value];
  if (p[1]) $('base_url').value = p[1]; if (p[2]) $('model').value = p[2]; };

function render(s){
  // 【修】初始配置有错时 /api/state 返回 {error},原来直接解引用 s.llm → TypeError → 白屏,
  // 用户看不到任何修复指引。先把错误显示出来。
  if (!s || s.error || !s.llm) {
    $('envwarn').style.display = 'block';
    $('envwarn').textContent = '读取当前配置失败:' + ((s && s.error) || '未知错误')
      + '\n先修好配置文件(或删掉它改用环境变量),再刷新本页。';
    return;
  }
  $('base_url').value = s.llm.base_url; $('model').value = s.llm.model;
  // 预设下拉跟当前值对齐:对不上任何预设就落到「自定义」,别显示一个骗人的服务商名
  const hit = PRESETS.findIndex(p => p[1] && p[1] === s.llm.base_url);
  $('preset').value = hit >= 0 ? hit : PRESETS.length - 1;
  $('fallbacks').value = s.llm.fallbacks;
  $('keystate').className = s.llm.key_set ? 'set' : 'unset';
  $('keystate').textContent = s.llm.key_set ? '已配置 ' + s.llm.key_masked : '未配置';
  $('posturl').textContent = '实际 POST → ' + s.llm.url;
  $('agentmail_inbox_id').value = s.inbox_id || '';
  for (const k in s.site){ const e = $('s_' + k); if(!e) continue;
    e.className = s.site[k].set ? 'set' : 'unset';
    e.textContent = s.site[k].set ? '已配置 ' + s.site[k].masked : '未配置'; }
  const w = [...(s.llm.warnings || [])];
  if (s.llm.env_wins) w.push('检测到环境变量里也配了 LLM —— **环境变量优先于配置文件**,'
    + '这里保存的值会被它盖住。要用界面里这份,先 unset 掉那些变量。');
  $('envwarn').style.display = w.length ? 'block' : 'none';
  $('envwarn').textContent = w.join('\\n');
}
function doTest(){
  show('m_llm', 'info', '正在实测…');
  api('/api/test', llmBody()).then(r => show('m_llm', r.ok ? 'ok' : 'err',
    (r.ok ? '✅ ' : '❌ ') + r.verdict + '\\n' + (r.detail || '')));
}
function save(sec){
  const b = sec === 'llm' ? llmBody() : { capsolver_key: $('capsolver_key').value,
    twocaptcha_key: $('twocaptcha_key').value, agentmail_api_key: $('agentmail_api_key').value,
    agentmail_inbox_id: $('agentmail_inbox_id').value };
  b.section = sec;
  api('/api/save', b).then(r => {
    if (!r.ok) return show('m_' + sec, 'err', r.error || '保存失败');
    ['api_key','capsolver_key','twocaptcha_key','agentmail_api_key'].forEach(i => $(i).value = '');
    render(r.state);
    show('m_' + sec, 'ok', '已写入 ' + r.written.join('、') + '(权限 0600)');
  });
}
api('/api/state').then(render);
</script></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "outreach-configure"

    def log_message(self, *a):
        pass

    # ---------- 闸 ----------
    def _authed(self):
        """token + Host 环回 + Origin 同源。三条缺一不可,见文件头。"""
        from urllib.parse import urlparse, parse_qs
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost", "[::1]", "::1"):
            return False, "Host 不是环回地址(疑似 DNS 重绑定),拒绝"
        origin = self.headers.get("Origin")
        if origin:
            oh = urlparse(origin).hostname
            if oh not in ("127.0.0.1", "localhost", "::1"):
                return False, "跨源请求,拒绝"
        tok = parse_qs(urlparse(self.path).query).get("t", [""])[0]
        if not secrets.compare_digest(tok, TOKEN):
            return False, "token 不对。用终端里打印的那个完整地址打开"
        return True, ""

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        b = body if isinstance(body, bytes) else str(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(b)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode())

    # ---------- 路由 ----------
    def do_GET(self):
        ok, why = self._authed()
        if not ok:
            return self._send(403, why, "text/plain; charset=utf-8")
        path = self.path.split("?")[0]
        if path == "/":
            page = PAGE.replace("__PRESETS__", json.dumps(PRESETS, ensure_ascii=False))
            return self._send(200, page.encode(), "text/html; charset=utf-8")
        if path == "/api/state":
            try:
                return self._json(200, state())
            except RuntimeError as e:
                return self._json(200, {"error": str(e)})
        self._send(404, "not found", "text/plain")

    def do_POST(self):
        ok, why = self._authed()
        if not ok:
            return self._send(403, why, "text/plain; charset=utf-8")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._json(400, {"ok": False, "error": f"请求体解析失败:{e}"})
        path = self.path.split("?")[0]
        try:
            if path == "/api/save":
                return self._json(200, save(body))
            if path == "/api/test":
                return self._json(200, test(body))
        except Exception as e:
            return self._json(200, {"ok": False, "verdict": "配置服务出错",
                                    "error": f"{type(e).__name__}: {e}", "detail": f"{type(e).__name__}: {e}"})
        self._send(404, "not found", "text/plain")


def main():
    global PORT
    ap = argparse.ArgumentParser(description="outreach 本机配置界面")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    PORT = a.port
    url = f"http://127.0.0.1:{PORT}/?t={TOKEN}"

    class S(socketserver.TCPServer):
        allow_reuse_address = True

    # 只绑 127.0.0.1 —— 绑 0.0.0.0 等于把 key 读写接口挂到整个网段上
    try:
        srv = S(("127.0.0.1", PORT), Handler)
    except OSError as e:
        sys.exit(f"起不来({e})。换个端口:python3 configure.py --port 9001")
    print(f"  配置界面 → {url}")
    print(f"  (只监听 127.0.0.1;token 每次启动重新生成;Ctrl-C 或关终端即停)")
    if not a.no_open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")


if __name__ == "__main__":
    main()
