#!/usr/bin/env python3
"""targets.py — 从外链库(library.json)生成投放工作清单。

筛选逻辑(沿用 backlinks-v2 的实战经验):
  - 只收 SEM 平台分类为 blog/cms/wiki/forum/mb 的页面(这些才可能接受投稿/评论)
  - 页面所在域去重(同域多页只留权重最高的一页,防同站连投)
  - 权重分 ascore 降序
产出 outreach/worklist.jsonl:{url, src, plat, ascore, nt}
用法: python3 targets.py [--min-ascore 30] [--max 500]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "data" / "library.json"
OUT = Path(__file__).resolve().parent / "worklist.jsonl"
GOOD_PLAT = ("blog", "cms", "wiki", "forum", "mb")


def main():
    min_ascore = 30
    mx = 500
    args = sys.argv[1:]
    if "--min-ascore" in args:
        min_ascore = int(args[args.index("--min-ascore") + 1])
    if "--max" in args:
        mx = int(args[args.index("--max") + 1])
    lib = json.load(open(LIB))
    SUBMIT_PATH = ("submit", "add", "join", "register", "listing", "directory", "post")
    best = {}
    for r in lib:
        if r.get("ascore", 0) < min_ascore:
            continue
        plat = r.get("plat") or ""
        if not any(p in plat for p in GOOD_PLAT):
            continue
        # 【实战】提交页加权/裸首页降权:wordpress.org 首页投不了,带 submit 路径的才是目标
        path = r["url"].lower()
        if any(k in path for k in SUBMIT_PATH):
            r = dict(r, ascore=r["ascore"] + 40)
        elif path.rstrip("/").count("/") <= 2:
            r = dict(r, ascore=r["ascore"] - 30)
        dom = r["src"]
        if dom not in best or r["ascore"] > best[dom]["ascore"]:
            best[dom] = r
    rows = sorted(best.values(), key=lambda x: -x["ascore"])[:mx]
    # 【08-16 实测 0/8 后的修正】分两层:tier1=带提交入口的页(直接可投),
    # tier2=高权重 blog/cms(评论/投稿机会,需要人工看一眼有没有表单)
    SUBMIT = ("submit", "add-", "/add", "join", "register", "listing", "directory",
              "write-for-us", "contribute", "guest", "post-a", "submit-your")
    with open(OUT, "w") as f:
        for r in rows:
            tier = 1 if any(k in r["url"].lower() for k in SUBMIT) else 2
            f.write(json.dumps({"url": r["url"], "src": r["src"], "plat": r["plat"],
                                "ascore": r["ascore"], "nt": r["nt"], "tier": tier},
                               ensure_ascii=False) + "\n")
    n1 = sum(1 for r in rows if any(k in r["url"].lower() for k in SUBMIT))
    print(f"工作清单 {len(rows)} 个目标(tier1 提交页 {n1} / tier2 机会页 {len(rows) - n1}) → {OUT}")


if __name__ == "__main__":
    main()
