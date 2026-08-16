// rootdomain.mjs — 可注册域(根域)判定,JS 版(2026-08-16 移植)
//
// 与 outreach/rootdomain.py 同一套规则、同一份数据(psl_data.json 由 psl_data.py 生成,
// 数据源是官方 Public Suffix List,公开数据)。安全校验(验证链接必须落在本站)依赖它,
// 手写"取最后两段"会把 evil.co.uk 与 findtheneedle.co.uk 判成同域 —— 别退回去。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PSL = JSON.parse(fs.readFileSync(path.join(HERE, 'psl_data.json'), 'utf8'));
const ICANN_MULTI = new Set(PSL.ICANN_MULTI);
const PRIVATE_MULTI = new Set(PSL.PRIVATE_MULTI);
const ALL_MULTI = new Set([...PSL.ICANN_MULTI, ...PSL.PRIVATE_MULTI]);
const WILDCARD = new Set(PSL.WILDCARD);
const EXCEPTION = new Set(PSL.EXCEPTION);

/** 从域名/URL 取纯 host:小写、去协议/路径/端口/尾点/邮箱前缀。 */
export function hostOf(d) {
  let s = String(d || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].split('@').pop();
  return s.replace(/:\d+$/, '').replace(/\.+$/, '');
}

/** 这个域名的公共后缀占几段。按 PSL 规则:例外 > 通配 > 精确 > 默认单段。 */
function publicSuffixLen(parts, multi, wild, exc) {
  for (let i = 0; i < parts.length; i++) {
    if (exc.has(parts.slice(i).join('.'))) return parts.length - i - 1;
  }
  for (let i = 1; i < parts.length; i++) {
    if (wild.has(parts.slice(i).join('.'))) return parts.length - i + 1;
  }
  for (let i = 0; i < parts.length - 1; i++) {
    if (multi.has(parts.slice(i).join('.'))) return parts.length - i;
  }
  return 1;
}

function fold(d, multi, wild, exc) {
  const parts = hostOf(d).split('.').filter(Boolean);
  if (parts.length < 2) return hostOf(d);
  const n = publicSuffixLen(parts, multi, wild, exc);
  const keep = Math.min(n + 1, parts.length);
  return parts.slice(-keep).join('.');
}

/** 注册人身份用的可注册域(ICANN + PRIVATE 后缀,含通配/例外)。 */
export function rootDomain(d) { return fold(d, ALL_MULTI, WILDCARD, EXCEPTION); }
