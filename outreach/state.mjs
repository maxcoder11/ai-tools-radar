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
  // 【修】py 侧 STATUSES 一直有它,js 侧没有 —— 同一个状态 Python 写得进、Node 直接
  // 抛"未知 status",合法回池路径(sweeper 点通验证信 → email_verified)就此断在 Node 上。
  'email_verified',
]);

// 已经真正投出去的状态。一旦进入,辅助步骤(存 recipe、截图、自验证)出的异常
// 不许把它打回 blocked/failed —— 那是"没投出去"的语义,会污染漏斗分母。
export const DELIVERED = new Set(['success', 'pending_review', 'emailed', 'delivery_ambiguous']);
export const CONFIRMED_DELIVERED = new Set(['success', 'pending_review', 'emailed']);
const REGRESSIVE = new Set(['blocked', 'failed']);

// 【修】认领闸和标记生命周期原来都只看 DELIVERED,而 manual / skipped_* 同样是
// "别再投了"的终态(driver 的 TERMINAL 里有它们)—— 结果两个洞:
//   ① 直接跑 agent_submit 时,这些终态的域仍能被认领;
//   ② 更要命的是 success → skipped_badge 这类**合法**迁移(mail_sweeper 收到要挂
//      badge 的信就会写)不在 REGRESSIVE 里、守卫放行,而它一写就把标记撤了 ——
//      一个**已经投达**的域于是变回可认领(实测复现)。
// 所以:标记的生命周期跟着这个集合走,不跟 DELIVERED 走。
// 可重试的只有 blocked / failed / email_verified / draft。
export const CLAIM_BLOCKING = new Set([
  ...DELIVERED, 'manual', 'skipped_paid', 'skipped_badge', 'skipped_fit',
]);
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
  try { return parseJsonl(fs.readFileSync(file, 'utf8'), file); }
  catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`账本读取失败(${file}: ${e.code || e.message}),fail-closed`);
  }
}

/** 【修】原实现 `catch { return [] }` 吞掉一切读失败 —— 账本只写不可读(权限/IO)时
 *  currentStatus 返回 null,claimDelivery 于是放行,**唯一的防重复投递闸直接 fail-open**
 *  (实测:已有 success 的账本 chmod 200 后仍返回 claimed:true)。
 *  现在只有 ENOENT(还没开张)算空,其余原样抛给调用方。 */
function parseJsonl(raw, file) {
  // 【修】原来坏行 map 成 null 再 filter 掉 —— 账本里留下一条**截断的 success 行**时,
  // currentStatus 返回 null,认领随之放行(实测 claimed:true)。读失败已经 fail-closed 了,
  // 解析失败同理:那是"这里本来有条记录,但我读不懂",不是"没有记录"。
  // 唯一容忍:文件**不以换行结尾**时的最后一行(append 的固有竞态,下次写会补全)。
  const endsClean = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try { out.push(JSON.parse(lines[i])); }
    catch {
      // 【五修】原来容忍"文件不以换行结尾时的最后一行",理由是 append 竞态。
      // 但账本的安全读发生在**锁内**,不会有并发 append —— 一条持久截断的
      // success 行被当成"不存在",认领就放行了,而且新 JSON 还会拼到半行后面,
      // 既重复投递又进一步破坏账本。持久截断必须 fail-closed,由人来修。
      // (真正的瞬时半截只会出现在**没拿锁的读**上,那种场景本来就不该做安全判定。)
      throw new Error(`账本第 ${i + 1} 行损坏(${file || '?'})${endsClean ? '' : ',且文件以半行结尾'}`
        + `,fail-closed —— 修好或删掉这一行再跑,别让"读不懂"被当成"没有记录"`);
    }
  }
  return out;
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
  releaseClaimIfReopened(dom, status);   // 合法回池时撤认领标记(见该函数注释)
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

  // 【五修·改设计】前四轮都在给"文件锁"打补丁,每轮都被击穿(陈旧接管的 ABA、
  // 创建与写 owner 之间的空文件窗口……)。根因是:**POSIX 没有"按 inode 条件删除"
  // 的原子操作**,纯文件锁的陈旧接管做不对 —— 再打第五个补丁也一样。
  //
  // 换设计:认领的语义本来就不是"临界区",而是**一个域一生只认领一次**
  // (delivery_ambiguous 永不自动重投,只能人工裁决)。这正好是 O_EXCL 建文件的语义:
  // 内核保证只有一个创建者成功,不需要任何存活检测、租约或陈旧判断。
  //
  // 于是"会不会重复 POST"这件事**不再依赖锁的正确性**。下面的 withFileLock 仍用于
  // 状态投影的读改写,但它即使出现竞态,最坏也只是丢一次守卫判定,不会造成重复投递。
  const claims = path.join(DIR, 'claims');
  fs.mkdirSync(claims, { recursive: true });
  const marker = path.join(claims, `${dom.replace(/[^a-z0-9.-]/g, '_')}.claim`);

  // 兜底:老账本里可能已经是投达态但没有标记(标记是本版新增的)。补一个,并拒绝。
  const cur = currentStatus(dom);
  const from = cur ? cur.status : null;
  if (from && CLAIM_BLOCKING.has(from)) {
    try { fs.writeFileSync(marker, `${from} ${nowUtc()}\n`, { flag: 'wx' }); } catch {}
    return { claimed: false, from, to: from };
  }

  try {
    fs.writeFileSync(marker, `${process.pid} ${source} ${nowUtc()}\n`, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return { claimed: false, from, to: from };  // 已被认领
    throw e;                                                              // 建不了 = fail-closed
  }

  // 标记已归我 —— 现在才写账本行(顺序要紧:先拿闸再落账)。
  // 【修】落账失败(锁超时/磁盘满)时必须**把标记撤回**:否则闸留着、账本没记录,
  // 这个域此后永远认领不了(实测:再认领得到 claimed:false / from:null),
  // 而调用方看到的是抛错、以为"没投出去,下次再来"。
  try {
    withFileLock(STATE_FILE, () => {
      append(STATE_FILE, { src: dom, status: 'delivery_ambiguous', note: nt || '', evidence: ev, ts: nowUtc() });
    });
  } catch (e) {
    try { fs.unlinkSync(marker); } catch {}
    throw e;                       // 闸已回滚,调用方按"没拿到认领"处理即可
  }
  // 事件账本是审计用的,写不进不该让已经成立的认领作废 —— 只告警,不回滚。
  try {
    recordEvent({
      domain: dom,
      event_type: from === 'delivery_ambiguous' ? 'attempt_end' : 'status_change',
      prev_status: from, status: 'delivery_ambiguous', reason_code, source,
      evidence: { evidence: ev, note: nt },
    });
  } catch (e) {
    console.error(`[${dom}] 认领事件写入失败(认领本身有效):${String(e.message).slice(0, 80)}`);
  }
  return { claimed: true, from, to: 'delivery_ambiguous' };
}

/** 认领标记的路径(与 claimDelivery 同一套命名)。 */
function claimMarker(dom) {
  return path.join(DIR, 'claims', `${dom.replace(/[^a-z0-9.-]/g, '_')}.claim`);
}

/** 状态合法地离开投达态时(如 email_verified 让域回池)必须撤掉认领标记,
 *  否则下一轮 agent 会被自己上一轮的标记挡住,再也投不出去。
 *  这是**唯一**撤标记的地方:一处明确的写,不是竞态。 */
function releaseClaimIfReopened(dom, status) {
  if (CLAIM_BLOCKING.has(status)) return;   // 见 CLAIM_BLOCKING 注释:不只是 DELIVERED
  try { fs.unlinkSync(claimMarker(dom)); } catch { /* 本来就没有 */ }
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
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = `${target}.lock`;
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const body = `${token} pid=${process.pid} ${nowUtc()}\n`;
  const t0 = monoMs();
  for (;;) {
    // 先写临时文件、再 link() 原子发布:锁文件一出现就是完整的(不存在"建了空文件、
    // 还没写 owner"的空窗,那个窗口曾让竞争者把活锁当无主锁接管)。
    const tmp = `${lock}.mk.${token}`;
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.linkSync(tmp, lock);            // 原子:已存在则 EEXIST
      fs.unlinkSync(tmp);
      try { return fn(); }
      finally {
        try {
          if (fs.readFileSync(lock, 'utf8').trim().split(/\s+/)[0] === token) fs.unlinkSync(lock);
        } catch { /* 已被接管/已释放 */ }
      }
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      if (e.code !== 'EEXIST') throw e;
    }

    // ---- 锁被别人占着 ----
    // 这把锁**不是安全闸**:认领由 claims/ 下的 O_EXCL 标记把关(见 claimDelivery)。
    // 它只护状态投影的读改写,真出竞态最坏是丢一次守卫判定 —— 而那之后重投时
    // 标记仍然挡得住 POST。所以这里不需要为"会不会偷到活锁"做严格保证:
    // 超时就直接覆盖,**永远不要求人工介入**。
    let age = Infinity, ownerDead = false;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
      const m = /pid=(\d+)\b/.exec(fs.readFileSync(lock, 'utf8'));
      ownerDead = m ? !pidAlive(m[1]) : true;              // 读不出 pid 就当没主
    } catch (re) {
      // 【修】原来是裸 `catch { continue }` —— 锁路径被换成目录之类时,
      // readFileSync 每轮都抛 EISDIR,于是**绕过 timeout 与退避变成忙循环**,
      // 只能等 driver 的 900s 外层超时(实测两边都挂死)。
      if (re.code === 'ENOENT') { continue; }               // 刚被释放:直接重抢是对的
      throw new Error(`账本锁不可用(${lock}: ${re.code || re.message}) —— `
        + `它不是一个正常的锁文件,检查这个路径`);
    }
    if ((age > LOCK_STALE_MS && ownerDead) || age > LOCK_HARD_MS) {
      try { fs.unlinkSync(lock); } catch {}                 // 接管:直接覆盖
      continue;
    }
    if (monoMs() - t0 > waitMs) {
      const err = new Error(`ledger locked: 账本锁等待超时(${waitMs}ms):${lock} —— `
        + `持有者仍在运行;若它挂住,${Math.round(LOCK_HARD_MS / 1000)}s 后会被自动接管`);
      err.lockTimeout = true;
      throw err;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

// 陈旧阈值。**任何被遗弃的锁都会自动回收,不需要人工 rm。**
//   STALE:持有者 pid 已不存在 → 30s 接管(崩溃的常见情形,恢复要快)
//   HARD :不管什么原因(pid 被复用/进程挂死/owner 读不出)→ 一律接管
//
// HARD 取 10 分钟的依据(实测,别凭感觉改):临界区只做本地文件读+追加,
// 四个调用点都没有网络/LLM/子进程。实测单次 upsert 耗时 ——
//   1 万行(3MB)36ms · 10 万行(32MB)366ms · 100 万行(316MB)4.0s(取 py/node 中较慢者)
// 100 万行的账本按每域每天 1-2 行要跑好几年,那时也才 4 秒,余量 150 倍。
// 已知无法靠阈值解决的一种情况:**笔记本合盖休眠**几小时后,mtime 天然极旧,
// 醒来瞬间可能被抢 —— 但那需要另一个进程恰好在持有者醒来后的毫秒内插进来,
// 且后果有界(见 withFileLock 的说明),不值得为它加心跳续租。
const LOCK_STALE_MS = 30_000;
const LOCK_HARD_MS = 600_000;

/** 单调时钟。墙钟会被 NTP 回拨/机器休眠破坏,超时上限就不成立了。 */
function monoMs() {
  const [s_, ns] = process.hrtime();
  return s_ * 1000 + ns / 1e6;
}

/** 持锁进程是否还活着(与 creds.mjs 的 pidAlive 同实现)。EPERM = 存在但不属于我们。 */
function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
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
