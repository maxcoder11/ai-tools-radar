#!/usr/bin/env python3
"""submit.py — 半自动外链投放器(开源版,剥离私有基建)。

从 backlinks-v2 的 rolling_submit 提炼的核心,去掉私有依赖(ccpa 网关/打码账号/私有代理/DB):
  - 纯规则表单识别(可选接入你自己的 OpenAI 兼容 LLM,默认关)
  - 验证码不硬碰:检测到就进人工队列
  - 每域每天最多一次,状态落 outreach/state.jsonl,断点续跑
  - 只投"给竞品发过 dofollow"的实证页(targets.py 产物)

流程:打开目标页 → 找表单(评论表单/提交表单)→ 填 my_site.json → 提交 → 判结果。
用法:
  pip install playwright && playwright install chromium
  cp my_site.example.json my_site.json   # 填好你的站
  python3 targets.py                     # 生成 worklist.jsonl
  python3 submit.py [--limit 20] [--show]  # --show 有头模式,便于观察
"""
import json
import random
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SITE_CFG = HERE / "my_site.json"
WORKLIST = HERE / "worklist.jsonl"
STATE = HERE / "state.jsonl"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

CAPTCHA_HINTS = ("recaptcha", "hcaptcha", "cf-turnstile", "geetest", "arkose")
SUBMIT_WORDS = ("submit", "post", "send", "提交", "发布", "add", "list my", "sign up", "register")
SUCCESS_WORDS = ("thank", "success", "submitted", "review", "moderation", "approval",
                 "感谢", "成功", "审核", "已提交", "已收到")

# 表单字段启发式:(我们配置里的键, 匹配 input/textarea 的 name/id/placeholder 关键词)
FIELD_MAP = {
    "url": ["url", "website", "site", "link", "homepage", "web"],
    "name": ["name", "title", "tool", "product", "author"],
    "email": ["email", "mail"],
    "description": ["description", "desc", "about", "comment", "message", "text", "body", "bio"],
    "tagline": ["tagline", "slogan", "short"],
}


def load_state():
    st = {}
    if STATE.exists():
        for line in open(STATE):
            try:
                r = json.loads(line)
                st[r["src"]] = r
            except Exception:
                pass
    return st


def save_state(src, status, note=""):
    with open(STATE, "a") as f:
        f.write(json.dumps({"src": src, "status": status, "note": note[:150],
                            "ts": time.strftime("%Y-%m-%d %H:%M:%S")}, ensure_ascii=False) + "\n")


JS_FILL = """
(cfg) => {
  const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea')];
  const filled = [];
  const used = new Set();
  const hay = el => ((el.name||'') + ' ' + (el.id||'') + ' ' + (el.placeholder||'') + ' ' + (el.getAttribute('aria-label')||'')).toLowerCase();
  for (const [key, words] of Object.entries(cfg.FIELD_MAP)) {
    for (const el of inputs) {
      if (used.has(el)) continue;
      const h = hay(el);
      if (!h.trim()) continue;
      if (words.some(w => h.includes(w))) {
        const val = cfg.site[key] || '';
        if (!val) continue;
        if (el.type === 'email' && !val.includes('@')) continue;
        if (el.tagName === 'INPUT' && el.type === 'url' && !val.startsWith('http')) continue;
        el.value = val;
        el.dispatchEvent(new Event('input', {bubbles: true}));
        el.dispatchEvent(new Event('change', {bubbles: true}));
        used.add(el); filled.push(key + '->' + (el.name || el.id || el.placeholder || '?'));
        break;
      }
    }
  }
  // 提交按钮
  const btns = [...document.querySelectorAll('button, input[type=submit], a.btn, [role=button]')];
  const ok = btns.filter(b => {
    const t = ((b.textContent||'') + ' ' + (b.value||'')).toLowerCase();
    return cfg.SUBMIT_WORDS.some(w => t.includes(w));
  });
  const captcha = cfg.CAPTCHA_HINTS.some(c => document.documentElement.innerHTML.toLowerCase().includes(c));
  return { filled: filled, nFields: inputs.length, hasSubmit: ok.length > 0,
           captcha: captcha, title: document.title.slice(0, 80) };
}
"""


def main():
    limit = 20
    show = "--show" in sys.argv
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    site = json.load(open(SITE_CFG))
    if site["url"].endswith("example.com/"):
        sys.exit("先 cp my_site.example.json my_site.json 并填好你的站点信息")
    st = load_state()
    todo = []
    for line in open(WORKLIST):
        r = json.loads(line)
        prev = st.get(r["src"])
        if prev and prev["status"] in ("done", "manual"):
            continue
        if prev and prev["status"] == "failed" and prev.get("note", "").endswith("×3"):
            continue
        todo.append(r)
    todo = todo[:limit]
    print(f"待投 {len(todo)}(库内已有状态 {len(st)})")
    if not todo:
        return

    from playwright.sync_api import sync_playwright
    import os
    cfg = {"site": site, "FIELD_MAP": FIELD_MAP, "SUBMIT_WORDS": SUBMIT_WORDS,
           "CAPTCHA_HINTS": CAPTCHA_HINTS}
    n_done = n_manual = n_fail = 0
    with sync_playwright() as p:
        exe = os.environ.get("CHROME_BIN")  # 可选:指定本机已有浏览器,跳过 playwright install
        browser = p.chromium.launch(headless=not show, args=["--no-sandbox"],
                                    executable_path=exe or None)
        ctx = browser.new_context(user_agent=UA, locale="en-US")
        pg = ctx.new_page()
        for i, t in enumerate(todo, 1):
            src = t["src"]
            try:
                pg.goto(t["url"], timeout=45000, wait_until="domcontentloaded")
                pg.wait_for_timeout(2500)
                info = pg.evaluate(JS_FILL, cfg)
                if info["captcha"]:
                    save_state(src, "manual", "有验证码")
                    n_manual += 1
                    print(f"  [{i}] {src} → 人工(验证码)")
                elif not info["filled"] or not info["hasSubmit"]:
                    prev = st.get(src, {})
                    times = prev.get("note", "").count("×") 
                    note = "无可填表单" + ("×" + str(times + 2) if times else "")
                    save_state(src, "failed", note)
                    n_fail += 1
                    print(f"  [{i}] {src} → 失败(无可填表单)")
                else:
                    # 点提交
                    clicked = pg.evaluate("""(words) => {
                      const btns = [...document.querySelectorAll('button, input[type=submit], a.btn, [role=button]')];
                      const b = btns.find(b => words.some(w => (((b.textContent||'') + ' ' + (b.value||'')).toLowerCase()).includes(w)));
                      if (b) { b.click(); return true; } return false;
                    }""", list(SUBMIT_WORDS))
                    pg.wait_for_timeout(3500)
                    body = pg.content().lower()
                    ok = any(w in body for w in SUCCESS_WORDS)
                    save_state(src, "done" if ok else "done_unverified",
                               f"字段 {','.join(info['filled'])}" + ("" if ok else "(未见成功信号)"))
                    n_done += 1
                    print(f"  [{i}] {src} → 已提交{'✓' if ok else '(未确认)'} [{','.join(info['filled'])}]")
            except Exception as e:
                save_state(src, "failed", str(e)[:80])
                n_fail += 1
                print(f"  [{i}] {src} → 异常 {str(e)[:50]}")
            time.sleep(random.uniform(20, 40))   # 纪律:不连投
        browser.close()
    print(f"== 完:提交 {n_done},人工队列 {n_manual},失败 {n_fail} → {STATE} ==")


if __name__ == "__main__":
    main()
