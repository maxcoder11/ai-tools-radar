// state.mjs — 投放账本(state.jsonl),开源版 dbw 替代(2026-08-16 移植)
//
// 生产侧(backlinks-v2/node-tools/dbw.js)是 node:sqlite 写库层;开源版没有私有 DB,
// 用一组 JSONL/JSON 文件实现**同一套语义**:
//   - 状态枚举与迁移守卫(投达态不许被辅助步骤异常打回 blocked/failed)逐条对齐;
//   - 每次写入同时追加事件账本(events.jsonl),state.jsonl 是当前态投影的追加日志;
//   - 投递认领(claimDelivery)/delivery_ambiguous 终态/人工任务折叠语义保留。
//
// 文件布局(均在 outreach/ 下,全部被 .gitignore):
//   state.jsonl        每行 {src,status,note,ts} —— 与 targets.py/driver.py 兼容的投影日志
//   events.jsonl       事件账本(status_change/attempt_end/note)
//   costs.jsonl        成本台账(LLM/打码),spentToday 日预算熔断读它
//   constraints.jsonl  站点约束(带 TTL),activeConstraints 折叠后过滤过期
//   human_tasks.jsonl  人工任务(append 事件流,读取时折叠 pending/done)
//   recipes.json       站点 recipe 缓存(成功打法沉淀,原子写)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.OUTREACH_STATE_DIR || HERE;
export const STATE_FILE = path.join(DIR, 'state.jsonl');
const EVENTS_FILE = path.join(DIR, 'events.jsonl');
const COSTS_FILE = path.join(DIR, 'costs.jsonl');
const CONSTRAINTS_FILE = path.join(DIR, 'constraints.jsonl');
const HUMAN_TASKS_FILE = path.join(DIR, 'human_tasks.jsonl');
const RECIPES_FILE = path.join(DIR, 'recipes.json');

// 与生产 dbw.BUSY_TIMEOUT_MS 同值:看门狗预算计算要用它( JSONL 无真锁,仅为口径保留)。
export const BUSY_TIMEOUT_MS = 30_000;

// ---------- 状态枚举与迁移守卫(与生产 dbw.js 逐条对齐)----------
export const STATUSES = new Set([
  'success', 'pending_review', 'emailed', 'failed', 'blocked',
  'skipped_paid', 'skipped_badge', 'skipped_fit', 'draft',
  'delivery_ambiguous',
  // 开源版新增:有验证码但未配置打码 key,转人工队列(不硬刚)。
  // 非投达态、非倒退态,不参与守卫矩阵。
  'manual',
]);

// 已经真正投出去的状态。一旦进入,辅助步骤(存 recipe、截图、自验证)出的异常
// 不许把它打回 blocked/failed —— 那是"没投出去"的语义,会污染漏斗分母。
export const DELIVERED = new Set(['success', 'pending_review', 'emailed', 'delivery_ambiguous']);
export const CONFIRMED_DELIVERED = new Set(['success', 'pending_review', 'emailed']);
const REGRESSIVE = new Set(['blocked', 'failed']);
const AMBIGUOUS_UPGRADES = new Set(['success', 'pending_review', 'emailed']);
export const AUTHORITATIVE_REASONS = new Set([
  'rejected_by_site', 'delisted', 'manual', 'mail_bounced', 'badge_required',
]);

export const REASON_CODES = new Set([
  'cf_challenge', 'captcha_unsolvable', 'login_wall', 'oauth_only', 'entry_404',
  'no_form', 'network_error', 'budget_exceeded', 'site_5xx', 'local_error',
  'site_acknowledged', 'awaiting_review', 'rejected_by_site', 'badge_required',
  'published', 'delisted',
  'paid_wall', 'fit_mismatch', 'graveyard', 'constraint_active',
  'account_per_product', 'mail_channel_dead', 'mail_bounced',
  'graveyard_closed', 'manual', 'human_assist', 'unknown',
]);

/** 去掉 NUL 和控制字符(保留 \n \t),截断。 */
export function clean(v, max = 2000) {
  if (v === null || v === undefined) return null;
  return String(v)
    .replace(/\u0000/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .slice(0, max);
}

/** 域名规范化(与生产 canonDomain 同规则):去协议/路径/userinfo/端口/www/尾点。 */
export function canonDomain(d) {
  if (!d) throw new Error('state: domain 不能为空');
  let s = String(d).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.split('@').pop();
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^www\./, '').replace(/\.+$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) throw new Error(`state: 域名不合法: ${d}`);
  return s;
}

/** 统一 UTC 时间戳 'YYYY-MM-DD HH:MM:SS'(与 sqlite datetime() 同格式)。 */
export function nowUtc() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// ---------- 追加日志原语 ----------
function append(file, obj) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** 当前态投影:state.jsonl 里该域最后一行(写入端有守卫,投影即终态)。 */
export function currentStatus(domain) {
  let dom;
  try { dom = canonDomain(domain); } catch { dom = String(domain || '').toLowerCase(); }
  let cur = null;
  for (const r of readJsonl(STATE_FILE)) if (r.src === dom) cur = r;
  return cur;
}

/** 双 writer 共用的显式迁移规则;true 表示必须拒绝并保留原状态。 */
function blocksTransition(from, status, force, reasonCode) {
  if (!from || force || AUTHORITATIVE_REASONS.has(reasonCode)) return false;
  if (from === 'delivery_ambiguous') {
    return status !== 'delivery_ambiguous' && !AMBIGUOUS_UPGRADES.has(status);
  }
  if (DELIVERED.has(from) && REGRESSIVE.has(status)) return true;
  return DELIVERED.has(from) && status === 'delivery_ambiguous';
}

// ---------- 事件账本 ----------
export function recordEvent({
  domain, event_type, prev_status = null, status = null,
  reason_code = null, source = 'unknown', evidence = null,
}) {
  let dom;
  try { dom = canonDomain(domain); } catch { dom = String(domain || 'unknown').toLowerCase(); }
  if (reason_code && !REASON_CODES.has(reason_code)) reason_code = 'unknown';
  append(EVENTS_FILE, {
    domain: dom, event_type: clean(event_type, 40), prev_status, status, reason_code,
    source: clean(source, 40),
    evidence: evidence == null ? null : clean(typeof evidence === 'string' ? evidence : JSON.stringify(evidence), 4000),
    ts: nowUtc(),
  });
}

// ---------- 主写入口 ----------
/**
 * 写 state.jsonl 当前态 + 追加事件。
 * @returns {{written:boolean, from:string|null, to:string, blockedRegression:boolean}}
 */
export function upsertSubmission({
  domain, status, evidence = '', note = '',
  source = 'unknown', reason_code = null, force = false,
}) {
  const dom = canonDomain(domain);
  if (!STATUSES.has(status)) throw new Error(`state: 未知 status: ${status}`);
  const ev = clean(evidence, 2000);
  const nt = clean(note, 600);
  const cur = currentStatus(dom);
  const from = cur ? cur.status : null;

  if (blocksTransition(from, status, force, reason_code)) {
    recordEvent({
      domain: dom, event_type: 'note', prev_status: from, status: from,
      reason_code: 'local_error', source,
      evidence: { rejected_transition: `${from} -> ${status}`, detail: ev },
    });
    return { written: false, from, to: from, blockedRegression: true };
  }

  append(STATE_FILE, { src: dom, status, note: nt || '', evidence: ev, ts: nowUtc() });
  recordEvent({
    domain: dom,
    event_type: from === status ? 'attempt_end' : 'status_change',
    prev_status: from, status, reason_code, source,
    evidence: { evidence: ev, note: nt },
  });
  // 状态升级到确认投达时,关闭遗留的 ambiguous 人工任务(同事务语义 → 同一写路径内)
  closeDeliveryAmbiguousTasks(dom, status);
  return { written: true, from, to: status, blockedRegression: false };
}

/**
 * 原子认领一次真实提交派发。只有 claimed=true 的调用方才可对外 click/POST。
 * @returns {{claimed:boolean, from:string|null, to:string|null}}
 */
export function claimDelivery({
  domain, evidence = '', note = '', source = 'unknown', reason_code = 'unknown',
}) {
  const dom = canonDomain(domain);
  const ev = clean(evidence, 2000);
  const nt = clean(note, 600);
  const cur = currentStatus(dom);
  const from = cur ? cur.status : null;
  if (from && DELIVERED.has(from)) return { claimed: false, from, to: from };

  append(STATE_FILE, { src: dom, status: 'delivery_ambiguous', note: nt || '', evidence: ev, ts: nowUtc() });
  recordEvent({
    domain: dom,
    event_type: from === 'delivery_ambiguous' ? 'attempt_end' : 'status_change',
    prev_status: from, status: 'delivery_ambiguous', reason_code, source,
    evidence: { evidence: ev, note: nt },
  });
  return { claimed: true, from, to: 'delivery_ambiguous' };
}

// ---------- 人工任务(append 事件流,读取折叠)----------
function foldHumanTasks() {
  const open = new Map();   // key `${domain}|${blocker}` → task
  let maxId = 0;
  for (const r of readJsonl(HUMAN_TASKS_FILE)) {
    if (r.id && r.id > maxId) maxId = r.id;
    if (r.event === 'close') {
      // 关闭指定域+blocker 的 pending 任务
      for (const [k, t] of open) {
        if (t.domain === r.domain && (!r.blocker || t.blocker === r.blocker)) open.delete(k);
      }
      continue;
    }
    open.set(`${r.domain}|${r.blocker}`, r);
  }
  return { pending: [...open.values()], maxId };
}

export function humanTaskAdd({ domain, url = '', blocker, guidance = '', payload = null }) {
  const dom = canonDomain(domain);
  const { maxId } = foldHumanTasks();
  const id = maxId + 1;
  append(HUMAN_TASKS_FILE, {
    id, domain: dom, url: clean(url, 500), blocker: clean(blocker, 60),
    guidance: clean(guidance, 600), payload: clean(payload, 4000),
    status: 'pending', ts: nowUtc(),
  });
  return { id, queued: true };
}

/** 仅当总账终态仍 ambiguous 且无同类 pending 任务时,幂等创建人工任务。 */
export function ensureDeliveryAmbiguousTask({ domain, url = '', guidance = '', payload = null }) {
  const dom = canonDomain(domain);
  const cur = currentStatus(dom);
  if (!cur || cur.status !== 'delivery_ambiguous') return { queued: false, id: null };
  const { pending } = foldHumanTasks();
  const existing = pending.find(t => t.domain === dom && t.blocker === 'delivery_ambiguous');
  if (existing) return { queued: false, id: existing.id };
  return humanTaskAdd({ domain: dom, url, blocker: 'delivery_ambiguous', guidance, payload });
}

/** 已确认投达后,关闭遗留的 ambiguous 人工任务。 */
function closeDeliveryAmbiguousTasks(domain, status) {
  if (!CONFIRMED_DELIVERED.has(status)) return 0;
  const { pending } = foldHumanTasks();
  const hit = pending.filter(t => t.domain === domain && t.blocker === 'delivery_ambiguous');
  for (const _ of hit) {
    append(HUMAN_TASKS_FILE, { event: 'close', domain, blocker: 'delivery_ambiguous', status, ts: nowUtc() });
  }
  return hit.length;
}

/** 给驱动/盘点用:列出当前 pending 人工任务。 */
export function pendingHumanTasks() { return foldHumanTasks().pending; }

// ---------- 成本 ----------
export function recordCost({ provider, job = null, domain = null,
                             quantity = 1, unit_cost_usd = null, amount_usd, is_actual = 0, note = null }) {
  append(COSTS_FILE, {
    provider: clean(provider, 40), job: clean(job, 80),
    domain: domain ? canonDomain(domain) : null, quantity, unit_cost_usd,
    amount_usd, is_actual: is_actual ? 1 : 0, note: clean(note, 300), ts: nowUtc(),
  });
}

/** 日预算熔断:今天某 provider 已花多少。账本不可读 = fail-closed 抛错。 */
export function spentToday(provider) {
  let rows;
  try { rows = readJsonl(COSTS_FILE); }
  catch (e) { throw new Error(`成本账本读取失败(${String(e.message).slice(0, 60)}),fail-closed`); }
  const today = nowUtc().slice(0, 10);
  return rows.filter(r => r.provider === provider && String(r.ts || '').startsWith(today))
    .reduce((s, r) => s + (Number(r.amount_usd) || 0), 0);
}

// ---------- 站点约束(带 TTL 的 append 日志,读取折叠:同 (domain,reason_code) 后者盖前者)----------
export function activeConstraints(domain) {
  let dom;
  try { dom = canonDomain(domain); } catch { return []; }
  const latest = new Map();
  for (const r of readJsonl(CONSTRAINTS_FILE)) {
    if (r.domain === dom) latest.set(r.reason_code, r);
  }
  const now = nowUtc();
  return [...latest.values()].filter(c => !c.expires_at || c.expires_at > now)
    .map(c => ({ reason_code: c.reason_code, evidence: c.evidence,
                 observed_at: c.observed_at, expires_at: c.expires_at }));
}

export function addConstraint({ domain, reason_code, evidence = null, ttl_days = 30 }) {
  const exp = ttl_days == null ? null
    : new Date(Date.now() + ttl_days * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  append(CONSTRAINTS_FILE, {
    domain: canonDomain(domain), reason_code: clean(reason_code, 40),
    evidence: clean(evidence, 500), observed_at: nowUtc(), expires_at: exp,
  });
}

// ---------- 站点 recipe(成功打法沉淀,原子写 JSON map)----------
export function loadRecipe(domain) {
  try {
    const all = JSON.parse(fs.readFileSync(RECIPES_FILE, 'utf8'));
    const row = all[canonDomain(domain)];
    if (!row || !row.recipe) return null;
    if (row.status === 'negative') return null;   // 死路记号,不许快放
    return row.recipe;
  } catch { return null; }
}

export function saveRecipe(domain, recipe, status, notes) {
  const tmp = `${RECIPES_FILE}.tmp.${process.pid}`;
  let all = {};
  try { all = JSON.parse(fs.readFileSync(RECIPES_FILE, 'utf8')); } catch {}
  all[canonDomain(domain)] = {
    recipe, steps_count: recipe.length, proven_at: nowUtc(),
    status: String(status), notes: String(notes || ''),
  };
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
  fs.renameSync(tmp, RECIPES_FILE);   // 同盘 rename 原子
}

// ---------- 终核(verify_link.mjs 用)----------
// verifications.jsonl:每次核验一行(三态结果 + SEO 价值字段),对应生产的
// verification_runs 表;"已知链"(--known 复核)就从这个日志里折叠。
const VERIFICATIONS_FILE = path.join(DIR, 'verifications.jsonl');
const VERIFY_RESULTS = new Set(['online', 'offline_confirmed', 'unknown_network', 'unknown_blocked']);

/** 该域的 state.jsonl 全部行(按写入顺序),终核器从 evidence/note 里抠历史收录页 URL。 */
export function stateRows(domain) {
  let dom;
  try { dom = canonDomain(domain); } catch { return []; }
  return readJsonl(STATE_FILE).filter(r => r.src === dom);
}

/** 当前态落在 statuses 里的全部域名(--pending 的待核清单)。 */
export function domainsWithStatus(statuses) {
  const want = statuses instanceof Set ? statuses : new Set(statuses);
  const latest = new Map();
  for (const r of readJsonl(STATE_FILE)) if (r.src) latest.set(r.src, r.status);
  return [...latest.entries()].filter(([, s]) => want.has(s)).map(([d]) => d).sort();
}

/** 记一次核验。result 必须是三态之一;只追加日志,不动任何状态(状态归 --update-status 管)。 */
export function recordVerification({ domain, result, ...rest }) {
  if (!VERIFY_RESULTS.has(result)) throw new Error(`state: 未知核验结果: ${result}`);
  append(VERIFICATIONS_FILE, {
    domain: canonDomain(domain), result, ...rest, ts: nowUtc(),
  });
}

/** 该域的全部核验记录(按写入顺序),终核器从里面取历史 online 的 source_url。 */
export function verificationRows(domain) {
  let dom;
  try { dom = canonDomain(domain); } catch { return []; }
  return readJsonl(VERIFICATIONS_FILE).filter(r => r.domain === dom);
}

/** 有过 online 核验记录的全部域名(--known 的复核清单,查掉链)。 */
export function knownOnlineDomains() {
  const doms = new Set();
  for (const r of readJsonl(VERIFICATIONS_FILE)) {
    if (r.result === 'online' && r.domain) doms.add(r.domain);
  }
  return [...doms].sort();
}
