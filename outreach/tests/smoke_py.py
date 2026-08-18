#!/usr/bin/env python3
"""Python 侧关键路径冒烟(被 smoke.sh 调用)。见 smoke.sh 顶部注释。"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
D = os.environ["OUTREACH_STATE_DIR"]
res = []
def t(name, fn):
    try:
        fn(); res.append((True, name, ""))
    except Exception as e:
        res.append((False, name, f"{type(e).__name__}: {e}"))

import state, dbwpy, llm_config, check_llm, read_otp  # noqa: E402

t("upsert_submission",       lambda: state.upsert_submission("a.com", "pending_review", source="s"))
t("current_status",          lambda: state.current_status("a.com")["status"])
t("守卫拦截",                 lambda: state.upsert_submission("a.com", "blocked", source="s")["blockedRegression"])
t("历史 raw 键归一",           lambda: state.current_status("WWW.A.com")["status"])
t("record_event",            lambda: state.record_event("a.com", "note", source="s"))
t("add/active_constraints",  lambda: (state.add_constraint("a.com", "entry_404"), state.active_constraints("a.com")))
t("human_task_add",          lambda: state.human_task_add("a.com", blocker="x"))
t("mail_claim/done/release", lambda: (state.mail_claim("m1", "w"), state.mail_done("m1"), state.mail_release("m2")))
t("mail_is_done",            lambda: state.mail_is_done("m1"))
t("mail_recent_done",        lambda: state.mail_recent_done("a.com"))
t("mail_done_since",         lambda: state.mail_done_since("a.com", 0))
t("canon_domain",            lambda: state.canon_domain("WWW.A.com"))
t("with_file_lock",          lambda: state.with_file_lock(D + "/x", lambda: 1))
t("dbwpy known_sites",       lambda: dbwpy.conn().execute("SELECT domain FROM submissions UNION SELECT domain FROM submit_friendly").fetchall())
t("dbwpy v2_has",            lambda: dbwpy.conn().execute("SELECT 1 FROM submissions WHERE domain=? OR domain LIKE ? LIMIT 1", ("a.com", "%.a.com")).fetchone())
t("dbwpy product_for_site",  lambda: dbwpy.conn().execute("SELECT product_id, MAX(COALESCE(updated_at, submitted_at)) t FROM submissions WHERE domain=? OR domain LIKE ? GROUP BY product_id ORDER BY t DESC", ("a.com", "%.a.com")).fetchall())
t("dbwpy products",          lambda: dbwpy.conn().execute("SELECT id, url FROM products").fetchall())
t("dbwpy status 查询",        lambda: dbwpy.conn().execute("SELECT status FROM submissions WHERE domain=? AND product_id=?", ("a.com", 1)).fetchone())
t("dbwpy human_tasks 写",     lambda: dbwpy.conn().execute("INSERT INTO human_tasks (product_id, domain, url, blocker, guidance, status, created_at, kind) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), 'mail')", (1, "a.com", "", "b", "g")))
t("dbwpy w_retry",           lambda: dbwpy.w_retry("UPDATE submit_friendly SET email_verification='done' WHERE domain=?", ("a.com",)))
t("dbwpy migrate_key",       lambda: dbwpy.migrate_domain_key(domain="www.A.com"))
t("dbwpy mail_wait",         lambda: (dbwpy.mail_wait_register("a.com", "2030-01-01 00:00:00", 1), dbwpy.mail_waiting_now(), dbwpy.mail_wait_clear("a.com")))
t("llm_config.load",         lambda: llm_config.load())
t("llm_config.chat_url",     lambda: llm_config.chat_url("https://x.com"))
t("llm_config.origin_of",    lambda: llm_config.origin_of("https://x.com/v1"))
t("llm_config.mask",         lambda: llm_config.mask("sk-abcdefghijklmn"))
t("read_otp._matches",       lambda: read_otp._matches("a.com", "x@a.com", "s"))
t("check_llm.probe(离线)",    lambda: check_llm.probe("http://127.0.0.1:1/v1/chat/completions", "k", "m"))

bad = [r for r in res if not r[0]]
for good, name, err in res:
    if not good:
        print(f"   ❌ {name} → {err}")
print(f"   {len(res) - len(bad)}/{len(res)} 通过" + (" ✅" if not bad else ""))
sys.exit(1 if bad else 0)
