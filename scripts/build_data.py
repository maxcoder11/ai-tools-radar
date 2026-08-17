#!/usr/bin/env python3
"""build_data.py — 生成 toolradar 榜单站的 data.json(每次内容更新都跑这个)。

数据管道(全部自家资产,零外采):
  名录:landing_tools(SW 落地页解析)+ directory_tools(目录 sitemap 挖矿)
  打标:rank_catalog(LLM 分类/双语描述;持续增量)
  流量:traffic_enrich(aitdk 付费接口,月访/全球排名/注册时间)
过滤:垃圾 TLD/编号域 + 非 AI-first 平台(白名单剔除) + 无流量数据不上榜。
用法:cd /Users/wy/cafe/toolradar && python3 scripts/build_data.py
"""
import json
import re
import shutil
from pathlib import Path

DATA = Path("/Users/wy/cafe/backlinks-v2/datasets")
SITE = Path("/Users/wy/cafe/toolradar")
# 【修】bet 原来是裸子串:实测在榜域里命中 9 个,8 个是正常站(better.net /
# betterprogramming.pub / teachbetter.ai / beta.raxa.io / bethnalgreenventures.com),
# 只有 1 个是真博彩 —— 纯误伤。改成按域名分段命中(bet.com / betting-x.com / a-bet-b.com),
# 代价是 betplentia 这类粘连写法漏掉,但 casino/slot 仍在,而误杀正常 AI 工具的代价更大。
JUNK = re.compile(r"^\d+\.|casino|porn|xxx|(^|[.\-])(bet|bets|betting|sportsbook)([.\-]|$)"
                  r"|slot|seo-|\.xyz$|\.top$|\.club$|\.shop$|\.store$", re.I)
NOT = re.compile(r"^(github\.com|tinyurl\.com|bit\.ly|open\.spotify\.com|ringcentral\.com|"
                 r"digitalocean\.com|discogs\.com|myanimelist\.net|91mobiles\.com|liveinternet\.ru|"
                 r"creators\.spotify\.com|spotify\.com|canva\.com|figma\.com|notion\.so|dropbox\.com|"
                 r"zoom\.us|slack\.com|trello\.com|asana\.com|shopify\.com|wix\.com|squarespace\.com|"
                 r"wordpress\.com|blogspot\.com|tumblr\.com|weebly\.com|bing\.com|microsoft\.com|t\.me|"
                 r"brave\.com|search\.brave\.com|imdb\.com|google\.|facebook\.|youtube\.|instagram\.|"
                 r"twitter\.|x\.com|linkedin\.|reddit\.|wikipedia\.|amazon\.|apple\.|play\.google|"
                 # 【08-16】总榜头部纯度:撞名混进来的通用平台(电商/门户/社媒/链接工具),非 AI 工具
                 r"walmart\.com|etsy\.com|zillow\.com|target\.com|flipkart\.com|taobao\.com|shop\.app|"
                 r"vercel\.app|zoom\.com|salesforce\.com|rottentomatoes\.com|goodreads\.com|"
                 r"trustpilot\.com|alibaba\.com|youtu\.be|deviantart\.com|"
                 r"baidu\.com|duckduckgo\.com|quora\.com|accuweather\.com|live\.com|okta\.com|"
                 r"bilibili\.com|snapchat\.com|threads\.com|onlyfans\.com|patreon\.com|vk\.com|max\.ru|"
                 r"xiaohongshu\.com|t\.co|linktr\.ee|line\.me|bsky\.app|ilovepdf\.com|adobe\.com|"
                 r"store\.steampowered\.com|chromewebstore\.|apps\.apple\.com|chat\.whatsapp\.com|"
                 # 【08-16】原正则尾部的 )$ 让所有 a\.b\. 前缀模式失效(整串必须恰好在点号结束),
                 # 导致 play.google.com/youtube.com 这类全漏。去掉 $,前缀即匹配。
                 r"pinterest\.|tiktok\.|medium\.com|substack\.com)")


def main():
    cat = {}
    p = DATA / "rank_catalog.jsonl"
    if p.exists():
        for line in open(p):
            r = json.loads(line)
            cat[r["domain"]] = r
    traf = {json.loads(l)["domain"]: json.loads(l) for l in open(DATA / "traffic_enrich.jsonl")}
    # 【08-15】RDAP 兜底注册时间(aitdk 无 whois 的残差)
    rdap_reg = {}
    p_rdap = DATA / "rdap_registered.jsonl"
    if p_rdap.exists():
        for line in open(p_rdap):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("registered"):
                rdap_reg[r["domain"]] = r["registered"]
    # 【08-15】aitdk 重查 + TabAPI /rdap 混合补查(残差 283 域那轮)
    p_bf2 = DATA / "registered_backfill2.jsonl"
    if p_bf2.exists():
        for line in open(p_bf2):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("registered"):
                rdap_reg[r["domain"]] = r["registered"]
    # 【08-15】SW getheader 全球排名(四源目录定级产物):免费流量信号,补充/替代 aitdk
    sw_rank = {}
    for fn in DATA.glob("*_sw_rank.jsonl"):
        for line in open(fn):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("sw_rank", 0) > 0:
                sw_rank[r["domain"]] = r["sw_rank"]
    # Ahrefs 导出:反链计数(1336 域,交集内有效)
    blc = {}
    p_bl = DATA / "ahrefs_backlink_counts.json"
    if p_bl.exists():
        blc = json.load(open(p_bl))
    # 【08-16】SEM dofollow 明细(全量拉取中):total_dofollow 计数 + blog/cms 平台构成
    sem_bl = {}
    p_sb = DATA / "sem_dofollow.jsonl"
    if p_sb.exists():
        for line in open(p_sb):
            try:
                r = json.loads(line)
            except Exception:
                continue
            e = sem_bl.setdefault(r["domain"], {"total": 0, "blog": 0, "cms": 0})
            e["total"] = max(e["total"], r.get("total_dofollow") or 0)
            p = r.get("platform") or []
            if "blog" in p:
                e["blog"] += 1
            if "cms" in p:
                e["cms"] += 1
    # 【08-15】SEM 有机数据(金矿带批次):自然排名词数/月自然流量/流量价值
    sem = {}
    p_sem = DATA / "gold_sem_organic.jsonl"
    if p_sem.exists():
        for line in open(p_sem):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("organic_positions"):
                sem[r["domain"]] = r
    # 【08-15】TabAPI 补缺(在榜缺 sem 的头部域):organic_visits_est = visits×search_organic 占比
    tab = {}
    p_tab = DATA / "tabapi_traffic.jsonl"
    if p_tab.exists():
        for line in open(p_tab):
            try:
                r = json.loads(line)
            except Exception:
                continue
            tab[r["domain"]] = r
    # 【08-16】aitdk 渠道(fetch_full)+ SW widgetApi 拉取:同字段口径(visits/rank/mix/organic 估值)
    for fn in ("aitdk_channels.jsonl", "sw_traffic_mix.jsonl"):
        p_x = DATA / fn
        if p_x.exists():
            for line in open(p_x):
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if "visits" not in r and r.get("visits_28d"):
                    r["visits"] = r["visits_28d"]   # sw_traffic_mix 字段名对齐
                tab.setdefault(r["domain"], r)   # tabapi 优先,这两个只做补充
    # 【08-16】增长曲线/关键词:aitdk monthly(12 月)+ top_keywords,增长榜与详情抽屉用
    # full_enrich(老)的 monthly 是 [{m,v}],aitdk_channels 是 {m:v};统一成 [[m,v],...] 升序
    series = {}
    for fn in ("aitdk_channels.jsonl", "full_enrich.jsonl"):
        p_s = DATA / fn
        if not p_s.exists():
            continue
        for line in open(p_s):
            try:
                r = json.loads(line)
            except Exception:
                continue
            dom = r.get("domain")
            if not dom or dom in series:
                continue
            m = r.get("monthly")
            if isinstance(m, dict):
                arr = sorted(m.items())[-12:]
            elif isinstance(m, list):
                arr = sorted((x.get("m"), x.get("v")) for x in m if x.get("m"))[-12:]
            else:
                arr = []
            arr = [[a, int(b or 0)] for a, b in arr if b]
            if len(arr) >= 2:
                series[dom] = {"monthly": arr,
                               "kw": [{"n": k.get("name"), "v": k.get("volume"), "c": k.get("cpc")}
                                      for k in (r.get("top_keywords") or [])[:5] if k.get("name")]}
    # 【08-15】收录线索:landing_tools 里每域的目录来源 + 我们发现时间 + aixploria 月份(真收录月)
    dir_info = {}
    clicks = {}
    lp = DATA / "landing_tools.jsonl"
    if lp.exists():
        for line in open(lp):
            try:
                r = json.loads(line)
            except Exception:
                continue
            d = r.get("tool_domain")
            if d:
                clicks[d.lower()] = clicks.get(d.lower(), 0) + (r.get("clicks") or 0)
                di = dir_info.setdefault(d.lower(), {"dirs": set(), "listed_month": ""})
                if r.get("dir"):
                    di["dirs"].add(r["dir"])
                # aixploria 的 lastmod 是月度分图的真收录月;其他源的 lastmod 是批量刷新不可信
                if r.get("dir") == "aixploria.com" and r.get("lastmod"):
                    if r["lastmod"] > di["listed_month"]:
                        di["listed_month"] = r["lastmod"]
    doms = set(cat) | set(clicks)
    for fn in ("directory_tools.jsonl",):
        fp = DATA / fn
        if not fp.exists():
            continue
        for line in open(fp):
            try:
                d = json.loads(line).get("tool_domain")
            except Exception:
                continue
            if d:
                doms.add(d.lower())
    out = []
    for d in doms:
        if JUNK.search(d) or NOT.search(d):
            continue
        t = traf.get(d) or {}
        tb = tab.get(d, {})
        visits = t.get("visits") or tb.get("visits")
        r = cat.get(d, {})
        rk = sw_rank.get(d, 0)
        reg = t.get("registered") or r.get("registered") or rdap_reg.get(d)
        if not visits and not clicks.get(d) and not reg and not rk:
            continue                # 都没数 = 死站/垃圾;有注册时间(任意源)或 SW 排名的放行
        if r.get("is_tool") is False:
            continue                # 【08-16】分类器判非工具(停放页/纯资讯/默认安装页等)不上榜
        r = cat.get(d, {})
        s = sem.get(d, {})
        di = dir_info.get(d, {})
        sr = series.get(d, {})
        # 环比:最近两月;前值太小(<500)百分比没意义,涨幅展示封顶 +999%
        mom = None
        if sr.get("monthly"):
            (m1, v1), (m2, v2) = sr["monthly"][-2], sr["monthly"][-1]
            if v1 >= 500:
                mom = max(-99, min(999, round((v2 - v1) / v1 * 100, 1)))
        out.append({"domain": d, "name": (r.get("name") or d).strip(),
                    "desc_zh": r.get("desc_zh") or "", "desc_en": r.get("desc_en") or "",
                    "categories": r.get("categories") or [], "free": r.get("free") or "unknown",
                    "signup": r.get("signup") or "unknown",
                    "visits": visits, "clicks": clicks.get(d),
                    "bl": (sem_bl.get(d) or {}).get("total") or blc.get(d),
                    "bl_blog": (sem_bl.get(d) or {}).get("blog"),
                    "global_rank": t.get("global_rank") or rk or tb.get("global_rank") or None,
                    "sem_traffic": s.get("organic_traffic") or tb.get("organic_visits_est"),
                    "sem_positions": s.get("organic_positions"),
                    "mix": tb.get("mix"),
                    "monthly": sr.get("monthly"), "mom": mom,
                    "kw": sr.get("kw"),
                    "listed_month": di.get("listed_month") or "",
                    "n_dirs": len(di.get("dirs") or []),
                    "registered": reg,
                    "organic": r.get("organic"), "dr": r.get("dr")})
    # 排序:月访 > clicks 兜底 > SW 排名折算(5e6/rank,1万名≈500,50万名≈10)
    out.sort(key=lambda x: -((x["visits"] or 0) or (x["clicks"] or 0) * 100
                             or (5e6 / x["global_rank"] if x["global_rank"] else 0)))
    json.dump(out, open(SITE / "data" / "data.json", "w"), ensure_ascii=False)   # 【08-16】入 data/ 子目录 + 不缩进(体积减半)
    print(f"上站 {len(out)};有描述 {sum(1 for x in out if x['desc_zh'])};"
          f"aitdk 流量 {sum(1 for x in out if x['visits'])};clicks 兜底 {sum(1 for x in out if not x['visits'])}")


if __name__ == "__main__":
    main()
