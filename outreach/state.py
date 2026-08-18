#!/usr/bin/env python3
"""state.py — 投放账本的 Python 侧(与 state.mjs 同一套文件、同一套语义)。

node 侧(agent_submit.mjs)与 python 侧(mail_sweeper.py)共享这些文件:
  state.jsonl        每行 {src,status,note,ts} —— 当前态投影的追加日志
  events.jsonl       事件账本
  constraints.jsonl  站点约束(带 TTL)
  human_tasks.jsonl  人工任务(append 事件流,读取折叠)
  mail_seen.jsonl    邮件幂等认领日志(claim/done/release 折叠)
状态枚举与迁移守卫(DELIVERED 不许被打回 blocked/failed 等)与生产 dbw.js 逐条对齐,
口径见 state.mjs 文件头注释。所有写都是 append(O_APPEND 小写原子),读整文件折叠。
"""
import errno
import json
import os
import re
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
_sd = (os.environ.get("OUTREACH_STATE_DIR") or "").strip()
# 【修】相对路径原来跟 cwd 走,py 与 node 会落到两个账本(见 state.mjs 同处注释)
# 【修】Node 的 path.join 只做词法归一(不解析 symlink),Python 的 open 交给内核、
# 会跟随 symlink —— 同一个 OUTREACH_STATE_DIR 可能落到两个物理目录,两边看不见彼此。
# 统一成**词法归一**(与 Node 一致):normpath 消掉 `..`,但不 realpath 解 symlink。
DIR = os.path.normpath(HERE if not _sd else (_sd if os.path.isabs(_sd) else os.path.join(HERE, _sd)))
STATE_FILE = os.path.join(DIR, "state.jsonl")
EVENTS_FILE = os.path.join(DIR, "events.jsonl")
CONSTRAINTS_FILE = os.path.join(DIR, "constraints.jsonl")
HUMAN_TASKS_FILE = os.path.join(DIR, "human_tasks.jsonl")
MAIL_SEEN_FILE = os.path.join(DIR, "mail_seen.jsonl")

STATUSES = {
    "success", "pending_review", "emailed", "failed", "blocked",
    "skipped_paid", "skipped_badge", "skipped_fit", "draft",
    "delivery_ambiguous",
    "manual",           # 有验证码但未配打码 key,转人工(开源版新增)
    "email_verified",   # 验证信已点通(sweeper 写;非终态,域可重投)
}
DELIVERED = {"success", "pending_review", "emailed", "delivery_ambiguous"}
CONFIRMED_DELIVERED = {"success", "pending_review", "emailed"}
REGRESSIVE = {"blocked", "failed"}
AMBIGUOUS_UPGRADES = {"success", "pending_review", "emailed"}
AUTHORITATIVE_REASONS = {
    "rejected_by_site", "delisted", "manual", "mail_bounced", "badge_required",
}


def canon_domain(d):
    """域名规范化(与生产 canonDomain 同规则):去协议/路径/userinfo/端口/www/尾点。"""
    if not d:
        raise ValueError("state: domain 不能为空")
    s = str(d).strip().lower()
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", s)
    s = s.split("/")[0].split("?")[0].split("#")[0]
    s = s.split("@")[-1]
    s = re.sub(r":\d+$", "", s)
    s = re.sub(r"^www\.", "", s).rstrip(".")
    if not re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", s):
        raise ValueError(f"state: 域名不合法: {d}")
    return s


def now_utc():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())


def _clean(v, mx=2000):
    if v is None:
        return None
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", str(v))[:mx]


LOCK_STALE_SEC = 30
LOCK_WAIT_SEC = 8


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


def _mono():
    """单调时钟。墙钟会被 NTP 回拨/休眠破坏,超时上限就不成立了。"""
    return time.monotonic()


def with_file_lock(target, fn, wait_sec=LOCK_WAIT_SEC):
    """跨进程排他锁。**与 state.mjs 的 withFileLock 同一把锁文件、同一套语义**。

    【五修】两处改动,原因见 state.mjs 同名函数的注释:
      1. 先写临时文件再 os.link() 原子发布 —— 消除"O_EXCL 先建空文件、之后才写 owner"
         那个空窗(挂起在两步之间会被竞争者当无主锁接管);
      2. **删掉陈旧接管** —— 它要"读 owner→判死→移走"三步,而 POSIX 没有按 inode
         条件删除的原子操作,中间总能插进第三方(ABA)。做不对就别做:死进程留下的锁
         改为人工清理,错误信息直接给命令。
    "会不会重复投递"已不依赖这把锁(见 claim_delivery 的 O_EXCL 标记)。
    """
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    lock = target + ".lock"
    token = f"{os.getpid()}-{uuid.uuid4()}"
    body = f"{token} pid={os.getpid()} {now_utc()}\n"
    t0 = _mono()
    while True:
        tmp = f"{lock}.mk.{token}"
        try:
            with open(tmp, "w") as f:
                f.write(body)
            os.link(tmp, lock)              # 原子发布;已存在则 FileExistsError
            os.unlink(tmp)
        except FileExistsError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            try:
                owner = open(lock).read().strip()
            except OSError:
                continue                    # 刚被释放,下轮重来
            if _mono() - t0 > wait_sec:
                m = re.search(r"pid=(\d+)\b", owner)     # 严格解析,与 JS 侧同
                alive = _pid_alive(m.group(1)) if m else None
                hint = (f"  该进程已不存在 —— 是崩溃残留,确认没有别的进程在跑后删掉它:\n"
                        f"    rm {lock}") if alive is False else \
                       "  持有者仍在运行,等它做完;若确认是僵尸再手工删除"
                raise RuntimeError(
                    f"ledger locked: 账本锁等待超时({wait_sec}s)\n"
                    f"  锁文件 {lock}\n  持有者 {owner or '(读不到)'}\n{hint}")
            time.sleep(0.05)
            continue
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise                           # 目录不可写等真故障:原样抛,别热循环
        try:
            return fn()
        finally:
            try:
                with open(lock) as f:
                    if f.read().split(" ")[0] == token:
                        os.unlink(lock)
            except Exception:
                pass


def _append(file, obj):
    os.makedirs(DIR, exist_ok=True)
    with open(file, "a") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def _read_jsonl(file):
    """【修】原来只 catch FileNotFoundError 之外还有个隐患:权限/IO 错会冒到调用方,
    但调用方(current_status)没接 —— 与 JS 侧对齐:ENOENT 算空,其余原样抛,
    绝不把"读不到"当成"没有记录"(那会让认领闸 fail-open)。"""
    try:
        with open(file) as f:
            raw = f.read()
    except FileNotFoundError:
        return []
    except OSError as e:
        raise RuntimeError(f"账本读取失败({file}: {e.strerror}),fail-closed")
    # 【修】坏行原来静默跳过 —— 截断的 success 行会让 current_status 返回 None、
    # 认领随之放行。与 JS 侧同口径:只容忍"文件不以换行结尾"时的最后一行。
    ends_clean = raw.endswith("\n")
    lines = raw.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    out = []
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            # 【五修】不再容忍"末行半截"(见 state.mjs 同处):安全读在锁内发生,
            # 持久截断被当成"不存在"会直接放行认领。
            raise RuntimeError(
                f"账本第 {i + 1} 行损坏({file})"
                f"{'' if ends_clean else ',且文件以半行结尾'},fail-closed —— "
                f"修好或删掉这一行再跑")
    return out


def _row_key(src):
    """账本行的键归一(与 state.mjs 的 rowKey 同口径)。历史行不会自动迁移。"""
    try:
        return canon_domain(src)
    except ValueError:
        return str(src or "").lower()


def current_status(domain):
    """当前态投影:state.jsonl 里该域最后一行。

    【修】原来 `r.get("src") == dom`:查询侧 canon 了、行侧没有 —— 账本里躺着
    www.Example.com/success 时返回 None,认领闸随之放行。两侧都归一。
    """
    dom = _row_key(domain)
    cur = None
    for r in _read_jsonl(STATE_FILE):
        if _row_key(r.get("src")) == dom:
            cur = r
    return cur


def _blocks_transition(frm, status, force, reason_code):
    """显式迁移规则(与生产 dbw.js blocksTransition 逐条对齐)。"""
    if not frm or force or reason_code in AUTHORITATIVE_REASONS:
        return False
    if frm == "delivery_ambiguous":
        return status != "delivery_ambiguous" and status not in AMBIGUOUS_UPGRADES
    if frm in DELIVERED and status in REGRESSIVE:
        return True
    return frm in DELIVERED and status == "delivery_ambiguous"


def record_event(domain, event_type, prev_status=None, status=None,
                 reason_code=None, source="unknown", evidence=None):
    try:
        dom = canon_domain(domain)
    except ValueError:
        dom = str(domain or "unknown").lower()
    _append(EVENTS_FILE, {
        "domain": dom, "event_type": _clean(event_type, 40),
        "prev_status": prev_status, "status": status, "reason_code": reason_code,
        "source": _clean(source, 40),
        "evidence": _clean(evidence if isinstance(evidence, str) or evidence is None
                           else json.dumps(evidence, ensure_ascii=False), 4000),
        "ts": now_utc(),
    })


def _claim_marker(dom):
    return os.path.join(DIR, "claims", re.sub(r"[^a-z0-9.-]", "_", dom) + ".claim")


def _release_claim_if_reopened(dom, status):
    """状态合法离开投达态(如 email_verified 让域回池)时撤掉认领标记。
    与 state.mjs 的 releaseClaimIfReopened 同口径 —— 两边共用同一个 claims/ 目录。"""
    if status in DELIVERED:
        return
    try:
        os.unlink(_claim_marker(dom))
    except OSError:
        pass


def upsert_submission(domain, status, evidence="", note="",
                      source="unknown", reason_code=None, force=False):
    """写 state.jsonl 当前态 + 追加事件。
    返回 {written, from, to, blockedRegression}(与生产 dbw.upsertSubmission 同形)。"""
    dom = canon_domain(domain)
    if status not in STATUSES:
        raise ValueError(f"state: 未知 status: {status}")
    ev, nt = _clean(evidence, 2000), _clean(note, 600)

    # 【修】"读当前态 → 判守卫 → 追加"整段必须在锁内,且与 Node 侧共用同一把锁。
    # 不加锁的写会插到 claimDelivery 落的 delivery_ambiguous 之后把它顶掉,
    # 于是下一次认领又返回 claimed=true → 重复投递。
    def _txn():
        cur = current_status(dom)
        frm_ = cur["status"] if cur else None
        if _blocks_transition(frm_, status, force, reason_code):
            return frm_, True
        _append(STATE_FILE, {"src": dom, "status": status, "note": nt or "",
                             "evidence": ev, "ts": now_utc()})
        return frm_, False

    frm, blocked = with_file_lock(STATE_FILE, _txn)
    if blocked:
        record_event(dom, "note", prev_status=frm, status=frm,
                     reason_code="local_error", source=source,
                     evidence={"rejected_transition": f"{frm} -> {status}", "detail": ev})
        return {"written": False, "from": frm, "to": frm, "blockedRegression": True}
    record_event(dom, "attempt_end" if frm == status else "status_change",
                 prev_status=frm, status=status, reason_code=reason_code,
                 source=source, evidence={"evidence": ev, "note": nt})
    _release_claim_if_reopened(dom, status)
    return {"written": True, "from": frm, "to": status, "blockedRegression": False}


# ---------- 站点约束 ----------
def add_constraint(domain, reason_code, evidence=None, ttl_days=30):
    exp = None if ttl_days is None else time.strftime(
        "%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + ttl_days * 86400))
    _append(CONSTRAINTS_FILE, {
        "domain": canon_domain(domain), "reason_code": _clean(reason_code, 40),
        "evidence": _clean(evidence, 500), "observed_at": now_utc(), "expires_at": exp,
    })


def active_constraints(domain):
    try:
        dom = canon_domain(domain)
    except ValueError:
        return []
    latest = {}
    for r in _read_jsonl(CONSTRAINTS_FILE):
        if r.get("domain") == dom:
            latest[r.get("reason_code")] = r
    now = now_utc()
    return [c for c in latest.values() if not c.get("expires_at") or c["expires_at"] > now]


# ---------- 人工任务(append 事件流,读取折叠)----------
def human_task_add(domain, url="", blocker="", guidance="", payload=None):
    dom = canon_domain(domain)
    max_id = 0
    for r in _read_jsonl(HUMAN_TASKS_FILE):
        if r.get("id") and r["id"] > max_id:
            max_id = r["id"]
    tid = max_id + 1
    _append(HUMAN_TASKS_FILE, {
        "id": tid, "domain": dom, "url": _clean(url, 500),
        "blocker": _clean(blocker, 60), "guidance": _clean(guidance, 600),
        "payload": _clean(payload, 4000), "status": "pending", "ts": now_utc(),
    })
    return {"id": tid, "queued": True}


# ---------- 邮件幂等(mail_seen.jsonl:claim/done/release 折叠)----------
CLAIM_TTL = 900     # 认领 900s 未完成自动释放(进程崩溃兜底)

def _mail_fold():
    done, claimed, domains = {}, {}, {}
    for r in _read_jsonl(MAIL_SEEN_FILE):
        mid, ev = r.get("mid"), r.get("event")
        if r.get("domain"):
            domains[mid] = r["domain"]        # claim/set_domain/done 都可更新归属
        if ev == "claim":
            claimed[mid] = r
        elif ev == "done":
            if not r.get("domain") and domains.get(mid):
                r["domain"] = domains[mid]    # 继承认领/归属时记下的域
            done[mid] = r
            claimed.pop(mid, None)
        elif ev == "release":
            claimed.pop(mid, None)
    return done, claimed


def mail_claim(mid, worker, domain=None):
    """认领一封待处理的信。已 done / 别人正在处理(未超 TTL)→ False。"""
    done, claimed = _mail_fold()
    if mid in done:
        return False
    c = claimed.get(mid)
    if c and time.time() - float(c.get("epoch", 0)) < CLAIM_TTL:
        return False
    _append(MAIL_SEEN_FILE, {"mid": mid, "event": "claim", "worker": worker,
                             "domain": domain, "epoch": time.time(), "ts": now_utc()})
    return True


def mail_set_domain(mid, domain):
    """归属落库:这封信对应的站(LLM 判出后发件人域之外的修正也走这)。
    等待器(sweep_for)的水位线按这个域过滤。"""
    try:
        domain = canon_domain(domain)
    except ValueError:
        pass
    _append(MAIL_SEEN_FILE, {"mid": mid, "event": "set_domain", "domain": domain,
                             "epoch": time.time(), "ts": now_utc()})


def mail_done(mid, domain=None):
    _append(MAIL_SEEN_FILE, {"mid": mid, "event": "done", "domain": domain,
                             "epoch": time.time(), "ts": now_utc()})


def mail_release(mid, note=""):
    _append(MAIL_SEEN_FILE, {"mid": mid, "event": "release", "note": _clean(note, 200),
                             "epoch": time.time(), "ts": now_utc()})


def mail_is_done(mid):
    done, _ = _mail_fold()
    return mid in done


def mail_recent_done(domain, within_sec=900):
    """该域最近 within_sec 内被处理完的信封数(sweep_for 的水位线)。"""
    try:
        dom = canon_domain(domain)
    except ValueError:
        dom = str(domain or "").lower()
    done, _ = _mail_fold()
    t0 = time.time() - within_sec
    return sum(1 for r in done.values()
               if r.get("domain") == dom and float(r.get("epoch", 0)) >= t0)


def mail_done_max_epoch():
    """水位线基线:已处理完的信里最大的 epoch(对应生产 mail_done_max_rowid)。"""
    done, _ = _mail_fold()
    return max((float(r.get("epoch", 0)) for r in done.values()), default=0.0)


def mail_done_since(domain, base_epoch):
    """base_epoch 之后处理完的、归属该域的信封数(对应生产 rowid 水位线 COUNT)。"""
    try:
        dom = canon_domain(domain)
    except ValueError:
        dom = str(domain or "").lower()
    done, _ = _mail_fold()
    return sum(1 for r in done.values()
               if r.get("domain") == dom and float(r.get("epoch", 0)) > float(base_epoch))
