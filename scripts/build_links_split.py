#!/usr/bin/env python3
"""build_links_split.py — 把 sem_dofollow.jsonl 按目标域拆成单域文件(08-16 用户定:
外链库的价值 = 用户查竞品的 dofollow 来源决定去哪发链)。

产出 <站点>/data/links/<domain>.json:`[{u,s,a,p,s2,f}]`
  u=来源页 s=来源标题 a=锚文本 p=平台分类 s2=权重分(ascore) f=首见日期
每域按 s2 降序**截前 100 条**(这是有意的体积上限,不是全量;README/AGENTS.md 的
口径必须跟着说 top 100,别对外写"全部来源")。

⚠️ DATA/OUT 是本机私有数据湖与站点目录的绝对路径,换机器/换仓要自己改。
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
