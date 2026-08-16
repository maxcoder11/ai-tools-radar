#!/usr/bin/env python3
"""mailbot.py — 验证邮件自动处理(开源版,从 backlinks-v2 的 mail_sweeper 提炼)。

去掉私有依赖:不用 agently-cli(ccpa),改用标准 IMAP(stdlib imaplib,零安装);
不用 LLM 网关,验证链接判定走规则(验证链接的结构特征非常稳,不需要语义理解)。
安全闸照抄原版的四条(用户 2026-07-25 指示"不要啥 url 都点"):
  1. 只处理我们投过的域(state.jsonl 里有记录的)
  2. 链接注册域必须等于发件域,且路径含验证关键词
  3. 跳转终点出域即中止;只 GET,限量 200KB
  4. message-id 幂等,不重复处置
配置(my_site.json 里加):
  "imap_host": "imap.gmail.com", "imap_user": "you@gmail.com", "imap_pass": "应用专用密码"
  QQ 邮箱: imap.qq.com + 授权码。任何 IMAP 信箱都行。
用法: python3 mailbot.py [--loop]   # 单跑或常驻
"""
import imaplib
import json
import re
import sys
import time
import urllib.request
from email import message_from_bytes
from email.header import decode_header
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = HERE / "state.jsonl"
SEEN = HERE / "mail_seen.txt"
VERIFY_KW = re.compile(r"verif|confirm|activate|validate|token|approv|验证|确认|激活", re.I)
APPROVE_KW = re.compile(r"approved|accepted|listed|published|已通过|收录|通过审核", re.I)
REJECT_KW = re.compile(r"reject|declin|not approved|未通过|拒绝", re.I)


def load_cfg():
    c = json.load(open(HERE / "my_site.json"))
    for k in ("imap_host", "imap_user", "imap_pass"):
        if not c.get(k):
            sys.exit(f"my_site.json 缺 {k}(IMAP 配置,见 outreach/README.md)")
    return c


def submitted_domains():
    doms = set()
    if STATE.exists():
        for line in open(STATE):
            try:
                r = json.loads(line)
                if r.get("status", "").startswith("done"):
                    doms.add(r["src"])
            except Exception:
                pass
    return doms


def seen_ids():
    return set(SEEN.read_text().split()) if SEEN.exists() else set()


def mark_seen(mid):
    with open(SEEN, "a") as f:
        f.write(mid + "\n")


def reg_dom(host):
    parts = host.lower().split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host.lower()


def text_of(msg):
    out = []
    for part in msg.walk():
        if part.get_content_type() in ("text/plain", "text/html"):
            try:
                out.append(part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace"))
            except Exception:
                pass
    return "\n".join(out)


def click(url):
    """只 GET,限量 200KB,不跟出域跳转。"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    opener = urllib.request.build_opener(NoOffDomainRedirect(url))
    with opener.open(req, timeout=15) as r:
        r.read(200 * 1024)


class NoOffDomainRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, orig):
        self.orig = orig

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if reg_dom(urllib.request.urlparse(newurl).netloc) != reg_dom(urllib.request.urlparse(self.orig).netloc):
            return None           # 出域即中止
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def record(src, status, note):
    with open(STATE, "a") as f:
        f.write(json.dumps({"src": src, "status": status, "note": note[:150],
                            "ts": time.strftime("%Y-%m-%d %H:%M:%S")}, ensure_ascii=False) + "\n")


def sweep():
    cfg = load_cfg()
    targets = submitted_domains()
    seen = seen_ids()
    n_act = 0
    with imaplib.IMAP4_SSL(cfg["imap_host"]) as im:
        im.login(cfg["imap_user"], cfg["imap_pass"])
        im.select("INBOX")
        _, data = im.search(None, "UNSEEN")
        for num in (data[0] or []).split():
            _, msg_data = im.fetch(num, "(RFC822)")
            msg = message_from_bytes(msg_data[0][1])
            mid = msg.get("Message-ID", "") or f"num-{num.decode()}"
            if mid in seen:
                continue
            mark_seen(mid)
            sender = msg.get("From", "")
            sender_host = re.search(r"@([\w.\-]+)", sender)
            sdom = reg_dom(sender_host.group(1)) if sender_host else ""
            if sdom not in targets:
                continue                       # 闸 1:只处理投过的站
            body = text_of(msg)
            subj = str(decode_header(msg.get("Subject", "") or "")[0][0])
            # 验证链接:注册域==发件域 + 路径含验证词(闸 2)
            links = re.findall(r'https?://[^\s<>"\'()]+', body)
            verified = False
            for u in links:
                host = urllib.request.urlparse(u).netloc
                if reg_dom(host) == sdom and VERIFY_KW.search(u):
                    try:
                        click(u)
                        record(sdom, "email_verified", f"点了验证链接:{u[:80]}")
                        print(f"  ✓ {sdom} 验证链接已点")
                        verified = True
                        n_act += 1
                        break
                    except Exception as e:
                        record(sdom, "verify_failed", str(e)[:100])
            if verified:
                continue
            # 规则分类(收录通过/拒绝),仅记录,动作另说
            text = subj + " " + body[:2000]
            if APPROVE_KW.search(text):
                record(sdom, "approved", subj[:80])
                print(f"  ★ {sdom} 收录通过:{subj[:50]}")
                n_act += 1
            elif REJECT_KW.search(text):
                record(sdom, "rejected", subj[:80])
                print(f"  ✗ {sdom} 被拒:{subj[:50]}")
    return n_act


def main():
    loop = "--loop" in sys.argv
    while True:
        try:
            n = sweep()
            print(f"[{time.strftime('%H:%M:%S')}] 本轮处置 {n} 封", flush=True)
        except Exception as e:
            print(f"扫信异常:{str(e)[:100]}", flush=True)
        if not loop:
            break
        time.sleep(300 if n == 0 else 30)   # 没事 5 分钟一轮,有活 30 秒


if __name__ == "__main__":
    main()
