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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 【修】相对路径原来跟 cwd 走 —— driver 以 cwd=outreach 启动 node,而 driver 自己
// 可能从仓库根跑,同一个环境变量于是落到两个不同的账本,投达态互相看不见。
// 空串当未设,相对路径一律锚到 outreach/(与 llm_config 的 resolvePath 同口径)。
const _sd = String(process.env.OUTREACH_STATE_DIR || '').trim();
const DIR = !_sd ? HERE : (path.isAbsolute(_sd) ? _sd : path.join(HERE, _sd));
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

/** 宽容读:读不到当空。只给"没有也无所谓"的场景用(事件/约束枚举)。 */
function readJsonl(file) {
  try { return parseJsonl(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`账本读取失败(${file}: ${e.code || e.message}),fail-closed`);
  }
}

/** 【修】原实现 `catch { return [] }` 吞掉一切读失败 —— 账本只写不可读(权限/IO)时
 *  currentStatus 返回 null,claimDelivery 于是放行,**唯一的防重复投递闸直接 fail-open**
 *  (实测:已有 success 的账本 chmod 200 后仍返回 claimed:true)。
 *  现在只有 ENOENT(还没开张)算空,其余原样抛给调用方。 */
function parseJsonl(raw) {
  return raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** 当前态投影:state.jsonl 里该域最后一行(写入端有守卫,投影即终态)。 */
/** 账本行的键归一。**必须与写入端同口径** —— 历史行(老 driver 写的 www.Example.com)
 *  不会自动迁移,拿 canon 键去精确比就永远匹配不上。 */
function rowKey(src) {
  try { return canonDomain(src); } catch { return String(src || '').toLowerCase(); }
}

export function currentStatus(domain) {
  const dom = rowKey(domain);
  let cur = null;
  // 【修】原来 `r.src === dom`:查询侧 canon 了、行侧没有 —— 账本里躺着
  // www.Example.com/success 时,currentStatus('example.com') 返回 null,
  // claimDelivery 于是返回 claimed:true → 重复 POST(实测复现)。
  // R5 只修了 driver 的选池,直接跑 agent 仍会中招。这里是根:两侧都归一。
  for (const r of readJsonl(STATE_FILE)) if (rowKey(r.src) === dom) cur = r;
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
  // 【修】"读当前态 → 判守卫 → 追加"必须整段在锁内。原来只有 claimDelivery 加了锁,
  // 而 upsertSubmission 不加 —— 两者写的是**同一个投影**(最后一行为准),一次交错就能
  // 让 blocked 落在 delivery_ambiguous 之后,守卫看不见、认领态被顶掉,下次 claimDelivery
  // 又返回 claimed=true → 重复 POST(Codex 复现的 ambiguous→blocked→ambiguous 序列)。
  const guard = withFileLock(STATE_FILE, () => {
    const cur = currentStatus(dom);
    const f = cur ? cur.status : null;
    if (blocksTransition(f, status, force, reason_code)) return { from: f, blocked: true };
    append(STATE_FILE, { src: dom, status, note: nt || '', evidence: ev, ts: nowUtc() });
    return { from: f, blocked: false };
  });
  const from = guard.from;

  if (guard.blocked) {
    recordEvent({
      domain: dom, event_type: 'note', prev_status: from, status: from,
      reason_code: 'local_error', source,
      evidence: { rejected_transition: `${from} -> ${status}`, detail: ev },
    });
    return { written: false, from, to: from, blockedRegression: true };
  }

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
  // 【修】原实现是无锁的"先查后追加":两个进程在 currentStatus() 与 append() 之间
  // 交错,就会**都拿到 claimed=true** —— 实测 10 进程同时刻认领同一域,7 个都成功。
  // 这是全系统防重复投递的**唯一**闸(只有 claimed=true 才允许对外 click/POST),
  // 它一破,single-shot 教义就是空的。查与写必须在同一把锁内完成。
  const { from, claimed } = withFileLock(STATE_FILE, () => {
    const cur = currentStatus(dom);
    const f = cur ? cur.status : null;
    if (f && DELIVERED.has(f)) return { from: f, claimed: false };
    append(STATE_FILE, { src: dom, status: 'delivery_ambiguous', note: nt || '', evidence: ev, ts: nowUtc() });
    return { from: f, claimed: true };
  });
  if (!claimed) return { claimed: false, from, to: from };

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

/** 日预算熔断:今天某 provider 已花多少。账本不可读 = fail-closed 抛错。
 *
 * 【修】原实现 try 的是 readJsonl —— 而它自己 `catch { return [] }` 吞掉一切错误,
 * 这里的 catch 永远不可能进。于是账本 EACCES/EIO/被写坏时返回 0,
 * capsolver 两个付费入口看到"今天没花钱"照常放行:注释写着 fail-closed,
 * 实际是 fail-open,熔断在最该生效的时候静默失效。
 * 现在自己读文件:ENOENT(还没花过钱)返回 0,其余原样抛给调用方按基建故障处理。
 */
export function spentToday(provider) {
  let raw;
  try { raw = fs.readFileSync(COSTS_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw new Error(`成本账本读取失败(${String(e.message).slice(0, 60)}),fail-closed`);
  }
  const today = nowUtc().slice(0, 10);
  // 【二修】原来 split+filter(Boolean) 会把结尾换行产生的空元素滤掉,于是一条
  // **完整的坏行**(末尾带 \n)也成了"最后一行",被当成 append 半截写入放过。
  // 现在只有"文件不以换行结尾"时,最后一行才可能是半截。
  const endsClean = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let sum = 0;
  for (let i = 0; i < lines.length; i++) {
    let r;
    try { r = JSON.parse(lines[i]); }
    catch {
      // 【修】原来坏行直接跳过、非法金额 `|| 0` 吞掉 —— 账本损坏时**少算花销**,
      // 熔断照样放行,fail-closed 又一次名存实亡。少算 = 多花钱,必须抛。
      // 例外:只有最后一行可以是写到一半的半截行(append 的固有竞态),跳过它。
      if (!endsClean && i === lines.length - 1) continue;
      throw new Error(`成本账本第 ${i + 1} 行损坏(非最后一行,不是写入竞态),fail-closed`);
    }
    if (!r || r.provider !== provider || !String(r.ts || '').startsWith(today)) continue;
    // null/undefined/缺字段 → Number() 给 0 或 NaN,原来 null 就这么静默按 0 计
    if (r.amount_usd === null || r.amount_usd === undefined) {
      throw new Error(`成本账本第 ${i + 1} 行缺 amount_usd,fail-closed`);
    }
    const amt = Number(r.amount_usd);
    if (!Number.isFinite(amt) || amt < 0) {
      throw new Error(`成本账本第 ${i + 1} 行金额非法(${JSON.stringify(r.amount_usd)}),fail-closed`);
    }
    sum += amt;
  }
  return sum;
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
  // 【修】读→改→整文件覆写:两个 agent 并发给不同站沉淀 recipe 时,后写的会把
  // 先写的那条抹掉且无声。creds.mjs 为**完全相同**的模式做足了排他锁(见它文件头
  // "为什么需要锁"),这里一直裸跑 —— 同一个仓里同一个坑,修法照抄那份。
  // driver 串行调 agent,今天撞不上;但 recipe 是"成功打法"的沉淀,丢了要重新探路。
  withFileLock(RECIPES_FILE, () => {
    const tmp = `${RECIPES_FILE}.tmp.${process.pid}`;
    let all = {};
    try { all = JSON.parse(fs.readFileSync(RECIPES_FILE, 'utf8')); } catch {}
    all[canonDomain(domain)] = {
      recipe, steps_count: recipe.length, proven_at: nowUtc(),
      status: String(status), notes: String(notes || ''),
    };
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
    fs.renameSync(tmp, RECIPES_FILE);   // 同盘 rename 原子
  });
}

/** 排他锁(O_EXCL + 陈旧接管),语义与 creds.mjs 的 acquire/release 一致。
 *  用在两处:saveRecipe 的整文件覆写、claimDelivery 的"查当前态→追加认领行"。
 *  后者是防重复投递的核心闸,查与写必须原子。函数声明有提升,调用点在定义之前无碍。 */
export function withFileLock(target, fn, waitMs = 8000) {
  fs.mkdirSync(path.dirname(target), { recursive: true });   // 【修】新 DIR 首次用会 ENOENT
  const lock = `${target}.lock`;
  const t0 = Date.now();
  for (;;) {
    let token;
    try {
      token = `${process.pid}-${crypto.randomUUID()}`;
      const fd = fs.openSync(lock, 'wx');       // O_CREAT|O_EXCL
      fs.writeSync(fd, `${token} ${nowUtc()}\n`);
      fs.closeSync(fd);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 【修】陈旧接管原来是直接 unlink:两个等待者可能都判超时、都 unlink、都拿到锁。
      // 照 creds.mjs 的手法 —— rename 成只有自己知道的名字,**改名成功的那个才算抢到**,
      // 由它删掉墓碑;抢输的回到循环重试。
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
          const grave = `${lock}.stale.${crypto.randomUUID()}`;
          try { fs.renameSync(lock, grave); fs.unlinkSync(grave); } catch { /* 抢输 */ }
          continue;
        }
      } catch { continue; }                      // 锁刚被释放,下轮就能抢到
      // 【修】调用方(agent_submit 的 upsert/claimDelivery)按 /locked|busy/ 匹配才重试,
      // 原来的中文文案对不上 → 声明的 6 次重试实际一次都不会发生。带上英文关键词。
      if (Date.now() - t0 > waitMs) {
        const e = new Error(`ledger locked: 账本锁等待超时(${waitMs}ms):${lock}`);
        e.lockTimeout = true;
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      continue;
    }
    try { return fn(); }
    finally {
      // 【修】原来"读 token → unlink"分两步:中间锁若被陈旧接管、别人已建新锁,
      // 这一 unlink 删的就是**别人的**锁,第三个 writer 于是能并发进来。
      // 改成先 rename 到自己的私名(原子),确认 rename 到的内容确实是自己的再删;
      // rename 失败(锁已不是我的/已被接管)就什么都不做。
      const mine = `${lock}.rel.${token}`;
      try {
        fs.renameSync(lock, mine);
        if (fs.readFileSync(mine, 'utf8').split(' ')[0] === token) fs.unlinkSync(mine);
        else fs.renameSync(mine, lock);          // 不是我的,原样放回
      } catch { /* 锁已被接管或已释放 */ }
    }
  }
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
  return readJsonl(STATE_FILE).filter(r => rowKey(r.src) === dom);
}

/** 当前态落在 statuses 里的全部域名(--pending 的待核清单)。 */
export function domainsWithStatus(statuses) {
  const want = statuses instanceof Set ? statuses : new Set(statuses);
  const latest = new Map();
  for (const r of readJsonl(STATE_FILE)) if (r.src) latest.set(rowKey(r.src), r.status);
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
  return readJsonl(VERIFICATIONS_FILE).filter(r => rowKey(r.domain) === dom);
}

/** 有过 online 核验记录的全部域名(--known 的复核清单,查掉链)。 */
export function knownOnlineDomains() {
  const doms = new Set();
  for (const r of readJsonl(VERIFICATIONS_FILE)) {
    if (r.result === 'online' && r.domain) doms.add(r.domain);
  }
  return [...doms].sort();
}
