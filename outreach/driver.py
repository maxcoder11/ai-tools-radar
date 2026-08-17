#!/usr/bin/env python3
"""driver.py — 滚动投放驱动(2026-08-16 开源版,简化自生产 rolling_submit.py)。

读 worklist.jsonl(targets.py 产物),逐域调 agent_submit.mjs:
  - 每域每天最多一次(state.jsonl 当天有行即跳过);终端态
    (success/pending_review/emailed/manual/skipped_*/delivery_ambiguous/done)不再重投
  - 域间 20-40s 随机间隔(纪律:不连投)
  - persona 轮换(生产能力):评论腿(blog/forum/mb 页)按域 hash 从 identities.json
    抽 persona + 作者网址池(AUTHOR_URL_POOL)轮换,注入 IDENTITY_FORCE;
    目录腿不覆盖(目录链必须指主域)。agent_submit.mjs 内部另有按域 hash 的
    自动抽取兜底,驱动这层只管"评论作者网址多落点"
  - agent exit 42 = 打码日预算熔断:停波,别把剩下的验证码域逐个空跑
  - LLM 瞬态(429/限流/网络抖动):不是站的错,域不落账,退避 60s 后继续
  - 无声退出兜底:agent 无论因何没留 state 行(静默崩溃),补记 blocked;
    但 SILENT_SKIP_MARKERS 的路径是 agent 故意干净退出(域留池),不补记
  - 包装超时(900s 硬顶):补记 blocked,防僵尸域每波被重选白烧
未包含(私有基建,见 README「未包含」):代理节点轮换(mihomo/Surge)、
  CF 签名住宅出口重投、cloak 指纹内核救援。
用法:
  python3 driver.py [--limit 20] [--steps 24] [--loop]
配置:LLM 端点见 llm_config.py(LLM_BASE_URL/LLM_API_KEY/LLM_MODEL 或 llm.json,必配);
  HTTPS_PROXY 可选;NODE_BIN 指定 node;
  AUTHOR_URL_POOL 逗号分隔的评论作者网址池(默认只有 kit 主域)。
"""
import hashlib
import json
import os
import random
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import state  # noqa: E402  账本唯一写入口(状态枚举 + 迁移守卫),别绕过它裸写
import llm_config  # noqa: E402  LLM 端点/key/模型的唯一解析口(env 或 llm.json)

HERE = Path(__file__).resolve().parent
WORKLIST = HERE / "worklist.jsonl"
# 账本路径跟 state.py 走(它认 OUTREACH_STATE_DIR),别各写一份否则读写分叉
STATE = Path(state.STATE_FILE)
LOGDIR = HERE / "run" / "agent_logs"
NODE = os.environ.get("NODE_BIN", "node")
KIT = os.environ.get("KIT", str(HERE / "kit.json"))

# agent 故意一行不写、干净退出(域留池等下轮重投)的输出标记;兜底分不清
# 「故意」和「崩溃」,这些路径补记 blocked 会把投达单烧掉。
SILENT_SKIP_MARKERS = ("LLM 瞬态", "基建故障", "预算熔断", "LEDGER_WRITE_FAILED", "DELIVERY_AMBIGUOUS")

# 终态:不再自动重投(delivery_ambiguous 只能人工裁决 —— 重投 = 重复提交,比漏投更糟)
TERMINAL = ("success", "pending_review", "emailed", "manual",
            "skipped_paid", "skipped_badge", "skipped_fit",
            "delivery_ambiguous", "done", "done_unverified", "approved")

# 评论腿识别:worklist 的 plat 含这些平台分类的页,投的是评论/社区场景
COMMENT_PLAT = ("blog", "forum", "mb")


def _h(domain):
    return int(hashlib.md5(domain.encode()).hexdigest(), 16)


def _personas():
    """persona 池(identities.json)。读不到返回 None —— 不强制:
    agent_submit.mjs 内部还有一层按域 hash 的自动抽取(带响亮告警)。"""
    try:
        pool = json.load(open(HERE / "identities.json"))
        pool = [p for p in pool if p.get("name") and p.get("email")]
        return pool or None
    except Exception:
        return None


def _url_pool():
    """评论作者网址池:env AUTHOR_URL_POOL(逗号分隔)> kit 主域单落点。
    生产是 主域50%/卫星博客各25% 的三落点轮换,破跨站签名;没有卫星落点就主域。"""
    env = os.environ.get("AUTHOR_URL_POOL", "").strip()
    if env:
        pool = [u.strip() for u in env.split(",") if u.strip()]
        if pool:
            return pool
    try:
        u = json.load(open(KIT))["product"]["url"].rstrip("/") + "/"
        return [u]
    except Exception:
        return []


PERSONAS = _personas()
URL_POOL = _url_pool()


class BudgetStop(Exception):
    """打码日预算熔断(agent exit 42):停波,剩下的验证码域继续投只会逐个空跑。"""


def load_state():
    """src → 最后一行(state.jsonl 是追加日志,后者盖前者)。

    【修】键**同时按原样和 canon 各存一份**。查询侧已经统一 canon,但**历史行不会
    自动迁移** —— 升级前由老 driver 写下的 `www.Example.com` 行,用 canon 键
    `example.com` 去查会漏掉,于是一个已经 success 的域被当成没投过、重新投递。
    两种键都建索引,新旧账本都认得;canon 行优先(它才是写入端现在的口径)。
    """
    raw, canon = {}, {}
    if STATE.exists():
        for line in open(STATE):
            try:
                r = json.loads(line)
            except Exception:
                continue
            src = r.get("src")
            if not src:
                continue
            raw[src] = r
            canon[_key(src)] = r
    merged = dict(raw)
    merged.update(canon)        # 同一 canon 键上,canon 侧(新写入口径)说了算
    return merged


def save_state(src, status, note=""):
    """写账本。**必须走 state.upsert_submission 的迁移守卫,不许裸追加。**

    driver 只有两处写:包装超时兜底、无声退出兜底 —— 两处都可能发生在 agent
    已经把表单投出去之后。裸追加 blocked 会把 pending_review/success 打成非终态,
    该域下一波被重选重投 = 重复提交(比漏投更糟,正是全系统守卫要防的那件事)。
    守卫拒绝时只打日志、不改状态;账本表达不了的域(非法域名/未知状态)如实报错,
    宁可不记也不硬写。
    """
    try:
        r = state.upsert_submission(src, status, note=note[:150],
                                    source="driver", reason_code="local_error")
    except ValueError as e:
        print(f"  [账本] {src} 写 {status} 被拒:{e}", flush=True)
        return
    if not r.get("written"):
        print(f"  [账本] 状态守卫拒绝 {r['from']} → {status}"
              f"(投达态不被兜底打回),{src} 终局保持 {r['from']}", flush=True)


def _key(src):
    """账本键。**必须与写入端同口径** —— state.upsert_submission 会 canon(剥 www./
    小写/去端口),这里查询时不 canon 的话,worklist 里一个 `www.foo.com` 就会
    「写进 foo.com、查 www.foo.com」永远查不到 → 该域每波都被重选重投。
    今天的 library.json 里 src 全是 canon 形式(实测 0 个带 www、0 个大写),
    所以触发不了;但键的一致性不能靠数据碰巧干净。canon 不了就原样(与写入端同样降级)。
    """
    try:
        return state.canon_domain(src)
    except ValueError:
        return src


def pick_batch(limit):
    st = load_state()
    today = time.strftime("%Y-%m-%d", time.gmtime())
    todo = []
    for line in open(WORKLIST):
        r = json.loads(line)
        prev = st.get(_key(r["src"]))
        if prev:
            if prev.get("ts", "").startswith(today):
                continue                        # 每域每天一次
            if prev.get("status") in TERMINAL:
                continue                        # 终态不重投
        todo.append(r)
    todo.sort(key=lambda r: r.get("tier", 2))   # tier1 提交页先投
    return todo[:limit]


def run_site(r, steps):
    dom, url = r["src"], r["url"]
    env = dict(os.environ, SUBMIT_MAX_MINUTES="10")
    # persona 轮换(评论腿):按域 hash 固定抽 persona + 作者网址池轮换,
    # 破 Akismet 跨站签名;目录腿不覆盖(目录链必须指主域)。
    plat = r.get("plat") or ""
    if any(p in plat for p in COMMENT_PLAT) and PERSONAS and URL_POOL:
        p = PERSONAS[_h(dom) % len(PERSONAS)]
        u = URL_POOL[_h(dom) % len(URL_POOL)]
        env["IDENTITY_FORCE"] = f"{p['name']}|{p['email']}|{u}"
    print(f"[{time.strftime('%H:%M:%S')}] {dom} ⇠ {url[:60]}", flush=True)
    try:
        p = subprocess.run([NODE, str(HERE / "agent_submit.mjs"), url,
                            "--kit", KIT, "--steps", str(steps)],
                           env=env, capture_output=True, text=True, timeout=900,
                           cwd=str(HERE))
        out = p.stdout + p.stderr
        if p.returncode == 42:
            print(f"  [预算熔断] {dom} 打码日预算尽(agent exit 42),本波提前收", flush=True)
            raise BudgetStop(dom)
        if p.returncode == 43:
            print(f"  [写账失败] {dom} LEDGER_WRITE_FAILED(exit 43):表单可能已投达,"
                  f"不补记 blocked,域留池 —— 检查磁盘/权限", flush=True)
    except subprocess.TimeoutExpired:
        out = "(包装超时 900s)"
        # 包装超时=true 僵尸:agent 被杀、行没写成,域永远满足「未投过」,每波重选
        # 白烧 15 分钟。必须补记 blocked,让「当天有行」闸把它排除。
        # 【修】经 save_state 的守卫写:agent 若已投达(pending_review/success/
        # emailed/ambiguous),这条 blocked 会被拒 —— 那种域本来就在 TERMINAL 里,
        # 不靠「当天有行」闸也不会被重选,不需要、也绝不能把它打回可重投。
        save_state(dom, "blocked", "agent_submit 包装超时(900s 硬顶),按 blocked 记")
    for line in out.splitlines():
        # 只转关键诊断行;完整输出落 run/agent_logs/<domain>.log
        if any(k in line for k in ("终局", "EXC", "skipped", "看门狗", "LLM 瞬态", "FATAL",
                                   "写库失败", "LEDGER_WRITE_FAILED", "DELIVERY_AMBIGUOUS",
                                   "manual", "[llm]")):
            print("  ", line.strip()[:140], flush=True)
    try:
        LOGDIR.mkdir(parents=True, exist_ok=True)
        with open(LOGDIR / f"{dom}.log", "w") as lf:
            lf.write(out)
    except Exception:
        pass
    # LLM 瞬态(429/限流/上游抖动):agent 不落账、域留池;退避 60s 给限流窗口回气
    if "LLM 瞬态" in out:
        print(f"  [退避] {dom} LLM 瞬态,睡 60s", flush=True)
        time.sleep(60)
    # 无声退出兜底:agent 无论因何没留下 state 行(静默崩溃),补记 blocked。
    # 例外:SILENT_SKIP_MARKERS 是 agent 故意干净退出(域留池)的设计,不补记。
    st = load_state()
    cur = st.get(_key(dom))          # 与写入端同口径,别用原始域回读(会看不见 canon 行)
    today = time.strftime("%Y-%m-%d", time.gmtime())
    if (not cur or not cur.get("ts", "").startswith(today)) \
            and not any(k in out for k in SILENT_SKIP_MARKERS):
        save_state(dom, "blocked", "agent_submit 无声退出(无终局无落账),按 blocked 记")


def main():
    limit = 20
    steps = 24
    loop = "--loop" in sys.argv
    args = sys.argv[1:]
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    if "--steps" in args:
        steps = int(args[args.index("--steps") + 1])
    try:
        _llm = llm_config.require_llm("driver")     # 缺 key 就在这里停,别放一整波空跑
    except RuntimeError as e:
        sys.exit(str(e))
    for w in _llm["warnings"]:
        print(f"[llm] {w}", flush=True)
    print(f"[llm] 端点 {_llm['url']} | 模型 {' → '.join(_llm['models'])} | "
          f"key {llm_config.mask(_llm['key'])}", flush=True)
    if not Path(KIT).exists():
        sys.exit(f"缺 {KIT}(cp kit.example.json kit.json 后改成你的产品资料)")
    while True:
        todo = pick_batch(limit)
        if not todo:
            print("== 工作清单空(全部终态或今天已投)==", flush=True)
            if not loop:
                return
            time.sleep(3600)
            continue
        print(f"== 本波 {len(todo)} 个目标 ==", flush=True)
        try:
            for r in todo:
                run_site(r, steps)
                time.sleep(random.uniform(20, 40))   # 纪律:域间不连投
        except BudgetStop:
            print("== 本波因打码日预算熔断提前收 ==", flush=True)
            if loop:
                time.sleep(3600)
        print("== 本波完 ==", flush=True)
        if not loop:
            return


if __name__ == "__main__":
    main()
