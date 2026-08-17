#!/usr/bin/env python3
"""read_otp.py — 从**双信箱**里取某个站的验证码/验证链接,给投放 agent 用。

## 为什么要有这个文件(2026-07-29)

agent_submit 的 emailOtp() 原来直接 exec `agently-cli` —— 也就是**只读一个信箱**。
注册身份换成产品联系邮箱(contact@<产品域>,邮件转发进 AgentMail)之后,
验证码会落到 AgentMail,而 agent 还在旧信箱里找,
每个需要「填验证码」的站都会卡在"未找到来信(可能还没到)"直到步数耗尽。
换身份和换取信通道必须**同时**做,只做一半比不做更糟:
邮件分裂到两个箱子,而取信只认其中一个。

## 为什么不在 JS 里再写一遍

信箱访问只应该有一份实现。mail_sweeper 已经把两个信箱、字段兼容(from_ 可能是
字符串也可能是对象)、message_id 白名单这些坑都踩平了,再抄一份 JS 版必然分叉。
这里直接复用它的 list_msgs()/read_msg()。

## 匹配规则跟着 mail_sweeper 走,不用 JS 那版

JS 版用 `domBare.split('.')[0]` 去匹配主题 —— 对 ai.tools 就退化成 "ai",
主题里带 ai 的信全会被认成这个站的。mail_sweeper 早就修过这个(见 sweep_for 注释),
这里沿用严格版:**发件域匹配为主,主题匹配要求完整根域出现**。

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

# 验证类链接的判据跟 JS 版保持一致,免得两边对同一封信给出不同结论
VERIFY_HINT = re.compile(r"verif|confirm|activate|激活|验证|認証", re.I)
CODE = re.compile(r"\b(\d{4,8})\b")
URL = re.compile(r"https?://[^\s\"')\]<>]+")


def _matches(dom_root, frm, subj):
    """这封信是不是这个站发来的。**宽松匹配会让 agent 把别人的验证码填进表单**。

    【修】原实现是纯子串,与本文件开头承诺的"严格版"不符:dom_root="tools.com"
    会命中 noreply@nottools.com。现在两边都要求边界 ——
      发件人:域必须**等于根域或其子域**(按 @ 之后的 host 判,不是整串找);
      主题:根域两侧必须是非域名字符(不能是 . - 或字母数字)。
    """
    frm = (frm or "").lower()
    subj = (subj or "").lower()
    host = frm.rsplit("@", 1)[-1].strip(" <>\t")
    if host == dom_root or host.endswith("." + dom_root):
        return True
    # 右边界:要挡住 tools.com.evil,又不能误伤句末的 "Verify tools.com."。
    # 区别在于 `.` 后面还有没有域名字符 —— 后面跟字母数字才是更长的域名。
    return re.search(r"(?:^|[^A-Za-z0-9.\-])" + re.escape(dom_root)
                     + r"(?![A-Za-z0-9\-])(?!\.[A-Za-z0-9])", subj) is not None


def _epoch(s):
    """ISO/普通时间串 → epoch 秒;解析不了当 0(永不通过 since 过滤)。"""
    s = (s or "").strip()
    if not s:
        return 0.0
    try:
        from datetime import datetime
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def find_otp(dom, limit=25, since=None):
    """返回 (结果字符串, 是否找到)。

    since(可选,本地时间 'YYYY-MM-DD HH:MM:SS' 或 ISO):只认该时刻之后的来信。
    【2026-07-30】为什么必须有过滤:同站的旧验证码信会留在箱子里,不过滤时
    新一次注册可能读到**上一次的死码**填进去(foundrlist 实证:07-28 的旧码
    309197 被填进 07-30 的注册,Supabase 回 otp_expired)。
    """
    dom_root = root_domain(dom.replace("www.", "")).lower()
    if not dom_root:
        return f"域名解析不出可注册域:{dom}", False
    since_ts = _epoch(since) if since else 0.0     # 无时区标记按本机(UTC+8)解,邮件侧全是 UTC,直接可比
    msgs = ms.list_msgs(limit)
    hits = [m for m in msgs
            if _matches(dom_root, m.get("from", ""), m.get("subject", ""))
            and _epoch(m.get("date", "")) >= since_ts]
    if not hits:
        tail = f"(仅看 {since} 之后)" if since else ""
        return f"未找到 {dom_root} 的来信(双信箱共 {len(msgs)} 封,可能还没到){tail}", False

    for m in hits:
        # 先看摘要,不够再拉全文 —— 全文要多一次 API/子进程调用
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
    ap = argparse.ArgumentParser(description="从双信箱取某站的验证码/验证链接")
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
