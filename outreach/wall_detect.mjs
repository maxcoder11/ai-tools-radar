// wall_detect.mjs — 验证码/OAuth/邮箱验证墙的公用识别模块(2026-08-16 从生产 wall_detect.js 移植)
//
// 移植改动:仅两处 —— ① CJS→ESM;② esp_hosts.json 路径从 ../scripts/ 改为同目录
// (开源版把它收进了 outreach/,名单内容与生产同一份,别分叉)。
//
// 边界:这里只收**纯函数** —— 不碰 pg 页面实例、不写账、不打业务日志。
// ⚠️ probeRecaptchaWidget / extractRecaptchaSitekey 是**浏览器侧函数**:
// 调用方 pg.evaluate(wd.xxx) 会把函数体序列化进页面执行,函数体必须自包含,
// 只能引用浏览器全局(document/window/atob/JSON),不能引用本模块的任何变量。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- 站点约束时效表 ----------
// 时效:临时故障给短 TTL(很快该重试),产品策略类给长 TTL。
// 没有"永久" —— 永久问题(伪目录/坏邻居)属于 graveyard,不是约束。
export const CONSTRAINT_TTL_DAYS = {
  http_500: 1,            // 服务端故障,明天就该再试
  captcha_unsolvable: 14, // 打码方会更新能力
  oauth_only: 30,         // 可能被人工登录受控 Chrome 破局
  login_wall: 30,
  paid_only: 60,          // 价格会变,但不常变
  badge_required: 90,     // 取决于产品策略(是否建 /partners 页)
};

/** 从终局理由里认出可复用的硬约束,调用方记进 constraints.jsonl,下次直接短路 */
export function inferConstraint(status, reason) {
  const r = String(reason || '');
  if (/仅\s*OAuth|only.*(google|github).*(sign|login)|仅第三方登录/i.test(r)) return 'oauth_only';
  if (status === 'skipped_badge' || /必须挂.*badge|require.*badge|需要.*徽章|generate badge|add (the )?badge before|verify badge/i.test(r)) return 'badge_required';
  if (/提交即\s*500|服务端\s*5\d\d|HTTP\s*5\d\d/i.test(r)) return 'http_500';
  if (/验证码.*(无法|不渲染|过不了)|captcha.*(unsolvable|not render)/i.test(r)) return 'captcha_unsolvable';
  if (status === 'skipped_paid') return 'paid_only';
  if (/需登录|登录墙|login required/i.test(r) && !/注册/.test(r)) return 'login_wall';
  return null;
}

// ---------- ESP 跳转域白名单(唯一来源:同目录 esp_hosts.json,与 mail_sweeper.py 读同一份)----------
// 读不到按空名单 fail-closed:宁可拦下真 ESP 链接(漏点),不可放错(安全闸语义)。
const ESP_HOSTS = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HERE, 'esp_hosts.json'), 'utf8'));
    return Array.isArray(j.hosts) ? j.hosts : [];
  } catch (e) {
    console.error(`[wall_detect] esp_hosts.json 读取失败:${String(e.message).slice(0, 60)},ESP 白名单按空处理`);
    return [];
  }
})();
export { ESP_HOSTS };

// 最终落点路径验证关键词:与 mail_sweeper.py 的 FINAL_PATH_RE 同一口径,别分叉。
const FINAL_PATH_RE = /verif|confirm|activat|valid|regist|action=(?:rp|resetpass)|login|激活|验证/i;

/**
 * host 是否允许出现在验证链接跳转链里。纯函数。
 * phase='hop'(中转,默认):站方根域及子域 ∪ ESP 跳转域。
 * phase='final'(最终落点):只认站方根域及子域,且落点 URL(路径+查询)含验证关键词;
 *   唯一例外是严格 supabase.co/auth/(Supabase Auth 验证链的落页停在 supabase.co 的
 *   /auth/ 处理页,落点即成功)。最终停在 ESP 域 = 失败。
 */
export function hostAllowed(host, siteRoot, phase = 'hop', finalUrl = '') {
  if (!host) return false;
  host = host.toLowerCase();
  const inSite = host === siteRoot || host.endsWith('.' + siteRoot);
  if (phase === 'final') {
    if (host === 'supabase.co' || host.endsWith('.supabase.co')) {
      try { return (new URL(finalUrl).pathname || '').startsWith('/auth/'); }
      catch { return false; }
    }
    if (!inSite) return false;
    // 只测 pathname+search,不测整 URL:host 里含 verif/login 等词的站整 URL 一测永远过。
    try {
      const fu = new URL(finalUrl);
      return FINAL_PATH_RE.test(fu.pathname + fu.search);
    } catch { return false; }
  }
  if (inSite) return true;
  return ESP_HOSTS.some(e => host === e || host.endsWith('.' + e));
}

// ---------- reCAPTCHA 真组件探测(浏览器侧)----------
// 先验真身再花钱:页面上没有真 reCAPTCHA 组件时,HTML 正则兜底会抓到
// base64 噪音伪装成的"sitekey"。三样全缺 = 幻影。
// ⚠️ 探测异常**按无组件处理**(evaluate 一抛默认有组件 → 拿垃圾串喂 solver)。
export function probeRecaptchaWidget() {
  return {
    div: !!document.querySelector('.g-recaptcha'),
    iframe: !!document.querySelector('iframe[src*="recaptcha/api2"]'),
    cfg: !!(window.___grecaptcha_cfg && Object.keys(window.___grecaptcha_cfg.clients || {}).length),
  };
}

// ---------- reCAPTCHA sitekey 提取 + 幻影 key 过滤(浏览器侧)----------
// ① iframe 只认 api2/anchor?k=…,跳过 api2/aframe 空壳;
// ② 真 sitekey 恒为 40 字符(6L + 38);
// ③ 找 grecaptcha 运行时配置 —— 有的站 key 只存在 JS 里。
// 候选全收集 → 只留长度正好 40 的 → 按可信度排序;能 base64 解出 URL/域名特征的丢弃(幻影)。
export function extractRecaptchaSitekey() {
  const cand = [];
  for (const el of document.querySelectorAll('[data-sitekey]')) {
    cand.push(el.getAttribute('data-sitekey'));
  }
  for (const f of document.querySelectorAll('iframe')) {
    const src = f.src || '';
    if (!/recaptcha/.test(src) || /aframe/.test(src)) continue;   // aframe 是空壳,跳过
    const m = src.match(/[?&]k=([A-Za-z0-9_-]+)/);
    if (m) cand.push(m[1]);
  }
  try {                       // grecaptcha 运行时配置里藏着 key
    const cfg = window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients;
    JSON.stringify(cfg, (k, v) => {
      if (typeof v === 'string' && /^6L[A-Za-z0-9_-]{38}$/.test(v)) cand.push(v);
      return typeof v === 'object' ? v : undefined;
    });
  } catch { }
  for (const m of document.documentElement.innerHTML.matchAll(/6L[A-Za-z0-9_-]{38}/g)) {
    cand.push(m[0]);
  }
  const ok = [...new Set(cand.filter(k => k && k.length === 40))].filter(k => {
    try {
      const s = atob(k.replace(/-/g, '+').replace(/_/g, '/'));
      return !/(www\.|https?|\.com|\.net|\.org)/i.test(s);
    } catch { return true; }
  });
  return ok.find(k => k.startsWith('6L')) || ok[0] || null;
}
