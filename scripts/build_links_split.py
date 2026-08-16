#!/usr/bin/env python3
"""build_links_split.py — 把 sem_dofollow.jsonl 按目标域拆成单域文件(08-16 用户定:
外链库的价值 = 用户查竞品的 dofollow 来源决定去哪发链)。
产出 toolradar/links/<domain>.json:[{u,s,t,a,p,f}]每域 top100(ascore 序,拉取时已按 page_ascore desc)。
"""
import json
from pathlib import Path

DATA = Path("/Users/wy/cafe/backlinks-v2/datasets")
OUT = Path("/Users/wy/cafe/toolradar/data/links")
OUT.mkdir(exist_ok=True)


def main():
    per = {}
    for line in open(DATA / "sem_dofollow.jsonl"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        d = r.get("domain")
        if not d:
            continue
        per.setdefault(d, []).append({
            "u": r.get("source_url") or "",
            "s": (r.get("source_title") or "")[:60],
            "a": (r.get("anchor") or "")[:50],
            "p": ",".join(r.get("platform") or []),
            "s2": r.get("ascore") or 0,
            "f": str(r.get("first_seen") or "")[:10],
        })
    n = 0
    for d, rows in per.items():
        rows.sort(key=lambda x: -x["s2"])
        json.dump(rows[:100], open(OUT / f"{d}.json", "w"), ensure_ascii=False)
        n += 1
    print(f"拆分 {n} 个域 → links/ ({sum(len(v) for v in per.values())} 行)")


if __name__ == "__main__":
    main()
