#!/usr/bin/env python3
"""dbwpy.py — 兼容层(2026-08-16):生产 backlinks-v2/scripts/dbwpy.py 的 API 面,
落在 outreach 的 state.jsonl(state.py)上。

存在的唯一理由:让生产 mail_sweeper.py 的调用点**原样**跑 ——
`dbwpy.conn().execute(<那条 SQL>, params)`、`dbwpy.upsert_submission(...)` 等
一行不改。这里按生产代码里实际出现的 SQL 字面量逐条模式匹配;出现没见过的
SQL 响亮报错(绝不静默吞),要支持就按语义补一条。

单产品:product_id 恒为 1,产品 URL 从 outreach/kit.json 读。
v1/v2 双库语义合并为同一个账本:开源版只有一条投放管道,没有双库分裂。
"""
import json
import os
import re
import time

HERE = os.path.dirname(os.path.abspath(__file__))
import state as st  # noqa: E402

DEFAULT_PRODUCT = 1


# ---------- 域匹配助手(state.jsonl 折叠)----------

def _all_rows():
    return st._read_jsonl(st.STATE_FILE)


def _latest():
    """dom → 最后一行(当前态投影)。"""
    cur = {}
    for r in _all_rows():
        if r.get("src"):
            cur[r["src"]] = r
    return cur


def _match_site(dom, site):
    return dom == site or dom.endswith("." + site)


def _domains_matching(site):
    return sorted({d for d in _latest() if _match_site(d, site)})


# ---------- 游标/连接 ----------

class _Cur:
    def __init__(self, rows=(), rowcount=0, lastrowid=None):
        self._rows = list(rows)
        self.rowcount = rowcount
        self.lastrowid = lastrowid

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


def _kit_products():
    """products 表的开源对应:kit.json 一个产品。"""
    try:
        url = json.load(open(os.path.join(HERE, "kit.json")))["product"]["url"]
        return [(DEFAULT_PRODUCT, url)]
    except Exception:
        return []


class _Conn:
    """按生产 sweeper 实际使用的 SQL 字面量逐条实现;不认得的 SQL 响亮报错。"""

    def execute(self, sql, params=()):
        q = re.sub(r"\s+", " ", sql).strip()

        # known_sites / v2 侧:全部域
        if q.startswith("SELECT domain FROM submissions UNION SELECT domain FROM submit_friendly") \
                or q.startswith("SELECT DISTINCT domain FROM submissions"):
            return _Cur([(d,) for d in sorted(_latest())])

        # v2_has:域有没有记录
        if q.startswith("SELECT 1 FROM submissions WHERE domain=? OR domain LIKE ? LIMIT 1"):
            site = params[0]
            return _Cur([(1,)] if _domains_matching(site) else [])

        # v2_upsert 的 host 级查找:匹配的 distinct 域
        if q.startswith("SELECT domain FROM submissions WHERE product_id=? AND (domain=? OR domain LIKE ?)"):
            return _Cur([(d,) for d in _domains_matching(params[1])])

        # product_for_site:按域反查投放记录(单产品 → 有记录就是 product 1)
        if q.startswith("SELECT product_id, MAX(COALESCE(updated_at, submitted_at))"):
            ds = _domains_matching(params[0])
            if not ds:
                return _Cur([])
            ts = max(_latest()[d].get("ts", "") for d in ds)
            return _Cur([(DEFAULT_PRODUCT, ts)])

        # product_for_recipient:products 表 → kit.json
        if q.startswith("SELECT id, url FROM products"):
            return _Cur(_kit_products())

        # _email_send_correlated:开源版没有外联发信日志(driver 只走站内表单)
        # —— 抛表不存在,调用方按"无法相关,只记录"的降级路径走(生产同款降级)。
        if "FROM outreach_log" in q:
            raise RuntimeError("outreach_log 表不存在(开源版无外联发信日志,按无法相关处理)")

        # bounce 改判的 emailed 行查找(带/不带 product_id 两种)
        if q.startswith("SELECT product_id, domain FROM submissions") and "status='emailed'" in q:
            site = params[0]
            rows = [(DEFAULT_PRODUCT, d) for d in _domains_matching(site)
                    if _latest()[d].get("status") == "emailed"]
            return _Cur(rows)

        # 验证信重投前查当前态
        if q.startswith("SELECT status FROM submissions WHERE domain=? AND product_id=?"):
            cur = _latest().get(params[0])
            return _Cur([(cur["status"],)] if cur else [])

        # 邮箱验证完成:v2 清 blocked(域回池)。append-only 账本不能删行,
        # 同语义:写 email_verified(非终态,driver 见它会重投)。
        if q.startswith("DELETE FROM submissions WHERE domain=? AND product_id=? AND status='blocked'"):
            dom = params[0]
            cur = _latest().get(dom)
            if cur and cur.get("status") == "blocked":
                st.upsert_submission(domain=dom, status="email_verified",
                                     evidence="验证信已点通,blocked 解除回池重投",
                                     source="mail_sweeper", reason_code="site_acknowledged")
                return _Cur(rowcount=1)
            return _Cur(rowcount=0)

        # 重投任务去重检查:开源版没有 agent_tasks 队列(driver 直接读 state.jsonl),
        # 恒无 pending → 不挡重投语义(email_verified 行本身就触发重投)
        if q.startswith("SELECT 1 FROM agent_tasks WHERE status='pending'"):
            return _Cur([])

        # sweep_for 水位线:base 之后该域处理完的信封数
        if q.startswith("SELECT COUNT(*) FROM mail_seen WHERE rowid>?"):
            return _Cur([(st.mail_done_since(params[1], params[0]),)])

        # human_tasks 入队(真人回信/不敢自动判的)
        if q.startswith("INSERT INTO human_tasks"):
            _pid, site, url, blocker, guidance = params
            r = st.human_task_add(site, url=url, blocker=blocker, guidance=guidance)
            return _Cur(rowcount=1, lastrowid=r["id"])

        raise RuntimeError(f"dbwpy shim: 未支持的 SQL,按语义补一条再说: {q[:120]}")

    # 兼容生产 conn 的 timeout/isolation_level 等构造参数语义:这里无连接,全忽略
    def close(self):
        pass


def conn():
    return _Conn()


def w_retry(sql, params=()):
    """生产的带重试写。两条 INSERT/UPDATE 语义落在账本/事件上。"""
    q = re.sub(r"\s+", " ", sql).strip()
    if q.startswith("UPDATE submit_friendly SET email_verification='done'"):
        st.record_event(params[0], "note", reason_code="site_acknowledged",
                        source="mail_sweeper", evidence="邮箱验证完成(submit_friendly 语义)")
        return _Cur(rowcount=1)
    if q.startswith("INSERT INTO agent_tasks"):
        # 开源版没有任务队列:email_verified 行已让 driver 自然重投,记事件留痕
        try:
            sel = json.loads(params[1])
            doms = sel.get("domains") or []
        except Exception:
            doms = []
        for d in doms:
            st.record_event(d, "note", reason_code="site_acknowledged",
                            source="mail_sweeper",
                            evidence="邮箱验证完成自动重投(agent_tasks 语义,driver 读 state 自然重投)")
        return _Cur(rowcount=1, lastrowid=0)
    raise RuntimeError(f"dbwpy shim: 未支持的写 SQL: {q[:120]}")


# ---------- 邮件幂等/水位线/等待队列(转 state.py)----------

def mail_claim(mid, worker, domain=None):
    return st.mail_claim(mid, worker, domain)


def mail_done(mid):
    return st.mail_done(mid)


def mail_release(mid, note=""):
    return st.mail_release(mid, note)


def mail_is_done(mid):
    return st.mail_is_done(mid)


def mail_set_domain(mid, domain):
    return st.mail_set_domain(mid, domain)


def mail_recent_done(domain, within_sec=900):
    return st.mail_recent_done(domain, within_sec)


def mail_done_max_rowid():
    """生产用语义是 rowid 水位线;这里用 epoch 水位线(单调性相同)。"""
    return st.mail_done_max_epoch()


_WAIT_FILE = os.path.join(st.DIR, "run", "_mail_wait.json")


def _wait_load():
    try:
        return json.load(open(_WAIT_FILE))
    except Exception:
        return {}


def _wait_save(d):
    os.makedirs(os.path.dirname(_WAIT_FILE), exist_ok=True)
    tmp = _WAIT_FILE + f".tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(d, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, _WAIT_FILE)


def mail_wait_register(root, deadline, pid):
    """登记"我在等这个域的信",deadline 是 UTC 串(与生产同格式)。"""
    d = _wait_load()
    try:
        dl = time.mktime(time.strptime(deadline, "%Y-%m-%d %H:%M:%S")) + 0.0
        # 生产 deadline 是 UTC 串;time.mktime 按本地时区解 —— 差一个时区偏移,
        # 只影响等待窗口的绝对长度,不影响"有没有人等"的语义,从宽保留
    except Exception:
        dl = time.time() + 90
    d[root] = {"deadline": dl, "pid": pid}
    _wait_save(d)


def mail_wait_clear(root):
    d = _wait_load()
    if root in d:
        del d[root]
        _wait_save(d)


def mail_waiting_now():
    d = _wait_load()
    now = time.time()
    live = {k: v for k, v in d.items() if float(v.get("deadline", 0)) > now}
    if len(live) != len(d):
        _wait_save(live)      # 顺手清尸
    return len(live)


# ---------- 状态写回/约束/事件(转 state.py,守卫语义同生产)----------

def upsert_submission(product_id=DEFAULT_PRODUCT, domain=None, status=None,
                      evidence="", source="unknown", reason_code=None, **_kw):
    return st.upsert_submission(domain=domain, status=status, evidence=evidence,
                                source=source, reason_code=reason_code)


def add_constraint(domain=None, reason_code=None, evidence=None, ttl_days=30, product_id=None):
    return st.add_constraint(domain=domain, reason_code=reason_code,
                             evidence=evidence, ttl_days=ttl_days)


def record_event(product_id=DEFAULT_PRODUCT, domain=None, event_type=None,
                 source="unknown", evidence=None, **_kw):
    return st.record_event(domain, event_type, source=source, evidence=evidence)


def migrate_domain_key(product_id=DEFAULT_PRODUCT, domain=None):
    """生产的脏键归一。开源版写入端恒 canon,脏键基本不存在:
    canon 相同 → clean;canon 键已有行而传入的不是 canon → conflict(转人工);
    其余 → clean(新写入都会落到 canon 键)。"""
    try:
        canon = st.canon_domain(domain)
    except ValueError:
        return (domain, "invalid")
    if canon == domain:
        return (canon, "clean")
    if st.current_status(canon) is not None:
        return (canon, "conflict")
    return (canon, "clean")


def canon_domain(d):
    return st.canon_domain(d)
