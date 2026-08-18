// verify_link.mjs — 真外链终核器(2026-08-16 开源移植版,生产:node-tools/verify_link.js)
//
// 三个实质设计(与生产一致):
//  1. **判据是"页面上有没有指向我们域的 <a href>"**(确定性,不问 LLM)——
//     消除"搜索页回显被当成上线"那类假阳性。
//  2. **四路探针**:已记录 URL → sitemap → 站内搜索 → 路径枚举,
//     并记录"试过哪些探针"(oracles_tried),证明 offline 是真的找过而不是没找到。
//  3. **三态 + SEO 价值字段**:online / offline_confirmed / unknown_network /
//     unknown_blocked,网络错误绝不写成"未上线";抓 rel(nofollow 判定)、
//     meta robots、X-Robots-Tag、canonical、跳转落地。
//
// 开源化改造:
//  - 产品信息从 kit.json 读(--kit,默认 outreach/kit.json),不读 products 表
//  - 状态源:state.mjs(state.jsonl);--pending = 当前态 ∈
//    pending_review/emailed/success/delivery_ambiguous 的域
//  - 已知链(--known 复核)= verifications.jsonl 里有过 online 记录的域
//  - --update-status 经 state.mjs 状态守卫写回:
//      online + dofollow → success(reason published);
//      online 但 nofollow → 保持/回到 pending_review(上线但不传权);
//      offline_confirmed  → 累计连续次数,**≥3 次才写 failed**(reason delisted;
//                           生产 link_facts.miss_streak 同口径:绝不用单次核验判死);
//      unknown_*          → 不动(网络/封禁问题不是站的结论)
//  - 代理:VERIFY_PROXY 环境变量(空串显式关),默认 HTTPS_PROXY 或直连;
//    启动探测,代理死了自动回退直连
//  - 远程核验模式(VERIFY_JOB)未移植(私有基建)
//
// 用法:
//   node verify_link.mjs --pending                 核验所有待终核
//   node verify_link.mjs --known                   复核已知链(查掉链)
//   node verify_link.mjs aibesttools.org ebool.com  指定域名
//   附加: --update-status  同时改 state.jsonl 状态(默认只读,不动状态)
//         --json <path>    额外落一份结构化报告
//         --concurrency N  (保留参数位;域级串行,预筛内部并发)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request as pwRequest } from 'playwright-core';
import * as db from './state.mjs';
import * as og from './outbound_guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT = 25000;
const FETCH_TIMEOUT = 12000;

// ---------- 目标产品(kit.json) ----------
function loadProduct(argv) {
  const ki = argv.indexOf('--kit');
  const kitPath = ki > 0 ? argv[ki + 1] : path.join(HERE, 'kit.json');
  const KIT = JSON.parse(fs.readFileSync(kitPath, 'utf8'));
  const p = { name: KIT.product.name, url: KIT.product.url };
  const host = new URL(p.url).hostname.replace(/^www\./, '');
  /* slug 用于路径枚举与 sitemap 匹配,必须是 URL 安全的。
     取两路候选:名字 slug 化 + 域名首段,去重后一起用。 */
  const nameSlug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hostSlug = host.split('.')[0];
  const slugs = [...new Set([nameSlug, hostSlug].filter(Boolean))];
  return { name: p.name, url: p.url, host, slug: slugs[0], slugs };
}

// ---------- 出站代理 ----------
// VERIFY_PROXY 显式指定;缺省跟 HTTPS_PROXY;都没有就直连。
// 启动探测:代理死了自动回退直连(代理断线时直连结论也比全报 unknown 强,但会记日志)。
let PROXY = process.env.VERIFY_PROXY === '' ? null
          : (process.env.VERIFY_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || null);
let _reqCtx = null;
let _proxyProbed = false;
async function probeProxy() {
  if (_proxyProbed || !PROXY) return;
  _proxyProbed = true;
  try {
    const ctl = await pwRequest.newContext({ proxy: { server: PROXY } });
    await ctl.get('https://example.com', { timeout: 8000 });
    await ctl.dispose();
  } catch {
    console.log('  [verify] 代理不可达,本轮回退直连');
    PROXY = null;
  }
}
function reqCtx() {
  if (!_reqCtx) _reqCtx = pwRequest.newContext({
    userAgent: UA,
    proxy: PROXY ? { server: PROXY } : undefined,
  });
  return _reqCtx;
}

// ---------- 小工具 ----------
// 出站闸:初始 URL 与每一跳 Location 都先验再连
// (协议仅 http(s)/禁 userinfo/拒内网 IP/本地 DNS 预检),不盲跟重定向。
async function get(url, { timeout = FETCH_TIMEOUT, redirect = 'follow' } = {}) {
  const ctx = await reqCtx();
  let cur = url;
  const maxHop = redirect === 'follow' ? 8 : 0;
  for (let hop = 0; ; hop++) {
    const v = await og.validateUrl(cur);
    if (!v) throw new Error(`outbound guard 拒绝:${String(cur).slice(0, 120)}`);
    const r = await ctx.get(v, { timeout, maxRedirects: 0 });   // 不自动跟跳,逐跳自己验
    const st = r.status();
    const loc = st >= 300 && st < 400 ? r.headers()['location'] : null;
    if (loc && hop < maxHop) {
      try { cur = new URL(loc, v).href; }
      catch { throw new Error('outbound guard 拒绝:畸形 Location'); }
      continue;
    }
    const h = r.headers();
    const text = await r.text();   // playwright 自动解 gzip
    return { ok: r.ok(), status: st, url: v,
             headers: { get: (k) => h[String(k).toLowerCase()] }, text };
  }
}

const uniq = (a) => [...new Set(a)];

// ============================================================
// 探针 1:已记录的收录页 URL
//   来源:verifications.jsonl 里历史 online 的 source_url + state.jsonl 证据里的 URL
// ============================================================
function oracleRecorded(dom, prod) {
  const out = [];
  // 历史核验在线的收录页(最近 5 个)
  try {
    for (const r of db.verificationRows(dom)
        .filter(x => x.result === 'online' && x.source_url).slice(-5)) {
      out.push(r.source_url);
    }
  } catch {}
  for (const s of db.stateRows(dom)) {
    const blob = `${s.evidence || ''} ${s.note || ''}`;
    // 证据里出现过的、属于该域的 URL(历史上人工/LLM 记下的收录页)
    for (const m of blob.matchAll(/https?:\/\/[^\s|,)"']+/g)) {
      try {
        const u = new URL(m[0]);
        // h === root || h endsWith('.'+root):裸 endsWith 会放进碰撞域
        if (og.hostInRoot(u.hostname, dom)) out.push(u.href);
      } catch {}
    }
    // 无协议写法也要认 —— "实站核验在线: example.com/app/my-tool" 这种
    const bare = new RegExp(`(?:^|[\\s|,(])((?:www\\.)?${dom.replace(/\./g, '\\.')}/[^\\s|,)"']+)`, 'gi');
    for (const m of blob.matchAll(bare)) {
      try { out.push(new URL(`https://${m[1].replace(/^www\./, '')}`).href); } catch {}
    }
  }
  return uniq(out).slice(0, 6);
}

// ============================================================
// 探针 2:sitemap —— 站点自己声明的全量 URL 清单,比猜路径全得多
// ============================================================
async function oracleSitemap(dom, prod) {
  const seeds = [];
  try {
    const rb = await get(`https://${dom}/robots.txt`);
    if (rb.ok) for (const m of rb.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) seeds.push(m[1]);
  } catch {}
  seeds.push(`https://${dom}/sitemap.xml`, `https://${dom}/sitemap_index.xml`,
             `https://${dom}/sitemap-index.xml`, `https://${dom}/wp-sitemap.xml`,
             // canonDomain 去了 www.,但有的站只在 www 上解析 —— 补一路
             `https://www.${dom}/sitemap.xml`, `https://www.${dom}/sitemap_index.xml`);

  const hits = [];
  const seen = new Set();
  const queue = uniq(seeds).slice(0, 6);
  let fetched = 0;
  while (queue.length && fetched < 25 && hits.length < 5) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let r;
    try { r = await get(sm); } catch { continue; }
    if (!r.ok || !/xml|text/i.test(r.headers.get('content-type') || 'xml')) continue;
    fetched++;
    const locs = [...r.text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
    if (/<sitemapindex/i.test(r.text)) {
      // 子图优先挑名字像收录页的(tool/product/listing/post),避免在 image-sitemap 里空转
      const ranked = locs.sort((a, b) =>
        (/tool|product|listing|item|app|site|post/i.test(b) ? 1 : 0) -
        (/tool|product|listing|item|app|site|post/i.test(a) ? 1 : 0));
      queue.push(...ranked.slice(0, 12));
      continue;
    }
    for (const u of locs) {
      const lu = u.toLowerCase();
      if (prod.slugs.some(sl => lu.includes(sl))) hits.push(u);   // 名字 slug 或域名首段
    }
  }
  return { urls: uniq(hits).slice(0, 5), sitemapsRead: fetched };
}

// ============================================================
// 探针 3:站内搜索(渲染,SPA 也能用)
// ============================================================
function searchUrls(dom, prod) {
  const q = encodeURIComponent(prod.name);
  return [`https://${dom}/search?q=${q}`, `https://${dom}/?s=${q}`, `https://${dom}/?q=${q}`,
          ...prod.slugs.map(sl => `https://${dom}/search/${sl}`),
          `https://${dom}/search?query=${q}`,
          `https://${dom}/search?keyword=${q}`];
}

// ============================================================
// 探针 4:路径枚举(兜底)
// ============================================================
function guessUrls(dom, prod) {
  const bases = ['/tool/', '/tools/', '/listing/', '/listings/', '/product/', '/products/',
                 '/ai/', '/p/', '/app/', '/apps/', '/site/', '/sites/', '/item/', '/detail/', '/'];
  // 每个 slug 再派生常见后缀变体(目录站爱把类目缀在 slug 后面)
  const slugs = uniq(prod.slugs.flatMap(s => [s, `${s}-ai`, `${s}-app`, `${s}-tool`]));
  const out = [];
  for (const b of bases) for (const sl of slugs) out.push(`https://${dom}${b}${sl}`);
  return uniq(out);
}

// ============================================================
// 廉价预筛:path_guess/site_search 候选先用无渲染 GET 过一遍,
// 只把"可能有戏"的交给浏览器。判定必须保守:只有能确定排除的才丢,
// 拿不准一律留给渲染(SPA、403、超时)。
// ============================================================
const SPA_HINT = /__NEXT_DATA__|id="root"|id="app"|ng-app|data-reactroot|window\.__NUXT__/i;

// 【修】并发上限。guessUrls 会产 15 bases × 8 slug 变体 = 120 个候选,原实现一个
// Promise.all 全放出去 —— 对单一目标站的瞬时突发,WAF/限流几乎必中(而本项目在
// driver 里专门写了"纪律:域间不连投",核验这边却对同一个站开 120 并发)。
// 6 路够快,又不像扫描器。
const PREFILTER_CONCURRENCY = +(process.env.VERIFY_PREFILTER_CONCURRENCY || 10);
// 预筛整段的墙钟预算。**光靠并发上限挡不住超时**:120 个候选 / 并发 6 / 单请求 9s
// 最坏就是 180s,正好等于下面单域看门狗的 180s 硬顶,而 Promise.race 又不会取消
// 已经发出的请求 —— 于是"为了不打扰目标站"反倒把整域拖成 unknown。
// 现在:并发 10 + 单请求 6s + 整段 40s 预算,到点就把剩下的候选当"没排除掉"交给渲染。
const PREFILTER_BUDGET_MS = (() => {
  // 【修】NaN/Infinity 会让截止时间失效;0/负数会把全部候选直接送去浏览器渲染
  // (最多 8 次 × 25s 导航,撞 180s 看门狗)。钳到 [5s, 120s],非法回落 40s。
  const n = Number(process.env.VERIFY_PREFILTER_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 5000), 120000) : 40000;
})();
const PREFILTER_TIMEOUT_MS = 6000;
// 单域总预算:必须明显小于 run() 里那个 180s 单域看门狗,给收尾留出余量。
const DOMAIN_BUDGET_MS = (() => {
  const n = Number(process.env.VERIFY_DOMAIN_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 10000), 170000) : 140000;
})();

async function mapLimit(items, limit, fn) {
  // 【修】NaN → Math.min(NaN,n)=NaN → Array.from({length:NaN}) 是空数组 → **0 个 worker,
  // 所有候选被静默丢弃**;Infinity → 恢复 120 并发。env 配错不能变成静默错误。
  const n = Number(limit);
  const safe = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 32) : 6;
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.max(1, Math.min(safe, items.length)) }, async () => {
    for (;;) {
      const { value, done } = it.next();
      if (done) return;
      await fn(value);
    }
  });
  await Promise.all(workers);
}

async function cheapPrefilter(urls, prod, limit = 8, deadlineAt = null) {
  const keep = [];   // 高优先:静态 HTML 里已经出现产品名
  const maybe = [];  // 低优先:排除不掉,需要渲染
  let resolved = 0;  // 拿到明确 HTTP 结论的次数 —— 用于证明"确实看过",不是没连上
  let skipped = 0;   // 超预算没来得及探的
  // 【修】原来每次调用各自重置预算 —— path_guess 与 site_search 两轮就是 2×40s。
  // 改成整域共享一个截止时刻(调用方传入)。
  const deadline = deadlineAt || (Date.now() + PREFILTER_BUDGET_MS);
  await mapLimit(urls, PREFILTER_CONCURRENCY, async (u) => {
    if (Date.now() > deadline) { maybe.push(u); skipped++; return; }  // 预算到点:不敢排除
    let r;
    try { r = await get(u, { timeout: PREFILTER_TIMEOUT_MS }); }
    catch { maybe.push(u); return; }              // 网络异常 → 不敢排除
    // 【修】被挡的不计 resolved:resolved 喂给"证据是否充分"的门槛,
    // 而 403/429 恰恰说明我们没看到内容。原来它先 resolved++ 再判,等于把限流当证据。
    if (r.status >= 400 && r.status !== 404 && r.status !== 410) { maybe.push(u); return; }
    resolved++;
    if (r.status === 404 || r.status === 410) return;      // 站方明说没有这个资源 → 丢
    const body = r.text || '';
    if (body.toLowerCase().includes(prod.slug)) { keep.push(u); return; }
    // 静态 HTML 里没有产品名:是 SPA 壳子就留给渲染,是实打实的完整页面就丢
    if (SPA_HINT.test(body) || body.length < 1500) maybe.push(u);
  });
  if (skipped) console.log(`  [verify] 预筛超 ${PREFILTER_BUDGET_MS / 1000}s 预算,`
    + `${skipped}/${urls.length} 个候选未探(按"排除不掉"处理,不影响判死门槛)`);
  return { urls: [...keep, ...maybe].slice(0, limit), resolved };
}

// ============================================================
// 页面级判定:找指向目标域的 <a href>,并抓全 SEO 价值字段
// ============================================================
async function inspect(pg, url, prod) {
  let resp;
  try {
    resp = await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (e) {
    return { error: `nav:${String(e.message).slice(0, 120)}` };
  }
  if (!resp) return { error: 'nav:no-response' };
  const status = resp.status();
  const xrobots = resp.headers()['x-robots-tag'] || '';
  // 【修】原来 >=400 一律 notFound,而调用方在此之后就置了 sawAnyPage=true ——
  // 一个对所有路径回 403 的 WAF(或 429 限流)于是同时满足"看过页面"和"探到明确结论",
  // 直接把域推向 offline_confirmed → 三次 → failed。**拿不到内容 ≠ 页面不存在**:
  // 403/429/5xx 是"我们被挡在外面",只有 404/410 才是站方说"没有这个页"。
  // 【二修】上一版写的是"403/429/5xx 算 blocked,其余 >=400 算 notFound",但注释声称
  // "只有 404/410 才是不在" —— 实现与注释不符:401(要登录)、400、408、451 全被当成
  // "页面不存在",120 个 401 的桩测最终得到 offline_confirmed,三次就把正常域写成 failed。
  // 现在**按白名单**:只有站方明说"没有这个资源"的才算不在,其余一律"我们没看着"。
  if (status === 404 || status === 410) return { status, xrobots, notFound: true };
  if (status >= 400) return { status, xrobots, blocked: true };

  const scan = () => pg.evaluate((host) => {
    // 本函数序列化进浏览器执行,必须自包含,不能引模块
    const inRoot = (h) => {
      h = String(h || '').toLowerCase().replace(/^www\./, '');
      return h === host || h.endsWith('.' + host);
    };
    const anchors = [...document.querySelectorAll('a[href]')].map((a) => ({
      raw: a.getAttribute('href'),
      href: a.href,
      rel: (a.getAttribute('rel') || '').toLowerCase(),
      cls: (a.getAttribute('class') || '').toLowerCase(),
      text: (a.innerText || a.textContent || '').trim().slice(0, 120),
      // 侧栏/widget 里的锚是站框回显(recent comments 里的评论者链),不是收录证据
      chrome: !!(a.closest('aside, [class*="widget"], [class*="sidebar"], #secondary, footer')),
    }));
    const direct = anchors.filter((a) => {
      try { return inRoot(new URL(a.href).hostname); }
      catch { return false; }
    });
    // 跳转型外链:/go/123、/out?url=…、/visit/… 这类中转,需要跟随才知道去哪
    const redirectish = anchors.filter((a) =>
      /\/(go|out|visit|redirect|link|ref|away)\b|[?&](url|to|target|redirect)=/i.test(a.raw || ''));
    // 评论 permalink:优先「与目标锚同一个 widget 项」的那条
    const commentPermalinks = [];
    for (const a of document.querySelectorAll('a[href*="#comment-"]')) {
      try { if (new URL(a.href).hostname !== location.hostname) continue; } catch { continue; }
      const near = a.closest('article,li');
      const ours = near && [...near.querySelectorAll('a[href]')].some((x) => {
        try { return inRoot(new URL(x.href).hostname); } catch { return false; }
      });
      if (ours) commentPermalinks.unshift(a.href);
      else if (commentPermalinks.length < 6) commentPermalinks.push(a.href);
    }
    const meta = document.querySelector('meta[name="robots"]');
    const canon = document.querySelector('link[rel="canonical"]');
    return {
      direct,
      redirectish: redirectish.slice(0, 12),
      commentPermalinks,
      robots: meta ? (meta.content || '').toLowerCase() : '',
      canonical: canon ? canon.href : '',
      title: (document.title || '').slice(0, 120),
      bodyHasName: new RegExp(host.split('.')[0], 'i').test(document.body ? document.body.innerText : ''),
      // 搜索页"无结果"判负(多语种):有这行字,页面上任何锚都不足为证
      nothingFound: /(nothing found|no results|niets gevonden|nichts gefunden|aucun r[ée]sultat|no se encontr|nic znaleziono|没有找到|見つかりません)/i
        .test(document.body ? document.body.innerText : ''),
    };
  }, prod.host);

  await pg.waitForTimeout(1800); // 给 SPA 一点渲染时间
  const info = await scan();

  // WP 评论分页:新评论落在最后一页,只看第 1 页会把真上线的评论判成"确认未上线"。
  // 无直链但页面有 comment-page 分页时,翻到最后一页再扫。
  if (!(info.direct || []).length) {
    const lastPage = await pg.evaluate(() => {
      const best = [...document.querySelectorAll('a[href*="comment-page-"]')]
        .map((a) => ({ n: +(((a.getAttribute('href') || '').match(/comment-page-(\d+)/)) || [0, 0])[1], href: a.href }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)[0];
      return best ? best.href : null;
    }).catch(() => null);
    if (lastPage) {
      const r2 = await pg.goto(lastPage, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null);
      if (r2 && r2.ok()) {
        await pg.waitForTimeout(1500);
        const info2 = await scan();
        if ((info2.direct || []).length) {
          info2.paginated_comment_page = true;   // 证据里留痕:是在评论分页最后页找到的
          return { status: r2.status(), xrobots, ...info2 };
        }
      }
    }
  }
  return { status, xrobots, ...info };
}

/** 跟随中转链,看最终是不是落到目标域 */
async function resolveRedirect(href, prod) {
  try {
    const r = await get(href, { timeout: 8000 });
    if (og.hostInRoot(new URL(r.url).hostname, prod.host)) return r.url;
  } catch {}
  return null;
}

// ============================================================
// 单域核验主流程
// ============================================================
async function verifyDomain(pg, dom, prod) {
  const tried = [];
  const t0 = Date.now();
  let networkErrors = 0;
  let sitemapsRead = 0;
  let probedPages = 0;   // 拿到明确 HTTP 结论的页面数(渲染的 + 预筛的)
  let blockedPages = 0;  // 被挡回(非 404/410)的页面数 —— 不算证据,只用于解释判不了
  let truncated = false;   // 候选没检查完(超预算/中途收兵)—— 只要为 true 就绝不判死
  const prefilterDeadline = Date.now() + PREFILTER_BUDGET_MS;   // 整域共享,不是每轮重置
  // 【修】光给预筛设预算不够:预筛超时后剩下的候选全进 maybe,再逐个走浏览器导航
  // (最多 8 个 × NAV_TIMEOUT 25s = 200s),40+200 仍然超过下面的 180s 单域看门狗,
  // 而 Promise.race 不会取消后台的核验。这里给**整域**一个渲染截止时刻,
  // 到点就停止再开新页(已开的那次跑完为止)。
  const domainDeadline = Date.now() + DOMAIN_BUDGET_MS;

  // 候选 URL 按探针优先级排队
  const plans = [];
  const rec = oracleRecorded(dom, prod);
  if (rec.length) plans.push(['recorded_url', rec]);
  let sm = { urls: [], sitemapsRead: 0 };
  try { sm = await oracleSitemap(dom, prod); } catch { networkErrors++; }
  sitemapsRead = sm.sitemapsRead;
  if (sm.urls.length) plans.push(['sitemap', sm.urls]);
  // 路径枚举排在站内搜索之前:枚举命中的是详情页(可索引、是站方真正的收录页),
  // 搜索结果页通常 noindex、且历史上出过"搜索回显被当成上线"的假阳性,只当兜底。
  plans.push(['path_guess', guessUrls(dom, prod)]);
  plans.push(['site_search', searchUrls(dom, prod)]);

  let best = null;
  let sawAnyPage = false;

  for (const [oracle, urls0] of plans) {
    tried.push(oracle);
    // recorded_url / sitemap 是站方或历史实证给出的确切地址,直接渲染;
    // path_guess / site_search 是我们猜的,先无渲染预筛再说。
    let urls = urls0;
    if (oracle === 'path_guess' || oracle === 'site_search') {
      try {
        const pf = await cheapPrefilter(urls0, prod, 8, prefilterDeadline);
        urls = pf.urls;
        if (pf.resolved > 0) probedPages += pf.resolved; // 预筛拿到明确 404 也算"看过"
      } catch { urls = urls0.slice(0, 6); networkErrors++; }
      if (!urls.length) continue;
    }
    for (const url of urls) {
      if (Date.now() > domainDeadline) {
        // 【修】原来只 break,没记"候选没看完" —— sitemap 可读时结尾仍因
        // sitemapsRead > 0 判"证据充分",在目标链接根本还没检查的情况下给出
        // offline_confirmed(桩测证据只有 sitemaps_read=1, probed_pages=1),
        // 连续三轮就把正常站写成 failed。截断过就**绝不判死**。
        truncated = true;
        console.log(`  [verify] ${dom} 超单域渲染预算(${DOMAIN_BUDGET_MS / 1000}s),`
          + `停止再开新页;已探 ${probedPages} 页、被挡 ${blockedPages} 页 —— 本轮不判死`);
        break;
      }
      const r = await inspect(pg, url, prod);
      if (r.error) { networkErrors++; continue; }
      // 被挡(403/429/5xx)既不算"看过页面"也不算"明确结论" —— 它只说明我们进不去。
      if (r.blocked) { blockedPages++; continue; }
      probedPages++;
      // 【修】原来在判 notFound **之前**就置 sawAnyPage —— 一个渲染出来的 404 也算
      // "真看过页面",于是 sawAnyPage 守卫形同虚设(实测:1 个 recorded 404 + 120 个
      // 预筛 404 → probed_pages=121 → offline_confirmed,三轮把伪装 404 的正常站写成 failed)。
      // sawAnyPage 的本意是"我们确实拿到过一个**正常的**页面",404 不是。
      if (r.notFound || r.nothingFound) continue;   // 搜索页"无结果"文案=判负
      sawAnyPage = true;

      let anchors = r.direct || [];
      // 侧栏/widget 回显锚全 oracle 不算数:真评论的作者链在评论区(非 widget),
      // widget 只作回显,误杀面为零。
      anchors = anchors.filter((a) => !a.chrome);
      let hrefRaw = null, resolved = null;

      // 页面没有直链,但有中转链且正文提到产品 → 跟随中转确认
      if (!anchors.length && r.bodyHasName && (r.redirectish || []).length) {
        for (const a of r.redirectish.slice(0, 6)) {
          const fin = await resolveRedirect(a.href, prod);
          if (fin) { anchors = [{ ...a, href: fin }]; hrefRaw = a.raw; resolved = fin; break; }
        }
      }
      if (!anchors.length) continue;

      // 选最有代表性的一条:优先评论作者链(class=url,规范位置) > 带 rel 的显式标记 >
      // 无 rel 回显,再按 dofollow 和锚文本非空排序
      const scored = anchors.map((a) => ({
        ...a,
        wp: (a.cls || '').split(/\s+/).includes('url') ? 0 : 1,
        norel: a.rel ? 1 : 0,
        nf: /nofollow|ugc|sponsored/.test(a.rel) ? 1 : 0,
      })).sort((a, b) => a.wp - b.wp || a.norel - b.norel || a.nf - b.nf || (b.text.length - a.text.length));
      const a = scored[0];

      const pageNofollow = /nofollow/.test(r.robots) || /nofollow/i.test(r.xrobots);
      const noindex = /noindex/.test(r.robots) || /noindex/i.test(r.xrobots);

      best = {
        result: 'online',
        oracle,
        source_url: url,
        source_http: r.status,
        anchor_text: a.text,
        rel: a.rel,
        href_raw: hrefRaw || a.raw,
        resolved_url: resolved || a.href,
        dofollow: (!/nofollow|ugc|sponsored/.test(a.rel) && !pageNofollow) ? 1 : 0,
        indexable: noindex ? 0 : 1,
        robots_meta: r.robots,
        x_robots: r.xrobots,
        canonical: r.canonical,
        evidence: {
          title: r.title,
          anchors_found: anchors.length,
          all_rels: uniq(anchors.map((x) => x.rel || '(none)')),
          is_search_page: oracle === 'site_search',
          sitemaps_read: sitemapsRead,
          elapsed_ms: Date.now() - t0,
        },
      };
      // 命中页的锚可能只是「最新评论 widget」回显 —— 只要命中页上有评论 permalink,
      // 就回评论的规范位置重读 rel/锚文本(与 oracle 无关)。
      if ((r.commentPermalinks || []).length) {
        const cp = await inspect(pg, r.commentPermalinks[0], prod).catch(() => null);
        if (cp && (cp.direct || []).length) {
          const a2 = cp.direct.map((x) => ({
            ...x,
            wp: (x.cls || '').split(/\s+/).includes('url') ? 0 : 1,
            norel: x.rel ? 1 : 0,
            nf: /nofollow|ugc|sponsored/.test(x.rel) ? 1 : 0,
          })).sort((p, q) => p.wp - q.wp || p.norel - q.norel || p.nf - q.nf || (q.text.length - p.text.length))[0];
          best.rel = a2.rel;
          best.dofollow = /nofollow|ugc|sponsored/.test(a2.rel) ? 0 : 1;
          best.anchor_text = a2.text || best.anchor_text;
          best.evidence.rel_from_comment_permalink = true;
        }
      }
      break;
    }
    if (best) break;
  }

  if (best) return { ...best, oracles_tried: tried.join(',') };

  // 没找到 —— 严格区分"确实没有"和"根本没看着"。判死的门槛必须高于判活。
  if (!sawAnyPage && probedPages === 0) {
    // 【修】全被 403/401 挡回时,原来一律报 unknown_network 且写"网络错误 0 次" ——
    // 归因错了:那是被封,不是网络不通。两种情况分开说,便于人判断要不要换出口。
    const isBlocked = blockedPages > 0 && blockedPages >= networkErrors;
    return { result: isBlocked ? 'unknown_blocked' : 'unknown_network',
             oracles_tried: tried.join(','),
             error: isBlocked
               ? `全部候选页被挡回(${blockedPages} 页 4xx/5xx,非 404/410),疑似 WAF/限流/需登录`
               : `全部候选页不可达(网络错误 ${networkErrors} 次)`,
             evidence: { sitemaps_read: sitemapsRead, probed_pages: 0,
                         blocked_pages: blockedPages, network_errors: networkErrors } };
  }
  // offline_confirmed 的门槛:sitemap 可读(能拿到站方的全量 URL 清单),
  // 或者至少探到过 10 个明确 HTTP 结论的页面。达不到就是 unknown_blocked,不判死。
  // 【修】加 sawAnyPage:probedPages 把预筛拿到的 404 也算进来,而 path_guess 一次就
  // 产 120 个候选 —— 一个对所有路径都回 404 的 WAF,轻松把 >=10 撑满,于是"证据充分"
  // 恒真、unknown_blocked 近乎死代码,域被一路推向 offline_confirmed → 三次 → failed。
  // 现在要求**至少真渲染看过一个页面**(证明站是活的、我们确实进得去),再谈判死。
  // truncated:候选没走完就收兵了,无论 sitemap 读没读到都不能说"确认不在"
  const strong = !truncated && (sitemapsRead > 0 || (sawAnyPage && probedPages >= 10));
  return {
    result: strong ? 'offline_confirmed' : 'unknown_blocked',
    oracles_tried: tried.join(','),
    error: strong ? null
      : `证据不足以判定未上线(sitemap 读到 ${sitemapsRead} 个,探到 ${probedPages} 页,`
        + `被挡 ${blockedPages} 页,网络错误 ${networkErrors} 次`
        + `${truncated ? ',且候选未检查完(超单域预算)' : ''})`,
    evidence: { sitemaps_read: sitemapsRead, probed_pages: probedPages,
                blocked_pages: blockedPages, network_errors: networkErrors,
                truncated },
  };
}

// ============================================================
// 主程序
// ============================================================
async function launchBrowser() {
  const opts = { headless: true, proxy: PROXY ? { server: PROXY } : undefined };
  if (process.env.CHROME_BIN) {
    return chromium.launch({ ...opts, executablePath: process.env.CHROME_BIN });
  }
  try {
    return await chromium.launch({ ...opts, channel: 'chrome' });
  } catch {
    return chromium.launch(opts);   // playwright 管理的 chromium
  }
}

async function run(prod, argv) {
  const flag = (n) => argv.includes(n);
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

  // 位置参数 = 既不是 --flag、也不是带值 flag 的那个值
  const VALUE_FLAGS = new Set(['--json', '--concurrency', '--kit']);
  const doms0 = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { if (VALUE_FLAGS.has(a)) i++; continue; }
    doms0.push(a);
  }
  let doms = doms0;
  if (flag('--pending')) {
    // delivery_ambiguous 入待核验清单:终核是唯一能解开"到底投没投进去"的机制,
    // 链接在线即 --update-status 抬成 success,歧义自动消除。
    doms = db.domainsWithStatus(['pending_review', 'emailed', 'success', 'delivery_ambiguous']);
  } else if (flag('--known')) {
    doms = db.knownOnlineDomains();
  }
  doms = uniq(doms.map((d) => { try { return db.canonDomain(d); } catch { return null; } }).filter(Boolean));
  if (!doms.length) {
    console.log(`  产品 ${prod.name} 无待核验域名,跳过`);
    return { skipped: true };
  }

  console.log(`核验产品 ${prod.name}(${prod.host}),共 ${doms.length} 个域\n`);
  await probeProxy();   // 代理死了自动回退直连
  let browser = await launchBrowser();
  let ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA });
  // 流量治理:核验只看 DOM/文本,image/media/font 整类拦
  await ctx.route('**/*', (r) => {
    const t = r.request().resourceType();
    return (t === 'image' || t === 'media' || t === 'font') ? r.abort() : r.continue();
  });
  const report = [];
  const tally = {};

  for (const dom of doms) {
    let r;
    try {
      // 单域看门狗(连开页一起包):无头浏览器崩了 ctx.newPage() 会永久挂起
      r = await Promise.race([
        (async () => {
          const pg = await ctx.newPage();
          pg.setDefaultTimeout(NAV_TIMEOUT);
          try { return await verifyDomain(pg, dom, prod); }
          finally { await pg.close().catch(() => {}); }
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('单域核验超 180s(含开页)')), 180000)),
      ]);
    } catch (e) {
      r = { result: 'unknown_network', error: `核验器异常: ${String(e.message).slice(0, 150)}`,
            oracles_tried: '' };
      // 浏览器可能已死:探活,死了重启一次,重启失败整批 abort
      if (!browser.isConnected()) {
        console.log('  !! 浏览器连接已死,重启一次');
        try {
          browser = await launchBrowser();
          ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA });
        } catch (e2) {
          console.log(`  !! 浏览器重启失败(${String(e2.message).slice(0, 80)}),整批中止`);
          throw e2;
        }
      }
    }

    db.recordVerification({ domain: dom, ...r });
    tally[r.result] = (tally[r.result] || 0) + 1;
    report.push({ domain: dom, ...r });

    const badge = r.result === 'online'
      ? (r.dofollow ? (r.indexable ? '✅ 算数' : '⚠️ dofollow 但 noindex') : '⚠️ 上线但 nofollow')
      : (r.result === 'offline_confirmed' ? '❌ 确认未上线' : '❓ 判不了');
    console.log(`${badge.padEnd(22)} ${dom.padEnd(30)} ${r.oracle || ''} ${r.source_url || r.error || ''}`.slice(0, 170));
    if (r.result === 'online') console.log(`${' '.repeat(23)}rel="${r.rel || '(none)'}" robots="${r.robots_meta || '-'}" → ${r.resolved_url}`.slice(0, 170));

    // 只有明确要求时才动状态(经 state.mjs 守卫);unknown_* 一律不改
    if (flag('--update-status')) {
      if (r.result === 'online' && r.dofollow) {
        db.upsertSubmission({ domain: dom, status: 'success',
          evidence: `verify_link ${r.oracle}: ${r.source_url} rel="${r.rel || '(none)'}" dofollow=1 indexable=${r.indexable}`,
          source: 'verify_link', reason_code: 'published' });
      } else if (r.result === 'online') {
        // 上线但 nofollow/ugc:收录属实但不传权,保持 pending_review 不抬 success
        db.upsertSubmission({ domain: dom, status: 'pending_review',
          evidence: `verify_link: 已收录但 rel="${r.rel}" 不传权(${r.source_url})`,
          source: 'verify_link', reason_code: 'published' });
      } else if (r.result === 'offline_confirmed') {
        // 【生产口径,来自真实事故,勿退回单次判死】生产 dbw.recordVerification:
        // offline_confirmed 只累加 link_facts.miss_streak,**连续 3 次才落 lost_at**
        // —— "绝不用单次核验判死"。这里同口径:verifications.jsonl 尾部连续
        // offline_confirmed(含本次,本次已在上面 recordVerification 落行)≥ 3 才写
        // failed(delisted 权威理由过守卫);不足 3 次保持原状不动。
        // unknown_* 一律不动:网络/封禁问题不是站的结论,绝不用判不了的核验改状态。
        let streak = 0;
        for (const row of db.verificationRows(dom).slice().reverse()) {
          if (row.result === 'offline_confirmed') streak++;
          else break;
        }
        if (streak >= 3) {
          db.upsertSubmission({ domain: dom, status: 'failed',
            evidence: `verify_link 连续 ${streak} 次确认未上线(oracles: ${r.oracles_tried})`,
            source: 'verify_link', reason_code: 'delisted' });
        } else {
          console.log(`${' '.repeat(23)}offline_confirmed ${streak}/3,未到判死线,状态不动`);
        }
      }
    }
  }

  await browser.close();

  const outDir = path.join(HERE, 'run',
    `verify-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = val('--json', path.join(outDir, `verify_link_${Date.now()}.json`));
  fs.writeFileSync(outFile, JSON.stringify({
    generated_at: db.nowUtc(), product: prod, count: doms.length, tally, report,
  }, null, 2));

  console.log(`\n小结: ${JSON.stringify(tally)}`);
  console.log(`报告: ${outFile}`);
  return tally;
}

(async () => {
  const argv = process.argv.slice(2);
  // 用法错误在入口判:选择器一个都没给才是用错了
  const positional = argv.filter((x) => !x.startsWith('--'));
  if (!argv.includes('--pending') && !argv.includes('--known') && !positional.length) {
    console.log('用法: node verify_link.mjs [--kit kit.json] --pending | --known | <domain>...');
    process.exit(2);
  }
  const prod = loadProduct(argv);
  const r = await run(prod, argv);
  if (r && r.skipped) process.exit(3);   // 无待核域:非零退出,cron 能发现"什么也没做"
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
