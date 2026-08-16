#!/usr/bin/env python3
"""build_link_library.py — 外链库(08-16 用户定):把 SEM dofollow 明细按来源页面聚合。

输入:backlinks-v2/datasets/sem_dofollow.jsonl(每行:某在榜站的一条 dofollow 外链)
输出:toolradar/library.json —— 页面级外链库:
  {url, src(来源域), title, plat(SEM 平台分类), ascore, targets[{d,a}], seen}
按"链向 AI 站数 × ascore"排序,取 top 12000(控制前端加载体积)。
"""
import json
from pathlib import Path
from urllib.parse import urlparse

DATA = Path("/Users/wy/cafe/backlinks-v2/datasets")
SITE = Path("/Users/wy/cafe/toolradar")


def main():
    pages = {}
    for line in open(DATA / "sem_dofollow.jsonl"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        url = (r.get("source_url") or "").strip()
        if not url.startswith("http"):
            continue
        e = pages.get(url)
        if e is None:
            e = pages[url] = {
                "src": urlparse(url).netloc.lower().replace("www.", ""),
                "title": (r.get("source_title") or "")[:80],
                "plat": r.get("platform") or [],
                "ascore": r.get("ascore") or 0,
                "targets": {},
                "tcount": set(),
                "seen": r.get("last_seen") or "",
            }
        tgt = r.get("domain")
        if tgt:
            e["tcount"].add(tgt)               # 完整计数(列表页链向几十站才是硬信号)
            if tgt not in e["targets"] and len(e["targets"]) < 6:
                e["targets"][tgt] = (r.get("anchor") or "")[:40]
        if (r.get("ascore") or 0) > e["ascore"]:
            e["ascore"] = r["ascore"]
        if (r.get("last_seen") or "") > e["seen"]:
            e["seen"] = r["last_seen"]
    lib = []
    for url, e in pages.items():
        t = e["title"].lower()
        if t.startswith(("error", "404", "page not found", "just a moment")):
            continue                          # 死页/错误页不入库
        if any(k in t for k in ("porn", "xxx", "casino", "bet", "slot")):
            continue                          # 成人/博彩页不入库
        lib.append({"url": url, "src": e["src"], "title": e["title"],
                    "plat": ",".join(e["plat"]), "ascore": e["ascore"],
                    "nt": len(e["tcount"]),
                    "targets": [{"d": k, "a": v} for k, v in e["targets"].items()],
                    "seen": str(e["seen"] or "")[:10]})
    # 【08-16】排序:有可投放语义的平台分类(blog/cms/wiki/mb/forum)优先,再按权重分;
    # 纯靠 nt 会把大平台首页(人人都链)顶到前面,那些不是可行动的外链源
    ACTIONABLE = ("blog", "cms", "wiki", "mb", "forum")
    lib.sort(key=lambda x: (0 if any(p in x["plat"] for p in ACTIONABLE) else 1,
                            -x["nt"], -x["ascore"]))
    lib = lib[:12000]
    json.dump(lib, open(SITE / "data" / "library.json", "w"), ensure_ascii=False)
    multi = sum(1 for x in lib if x["nt"] >= 2)
    print(f"外链库:{len(lib)} 页(链向≥2站的 {multi}),总页面池 {len(pages)}")


if __name__ == "__main__":
    main()
