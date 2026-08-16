#!/usr/bin/env python3
"""read_otp.py — 从 IMAP 信箱里取某个站的验证码/验证链接,给投放 agent 用。

2026-08-16 开源移植版(生产:backlinks-v2/scripts/read_otp.py)。

## 为什么不在 JS 里再写一遍

信箱访问只应该有一份实现。mail_sweeper 已经把 IMAP 连接、字段兼容、
message_id 幂等这些坑都踩平了,再抄一份 JS 版必然分叉。
这里直接复用它的 list_msgs()/read_msg()。

## 匹配规则跟着 mail_sweeper 走

宽松匹配会让 agent 把别人的验证码填进表单:发件域匹配为主,
主题匹配要求完整根域出现(对 ai.tools 不会退化成 "ai")。

## 用法

    python3 read_otp.py --domain example.com
    → 打印 VERIFY_LINK:https://... 或 OTP:123456,exit 0
    → 没找到 exit 2(调用方据此提示 agent"还没到")

只读不处置:不点链接、不改任何状态。点链接是 mail_sweeper 的活,它那条路上有
逐跳校验、同域校验、ESP 白名单三道闸,这里一道都不重复实现,也就一道都不会绕过。
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mail_sweeper as ms  # noqa: E402
from rootdomain import root_domain  # noqa: E402

# 验证类链接的判据跟 mail_sweeper 的 ACTION_PATH_RE 保持一致
VERIFY_HINT = re.compile(r"verif|confirm|activate|激活|验证|認証", re.I)
CODE = re.compile(r"\b(\d{4,8})\b")
URL = re.compile(r"https?://[^\s\"')\]<>]+")


def _matches(dom_root, frm, subj):
    """这封信是不是这个站发来的。**宽松匹配会让 agent 把别人的验证码填进表单**。"""
    frm = (frm or "").lower()
    subj = (subj or "").lower()
    return dom_root in frm or dom_root in subj


def _epoch(s):
    """邮件 Date 头/ISO 时间串 → epoch 秒;解析不了当 0(永不通过 since 过滤)。"""
    s = (s or "").strip()
    if not s:
        return 0.0
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(s).timestamp()
    except Exception:
        pass
    try:
        from datetime import datetime
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def find_otp(dom, limit=25, since=None):
    """返回 (结果字符串, 是否找到)。

    since(可选,本地时间 'YYYY-MM-DD HH:MM:SS' 或 ISO):只认该时刻之后的来信。
    为什么必须有过滤:同站的旧验证码信会留在箱子里,不过滤时新一次注册可能
    读到**上一次的死码**填进去(生产实证:旧码进新注册,站方回 otp_expired)。
    """
    dom_root = root_domain(dom.replace("www.", "")).lower()
    if not dom_root:
        return f"域名解析不出可注册域:{dom}", False
    since_ts = _epoch(since) if since else 0.0
    msgs = ms.list_msgs(limit)
    hits = [m for m in msgs
            if _matches(dom_root, m.get("from", ""), m.get("subject", ""))
            and _epoch(m.get("date", "")) >= since_ts]
    if not hits:
        tail = f"(仅看 {since} 之后)" if since else ""
        return f"未找到 {dom_root} 的来信(信箱共读 {len(msgs)} 封,可能还没到){tail}", False

    for m in hits:
        # 先看主题,不够再拉全文 —— 全文要多一次 IMAP 往返
        for text in (f"{m.get('subject','')} {m.get('snippet','')}", None):
            if text is None:
                try:
                    body, _tos = ms.read_msg(m["mid"])
                except Exception as e:
                    print(f"(读全文失败 {m['mid']}: {type(e).__name__})", file=sys.stderr)
                    continue
                text = body if isinstance(body, str) else str(body)
            links = [u for u in URL.findall(text) if VERIFY_HINT.search(u)]
            if links:
                return f"VERIFY_LINK:{links[0]}", True
            code = CODE.search(text)
            if code:
                return f"OTP:{code.group(1)}", True
    return f"找到 {dom_root} 的来信({len(hits)} 封)但提取不到验证码/链接", False


def main():
    ap = argparse.ArgumentParser(description="从 IMAP 信箱取某站的验证码/验证链接")
    ap.add_argument("--domain", required=True)
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--since", default=None,
                    help="只认该时刻之后的来信('YYYY-MM-DD HH:MM:SS' 本地时,或 ISO)")
    a = ap.parse_args()
    out, ok = find_otp(a.domain, a.limit, a.since)
    print(out)
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
