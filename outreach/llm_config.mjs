// llm_config.mjs — LLM 端点配置的唯一解析口(JS 侧)。
//
// Python 侧是 llm_config.py,**两份规则逐条一致**(同 rootdomain.mjs/.py 的做法)。
// 改任何一条,另一份必须同步改,否则 agent_submit 和 mail_sweeper 会连到不同端点。
// tests 里有一份跨语言一致性对拍(见 README 的"规范化配置"一节)。
//
// 为什么要有这个文件、解析顺序、base URL 归一规则:见 llm_config.py 的文件头,
// 那边写了完整版,这里不复述,只保证行为一致。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** env 指定的配置文件路径。空串=未设(否则 py 得到 '' 而这里的 || 落到默认,两边分叉);
 *  相对路径锚到 outreach/ 而不是 cwd(两个组件的工作目录不同)。 */
function resolvePath(envName, defaultName) {
  const v = String(process.env[envName] || '').trim();
  if (!v) return path.join(HERE, defaultName);
  return path.isAbsolute(v) ? v : path.join(HERE, v);
}

export const CONFIG_FILE = resolvePath('LLM_CONFIG', 'llm.json');

const DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

/** base URL 或完整地址 → 可直接 POST 的 chat/completions 地址。空进空出。 */
export function chatUrl(base) {
  const u = String(base || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (u.includes('?')) return u;                      // Azure 部署式带 api-version,不动
  if (u.endsWith('/chat/completions')) return u;
  if (/\/v\d+[a-z]*$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

/** 日志/界面显示用:永远不回显完整 key。 */
export function mask(key) {
  const k = String(key || '').trim();
  if (!k) return '(未配置)';
  return k.length > 14 ? `${k.slice(0, 6)}…${k.slice(-4)}` : `${k.slice(0, 2)}…`;
}

function fileCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    // 配置文件存在但坏了要响亮 —— 静默回落到默认端点比报错更难查
    throw new Error(`${CONFIG_FILE} 解析失败(${e.message});修好它或删掉改用环境变量`);
  }
}

const env = (n) => String(process.env[n] || '').trim();

export const MY_SITE = resolvePath('OUTREACH_MY_SITE', 'my_site.json');

/** my_site.json 里的旧 LLM 字段(历史遗留,优先级最低)。读不到就空。 */
function legacySiteCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(MY_SITE, 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch { return {}; }
}

/** 配置来源单元,优先级高→低。**base 与 key 必须成对来自同一个单元**(见 .py 同名函数)。 */
function units() {
  const fc = fileCfg(), sc = legacySiteCfg();
  return [
    { name: 'env LLM_BASE_URL/LLM_API_KEY', base: env('LLM_BASE_URL'),
      key: env('LLM_API_KEY'), model: env('LLM_MODEL'), fallbacks: null },
    { name: 'env LLM_ENDPOINT/LLM_KEY(旧名)', base: env('LLM_ENDPOINT'),
      key: env('LLM_KEY'), model: '', fallbacks: null, legacyEnv: true },
    { name: 'env OPENAI_BASE_URL/OPENAI_API_KEY', base: env('OPENAI_BASE_URL'),
      key: env('OPENAI_API_KEY'), model: '', fallbacks: null },
    { name: CONFIG_FILE, base: String(fc.base_url || '').trim(),
      key: String(fc.api_key || '').trim(), model: String(fc.model || '').trim(),
      fallbacks: Array.isArray(fc.fallbacks) ? fc.fallbacks : null },
    { name: MY_SITE + '(旧字段)', base: String(sc.llm_endpoint || '').trim(),
      key: String(sc.llm_key || '').trim(), model: String(sc.llm_model || '').trim(),
      fallbacks: null, legacySite: true },
  ];
}

const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 };

/** (scheme, host, port) —— **必须与 llm_config.py 的 origin_of 逐字符同结果**。
 *  见 .py 同名函数的注释:两边归一化不一致 = 一种语言拒绝、另一种放行。 */
export function originOf(u) {
  try {
    const p = new URL(chatUrl(u));
    const scheme = p.protocol.replace(/:$/, '').toLowerCase();
    const host = p.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = p.port ? Number(p.port) : (DEFAULT_PORTS[p.protocol] || 0);
    return `${scheme}|${host}|${port}`;
  } catch { return `?|${String(u).toLowerCase()}|0`; }
}
const origin = originOf;

/** @returns {{url,base_url,key,models,sources,warnings}} 不校验连通性(那是 check_llm.py 的活)
 *  **base 与 key 同源绑定**:选第一个带 key 的单元,base 取它自己的;别的单元若指了
 *  不同 origin 的 base,配置有歧义 → 抛错不猜。LLM_ALLOW_SPLIT_CONFIG=1 可放行。 */
export function load() {
  const us = units();
  const warnings = [], sources = {};
  // 【修】原来 !!非空串 —— "0"/"false" 也会开启这个放行开关。按真布尔解析(与 .py 同)。
  const allowSplit = ['1', 'true', 'yes', 'on'].includes(env('LLM_ALLOW_SPLIT_CONFIG').toLowerCase());

  const winner = us.find(u => u.key) || null;
  let base, key;
  if (!winner) {
    const based = us.find(u => u.base) || null;
    base = based ? based.base : DEFAULT_BASE;
    sources.base = based ? based.name : '缺省';
    sources.key = '(未配置)';
    key = '';
  } else {
    key = winner.key;
    sources.key = winner.name;
    base = winner.base || DEFAULT_BASE;
    sources.base = winner.base ? winner.name : `缺省(跟随 ${winner.name} 的 key)`;
    const chosen = origin(base);
    for (const u of us) {
      if (u === winner || !u.base) continue;
      if (origin(u.base) !== chosen) {
        const msg = `LLM 配置有歧义,拒绝猜:\n`
          + `  key 来自 ${winner.name},对应地址 ${chatUrl(base)}\n`
          + `  但 ${u.name} 指定了另一个地址 ${chatUrl(u.base)}\n`
          + `把 base_url 和 api_key 放在同一处(同一组环境变量、或同一个 llm.json),`
          + `别一半在 env 一半在文件 —— 否则会把一个供应商的 key 发给另一个供应商。\n`
          + `确实要这么配就设 LLM_ALLOW_SPLIT_CONFIG=1。`;
        if (!allowSplit) throw new Error(msg);
        // 【修】放行只该是"别报错",不该反向把 base 覆盖成低优先级单元的地址(与 .py 同)。
        warnings.push(`⚠️ LLM_ALLOW_SPLIT_CONFIG 已放行歧义配置:key 来自 ${winner.name},`
          + `仍发往它自己的地址 ${chatUrl(base)};${u.name} 指定的 ${chatUrl(u.base)} 被忽略`);
        break;
      }
    }
  }

  for (const u of us) {
    if (u.legacyEnv && (u.base || u.key)) {
      warnings.push('LLM_ENDPOINT/LLM_KEY 已改名为 LLM_BASE_URL/LLM_API_KEY(仍然可用);'
        + '新名字收 base URL,不必再写 /chat/completions');
    }
    if (u.legacySite && (u.base || u.key || u.model)) {
      warnings.push('my_site.json 里的 llm_endpoint/llm_key/llm_model 是旧位置'
        + '(此前根本没被读过);已认下,但建议搬到 llm.json 或环境变量');
    }
  }

  const model = (us.find(u => u.model) || {}).model || DEFAULT_MODEL;
  sources.model = (us.find(u => u.model) || {}).name || '缺省';
  const rawFb = env('LLM_FALLBACKS');
  const fbUnit = us.find(u => u.fallbacks && u.fallbacks.length);
  const fallbacks = rawFb
    ? rawFb.split(',').map(x => x.trim()).filter(Boolean)
    : (fbUnit ? fbUnit.fallbacks.map(m => String(m).trim()).filter(Boolean) : []);

  const models = [];
  for (const m of [model, ...fallbacks]) if (m && !models.includes(m)) models.push(m);

  return { url: chatUrl(base), base_url: base, key, models, sources, warnings };
}

/** 要 key 的调用方用这个(Python 侧同名函数是 require_llm):缺 key 直接给出人话指引,不让它跑到一半才炸。 */
export function requireLlm(purpose = 'LLM') {
  const cfg = load();
  if (!cfg.key) {
    throw new Error(`${purpose} 缺 API key。三选一:\n`
      + `  export LLM_API_KEY=...(配合 LLM_BASE_URL / LLM_MODEL)\n`
      + `  export OPENAI_API_KEY=...(直接吃现成的)\n`
      + `  cp llm.example.json llm.json 后填进去\n`
      + `当前端点 ${cfg.url},模型 ${cfg.models.join('/')}`);
  }
  return cfg;
}
