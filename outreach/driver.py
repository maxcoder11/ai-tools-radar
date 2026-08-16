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
环境变量:LLM_ENDPOINT/LLM_KEY/LLM_MODEL 必配;HTTPS_PROXY 可选;NODE_BIN 指定 node;
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

HERE = Path(__file__).resolve().parent
WORKLIST = HERE / "worklist.jsonl"
STATE = HERE / "state.jsonl"
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
    """src → 最后一行(state.jsonl 是追加日志,后者盖前者)。"""
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
                            "ts": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())},
                           ensure_ascii=False) + "\n")


def pick_batch(limit):
    st = load_state()
    today = time.strftime("%Y-%m-%d", time.gmtime())
    todo = []
    for line in open(WORKLIST):
        r = json.loads(line)
        prev = st.get(r["src"])
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
    cur = st.get(dom)
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
    if not (os.environ.get("LLM_KEY") or "").strip():
        sys.exit("缺 LLM_KEY(LLM_ENDPOINT/LLM_KEY/LLM_MODEL,见 README)")
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
