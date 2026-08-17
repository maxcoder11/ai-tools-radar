// capsolver.mjs — CapSolver 客户端(2026-08-16 从生产 capsolver.js 移植)
// turnstile/滑块/reCAPTCHA v2·v3/hCaptcha/CF Challenge 出码。
//
// 移植改动:
//   ① key 来源:my_site.json 的 capsolver_key / twocaptcha_key(替代私仓 db/creds.json);
//      两个 key 都没配时 hasKey()=false —— 调用方(agent_submit.mjs)把验证码域
//      标记 manual 转人工,不硬刚。
//   ② 成本账本:dbw(SQLite)→ state.mjs(costs.jsonl),日预算熔断/fail-closed 语义不变。
//   ③ CJS→ESM。
//
// 降级链:capsolver 终态错误(ERROR_INVALID_TASK_DATA / Solve failed /
//   ERROR_TASK_NOT_SUPPORTED / ERROR_CAPTCHA_UNSOLVABLE / invalid site key)时,
//   同一任务自动映射成 2Captcha 任务重解一次;2Captcha 也失败才上抛 capsolver 原始错误。
//   网络瞬态错误不降级。VisionEngine 滑块 2Captcha 无对应物,不降级。
//   两供应商独立日预算熔断(env CAPSOLVER_DAILY_BUDGET_USD /
//   TWOCAPTCHA_DAILY_BUDGET_USD,各默认 $50,互不相干)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.capsolver.com';

function mySitePath() {
  const v = String(process.env.OUTREACH_MY_SITE || '').trim();
  if (!v) return path.join(HERE, 'my_site.json');
  return path.isAbsolute(v) ? v : path.join(HERE, v);
}

function siteCfg() {
  // 【修】相对 OUTREACH_MY_SITE 原来按 cwd 解析,而 llm_config 锚到 outreach/ ——
  // 同一份配置两边可能读到不同文件(漏读 solver key,或读到另一份凭据)。同口径。
  try { return JSON.parse(fs.readFileSync(mySitePath(), 'utf8')); }
  catch { return {}; }
}

/** 打码 key 是否已配置。没配 = 验证码站转人工,调用方先查这个再走付费路径。
 *  【修】原来只看 capsolver_key —— 只配了 twocaptcha_key 的用户会被一路标成 manual,
 *  连降级通道的门都摸不到(而且就算摸到,key() 抛的错不带 .terminal,也走不到降级)。
 *  现在任一供应商有 key 就算"能解",具体走哪条由 solveWithFallback 决定。 */
export function hasKey() {
  const c = siteCfg();
  return !!(String(c.capsolver_key || '').trim() || String(c.twocaptcha_key || '').trim());
}

/** 各供应商是否可用(solveWithFallback 据此决定从哪条腿起跑)。 */
function hasCapsolver() { return !!String(siteCfg().capsolver_key || '').trim(); }
function has2c() { return !!String(siteCfg().twocaptcha_key || '').trim(); }

function key() {
  const k = String(siteCfg().capsolver_key || '').trim();
  if (!k) throw new Error('my_site.json 缺 capsolver_key');
  return k;
}

// ---------- 预算熔断与成本台账 ----------
// createTask 是所有 CapSolver 花钱动作的唯一收口,熔断和记账都打在这里。
// 「创建任务前」预算检查,不是事后台账 —— 事后发现超支时钱已经花了。
// fail-closed:账本不可用(state.mjs spentToday 抛错)一律拒绝新建付费任务。
// 预算口径:$50 是**每供应商**日预算 —— capsolver 与 2Captcha 各自独立记账、各自熔断。
import * as dbw from './state.mjs';

// CapSolver 官方价目(USD / 次,单次调用),2026-07 档。宁可估高不估低 —— 熔断保守是对的。
const UNIT_USD = {
  AntiTurnstileTaskProxyLess: 0.0012,
  ReCaptchaV2TaskProxyless: 0.0008,
  ReCaptchaV3TaskProxyless: 0.0010,
  HCaptchaTaskProxyless: 0.0008,
  AntiCloudflareTask: 0.0020,
  VisionEngine: 0.0003,
};
const DEFAULT_UNIT_USD = 0.0020;
const DAILY_BUDGET_USD = Number(process.env.CAPSOLVER_DAILY_BUDGET_USD || 50);

// capsolver 终态错误:这类错重试 capsolver 没意义,触发 2Captcha 降级。
const TERMINAL_RE = /ERROR_INVALID_TASK_DATA|ERROR_TASK_NOT_SUPPORTED|ERROR_CAPTCHA_UNSOLVABLE|invalid site key|Solve failed/i;

function unitCost(type) {
  return UNIT_USD[type] != null ? UNIT_USD[type] : DEFAULT_UNIT_USD;
}

async function createTask(payload, meta = {}) {
  const cost = unitCost(payload && payload.type);

  // —— 熔断:出码前先看今天花了多少(fail-closed)——
  // 基建/预算错误打标记上抛:e.infra=账本不可用,e.budget=日预算熔断。
  // 调用方(agent_submit 顶层)按基建瞬态处理:不写 blocked、域留池。
  let spent;
  try { spent = dbw.spentToday('capsolver'); }
  catch (qe) {
    const e = new Error(`成本账本查询失败(${String(qe && qe.message).slice(0, 60)}),拒绝新建 CapSolver 付费任务(fail-closed)`);
    e.infra = true;
    throw e;
  }
  if (spent + cost > DAILY_BUDGET_USD) {
    const e = new Error(
      `CapSolver 日预算熔断:今日已花 $${spent.toFixed(4)},本次 $${cost.toFixed(4)},` +
      `超过上限 $${DAILY_BUDGET_USD}(每供应商口径,改 CAPSOLVER_DAILY_BUDGET_USD 可调)`);
    e.budget = true;
    throw e;
  }

  const r = await fetch(API + '/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: key(), task: payload }),
  });
  const j = await r.json();
  if (j.errorId) {
    // solver 拒收任务(幻影 key/数据畸形):打 junkKey 标记,调用方按
    // 「服务端隐形防护,裸提交」处理而不是让整站 EXC。
    const msg = `${j.errorCode}: ${j.errorDescription}`;
    const e = new Error(`createTask ${msg}`);
    if (/ERROR_INVALID_TASK_DATA|invalid site key/i.test(msg)) e.junkKey = true;
    if (TERMINAL_RE.test(msg)) e.terminal = true;
    throw e;
  }

  // —— 记账:只有真的建单成功才计费;记账失败 fail-closed 中止(台账少记 = 熔断低估)——
  try {
    dbw.recordCost({
      provider: 'capsolver',
      job: meta.job || 'agent_submit',
      domain: meta.domain || null,
      quantity: 1,
      unit_cost_usd: cost,
      amount_usd: cost,
      is_actual: 0,                       // 估算值,对账以 CapSolver 账单为准
      note: `${payload && payload.type} task=${j.taskId}`,
    });
  } catch (e) {
    const e2 = new Error(`CapSolver 任务已建(task=${j.taskId})但记账失败(${String(e && e.message).slice(0, 60)}),fail-closed 中止`);
    e2.infra = true;
    throw e2;
  }
  return j.taskId;
}

async function pollResult(taskId, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await fetch(API + '/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: key(), taskId }),
    });
    const j = await r.json();
    if (j.errorId) {
      const msg = `${j.errorCode}: ${j.errorDescription}`;
      const e = new Error(`getTaskResult ${msg}`);
      if (TERMINAL_RE.test(msg)) e.terminal = true;
      throw e;
    }
    if (j.status === 'ready') return j.solution;
    if (j.status !== 'processing' && j.status !== 'idle') throw new Error('未知状态 ' + j.status);
  }
  throw new Error('出码超时');
}

// ==================== 2Captcha 降级通道 ====================
const API2C = 'https://api.2captcha.com';

function key2c() {
  const k = String(siteCfg().twocaptcha_key || '').trim();
  if (!k) throw new Error('my_site.json 缺 twocaptcha_key(2Captcha 降级通道不可用)');
  return k;
}

// 2Captcha 单价(USD/次,按其 getTaskResult 返回的 cost 字段估,宁可估高)
const UNIT_USD_2C = {
  TurnstileTaskProxyless: 0.0020,
  RecaptchaV2TaskProxyless: 0.0030,
  RecaptchaV3TaskProxyless: 0.0030,
  HCaptchaTaskProxyless: 0.0030,
  // 无 AntiCloudflareTask:2Captcha 未上线该类型,不映射
};
const DEFAULT_UNIT_USD_2C = 0.0030;
const TWOCAPTCHA_DAILY_BUDGET_USD = Number(process.env.TWOCAPTCHA_DAILY_BUDGET_USD || 50);

/** 拆 socks5://user:pass@host:port(或 host:port:user:pass)为 2Captcha 的分字段 proxy */
function splitProxy(p) {
  if (!p) return null;
  let m = String(p).match(/^(?:(https?|socks4|socks5):\/\/)?(?:([^:@/]+):([^@/]+)@)?([^:/@]+):(\d+)$/);
  if (m) {
    const out = {
      proxyType: m[1] === 'socks5' ? 'socks5' : m[1] === 'socks4' ? 'socks4' : 'http',
      proxyAddress: m[4], proxyPort: Number(m[5]),
    };
    if (m[2]) { out.proxyLogin = m[2]; out.proxyPassword = m[3]; }
    return out;
  }
  m = String(p).match(/^([^:/@]+):(\d+):([^:@/]+):([^@/]+)$/);   // host:port:user:pass
  if (m) return { proxyType: 'http', proxyAddress: m[1], proxyPort: Number(m[2]), proxyLogin: m[3], proxyPassword: m[4] };
  return null;
}

/** capsolver 任务 → 2Captcha 任务。返回 null = 无对应物(VisionEngine 等),不降级。 */
function to2CaptchaTask(p) {
  if (!p || !p.type) return null;
  const t = { ...p };
  switch (p.type) {
    case 'AntiTurnstileTaskProxyLess':
      t.type = 'TurnstileTaskProxyless';
      if (t.metadata) {
        if (t.metadata.action && !t.action) t.action = t.metadata.action;
        delete t.metadata;
      }
      return t;
    case 'ReCaptchaV2TaskProxyless':
      t.type = 'RecaptchaV2TaskProxyless';   // 大小写不同:capsolver ReCaptcha vs 2Captcha Recaptcha
      return t;
    case 'ReCaptchaV3TaskProxyless':
      t.type = 'RecaptchaV3TaskProxyless';
      if (t.minScore == null) t.minScore = 0.3;   // 2Captcha 必填,capsolver 没这字段
      return t;
    case 'HCaptchaTaskProxyless':
      return t;
    case 'AntiCloudflareTask':
      return null;   // 2Captcha 没有该类型,降级注定失败,白烧往返
    default:
      return null;
  }
}

async function createTask2c(payload, meta = {}) {
  const cost = UNIT_USD_2C[payload.type] != null ? UNIT_USD_2C[payload.type] : DEFAULT_UNIT_USD_2C;
  let spent;
  try { spent = dbw.spentToday('twocaptcha'); }
  catch (qe) {
    const e = new Error(`成本账本查询失败(${String(qe && qe.message).slice(0, 60)}),拒绝新建 2Captcha 付费任务(fail-closed)`);
    e.infra = true;
    throw e;
  }
  if (spent + cost > TWOCAPTCHA_DAILY_BUDGET_USD) {
    const e = new Error(
      `2Captcha 日预算熔断:今日已花 $${spent.toFixed(4)},本次 $${cost.toFixed(4)},` +
      `超过上限 $${TWOCAPTCHA_DAILY_BUDGET_USD}(每供应商口径,改 TWOCAPTCHA_DAILY_BUDGET_USD 可调)`);
    e.budget = true;
    throw e;
  }

  const r = await fetch(API2C + '/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: key2c(), task: payload }),
  });
  const j = await r.json();
  if (j.errorId) throw new Error(`2c createTask ${j.errorCode}: ${j.errorDescription}`);

  try {
    dbw.recordCost({
      provider: 'twocaptcha',
      job: meta.job || 'agent_submit',
      domain: meta.domain || null,
      quantity: 1,
      unit_cost_usd: cost,
      amount_usd: cost,
      is_actual: 0,
      note: `${payload.type} task=${j.taskId} (capsolver 降级)`,
    });
  } catch (e) {
    const e2 = new Error(`2Captcha 任务已建(task=${j.taskId})但记账失败(${String(e && e.message).slice(0, 60)}),fail-closed 中止`);
    e2.infra = true;
    throw e2;
  }
  return j.taskId;
}

async function pollResult2c(taskId, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await fetch(API2C + '/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: key2c(), taskId }),
    });
    const j = await r.json();
    if (j.errorId) throw new Error(`2c getTaskResult ${j.errorCode}: ${j.errorDescription}`);
    if (j.status === 'ready') return j.solution;
    if (j.status !== 'processing' && j.status !== 'idle') throw new Error('2c 未知状态 ' + j.status);
  }
  throw new Error('2c 出码超时');
}

/**
 * capsolver 优先;终态错误自动降级 2Captcha 重解一次。
 * 2Captcha 也失败时上抛 capsolver 原始错误(保留 junkKey 等标记)。
 * 返回 { solution, provider:'capsolver'|'twocaptcha' }。
 */
async function solveWithFallback(payload, timeoutMs = 120000, meta = {}) {
  let csErr;
  if (hasCapsolver()) {
    try {
      const taskId = await createTask(payload, meta);
      return { solution: await pollResult(taskId, timeoutMs), provider: 'capsolver' };
    } catch (e) {
      if (!e.terminal) throw e;            // 网络瞬态/超时等:不降级,原样上抛
      csErr = e;
    }
  } else {
    // 【修】没配 capsolver 但配了 2Captcha:直接走降级腿,别拿"缺 capsolver_key"
    // 当终态错误上抛(那样 2Captcha 这条腿永远用不上)。
    if (!has2c()) throw new Error('my_site.json 既没有 capsolver_key 也没有 twocaptcha_key');
    // 【修】这是个**占位**错误(其实没出错,只是没配 capsolver),原来它没有任何分类标志,
    // 而下面 2Captcha 真出错时只把 infra/budget 复制过来 —— 无效 key 之类的供应商故障
    // 于是 terminal/infra/budget/noSolver 全 false,顶层走通用异常把**目标站**烧成 blocked。
    // 打上 placeholder 标记,下面据此改用 2Captcha 自己的错误对象。
    csErr = new Error('未配 capsolver_key,直接走 2Captcha');
    csErr.placeholder = true;
  }
  const t2 = to2CaptchaTask(payload);
  if (!t2) {
    // 【修】2Captcha 没有对应任务类型(AntiCloudflareTask / VisionEngine)。
    // 只配了 2Captcha 的用户撞上整页 CF 挑战时,原来抛的是普通错 → 顶层落 blocked,
    // 既没进人工队列也没标 manual。打 noSolver:调用方按"有验证码但没解题能力"转人工。
    if (!hasCapsolver()) {
      const e = new Error(`${payload && payload.type} 只有 CapSolver 能解,而当前只配了 twocaptcha_key`);
      e.noSolver = true;
      throw e;
    }
    throw csErr;
  }
  console.warn(`[capsolver] ${payload.type} 终态失败(${csErr.message}),降级 2Captcha ${t2.type}`);
  try {
    const taskId = await createTask2c(t2, meta);
    const solution = await pollResult2c(taskId, timeoutMs);
    console.warn(`[capsolver] 2Captcha 解出 ${t2.type} task=${taskId}`);
    return { solution, provider: 'twocaptcha' };
  } catch (e2) {
    // 【修】csErr 是占位(压根没试过 capsolver)时,把它当"原始错误"上抛毫无信息量
    // 且不带分类 —— 直接抛 2Captcha 自己的错误对象,它的标志(infra/budget/terminal)
    // 才是真的。只有 capsolver 真失败过,才保留原始错误并透传标记。
    if (csErr.placeholder) {
      e2.message = `未配 capsolver_key,2Captcha 直投失败: ${e2.message}`;
      throw e2;
    }
    // 降级通道撞基建/预算:标记必须透传,否则调用方认不出,照样把域烧 blocked。
    if (e2 && e2.infra) csErr.infra = true;
    if (e2 && e2.budget) csErr.budget = true;
    csErr.message += ` | 2Captcha 降级也失败: ${e2.message}`;
    throw csErr;
  }
}

// Cloudflare Turnstile(含 managed):返回 {token, ua}
export async function turnstile(url, sitekey, opts = {}, meta = {}) {
  const { solution: s } = await solveWithFallback({
    type: 'AntiTurnstileTaskProxyLess', websiteURL: url, websiteKey: sitekey, ...opts,
  }, 120000, meta);
  return { token: s.token, ua: s.userAgent };
}

// 拼图滑块:传背景图+拼块图(base64),返回滑动距离(px)。VisionEngine 不走降级链。
export async function sliderDistance(bgBase64, pieceBase64, meta = {}) {
  const taskId = await createTask({
    type: 'VisionEngine', module: 'slider_1',
    imageBackground: bgBase64, image: pieceBase64,
  }, meta);
  const s = await pollResult(taskId, 60000);
  return s.distance;
}

// reCAPTCHA v2:返回 gRecaptchaResponse;invisible=true 时用 isInvisible 任务参数
export async function recaptchaV2(url, sitekey, opts = {}, meta = {}) {
  const task = { type: 'ReCaptchaV2TaskProxyless', websiteURL: url, websiteKey: sitekey };
  if (opts.invisible) task.isInvisible = true;
  const { solution: s } = await solveWithFallback(task, 180000, meta);
  return s.gRecaptchaResponse;
}

// reCAPTCHA v3:需要 pageAction(页面上 grecaptcha.execute 的 action 参数)
export async function recaptchaV3(url, sitekey, pageAction, meta = {}) {
  const { solution: s } = await solveWithFallback({
    type: 'ReCaptchaV3TaskProxyless', websiteURL: url, websiteKey: sitekey, pageAction: pageAction || 'submit',
  }, 180000, meta);
  return s.gRecaptchaResponse;
}

// hCaptcha:返回 token
export async function hcaptcha(url, sitekey, meta = {}) {
  const { solution: s } = await solveWithFallback({ type: 'HCaptchaTaskProxyless', websiteURL: url, websiteKey: sitekey }, 180000, meta);
  return s.gRecaptchaResponse;
}

// 整页 Cloudflare Challenge("Just a moment..." 403):AntiCloudflareTask
// 需要稳定代理 + 一致 UA;cf_clearance 绑定 IP+UA,代理解出的票对直连浏览器无效。
// CapSolver 要挑战页 HTML 才认得出是哪种挑战(不给就 ERROR_INVALID_TASK_DATA)。
export async function cloudflareChallenge(url, proxy, ua, html, meta = {}) {
  const task = { type: 'AntiCloudflareTask', websiteURL: url, proxy, userAgent: ua };
  if (html) task.html = String(html).slice(0, 200000);
  const { solution: s } = await solveWithFallback(task, 180000, meta);
  return { cookies: s.cookies, ua: s.userAgent, token: s.token };
}

export async function balance() {
  const r = await fetch(API + '/getBalance', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: key() }),
  });
  const j = await r.json();
  return j.balance;
}
