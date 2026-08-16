// outbound_guard.mjs — 出站目标校验(2026-08-16 从生产 outbound_guard.js 原样移植,仅改 ESM):
//   http(s) only;禁 userinfo;IP 字面量/本地解析落在 loopback/private/link-local/
//   reserved/multicast/unspecified 一律拒;allowedRoot 给出时要求同根域(子域允许)。
// 已知边界(如实):走 HTTP 代理时真实 DNS 解析在代理端,本地 lookup 只是预检;
// 逐跳校验由调用方做(agent_submit.mjs curlGet()/gotoGuarded())。
import dns from 'node:dns/promises';

function _badV4(a, b) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)        // CGNAT 100.64/10
      || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
      || a >= 224;                                  // 组播/保留/240/4
}

export function badIp(ip) {
  const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some(x => x > 255)) return true;
    return _badV4(o[0], o[1]);
  }
  if (!s.includes(':')) return false;               // 不是 IP 字面量,交给 DNS 预检
  if (s === '::' || s === '::1') return true;
  if (/^fe[89ab]/.test(s)) return true;             // link-local fe80::/10
  if (/^f[cd]/.test(s)) return true;                // ULA fc00::/7
  if (/^ff/.test(s)) return true;                   // 组播 ff00::/8
  const m = s.match(/::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);   // v4-mapped 点分尾
  if (m) return _badV4(Number(m[1]), Number(m[2])) || _badV4(Number(m[3]), Number(m[4]));
  // WHATWG URL 把 v4-mapped 归一成十六进制 ::ffff:7f00:1(g1=a<<8|b, g2=c<<8|d)
  const mh = s.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mh) {
    const g1 = parseInt(mh[1], 16), g2 = parseInt(mh[2], 16);
    return _badV4(g1 >> 8, g1 & 255) || _badV4(g2 >> 8, g2 & 255);
  }
  return false;
}

/** host 是否等于 root 或其子域(www./尾点已剥) */
export function hostInRoot(host, root) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
  const r = String(root || '').toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
  return !!h && !!r && (h === r || h.endsWith('.' + r));
}

/** 同步轻校验:scheme/userinfo/IP 字面量/同根域。不合法返回 null。 */
export function validateUrlLite(url, { allowedRoot = null } = {}) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  if (badIp(u.hostname)) return null;
  if (allowedRoot && !hostInRoot(u.hostname, allowedRoot)) return null;
  return u.href;
}

/** 异步校验:lite + 本地 DNS 预检(解析不到/落到坏段 → null)。 */
export async function validateUrl(url, opts = {}) {
  const href = validateUrlLite(url, opts);
  if (!href) return null;
  const host = new URL(href).hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return href;  // 字面量已查
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some(a => badIp(a.address))) return null;
  } catch { return null; }                  // 解析不了的目标不许连
  return href;
}
