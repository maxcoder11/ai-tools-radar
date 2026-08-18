// Node 侧关键路径冒烟(被 smoke.sh 调用)。见 smoke.sh 顶部注释。
const D = process.env.OUTREACH_STATE_DIR;
const res = [];
const t = async (name, fn) => {
  try { await fn(); res.push([true, name, '']); }
  catch (e) { res.push([false, name, `${e.constructor.name}: ${String(e.message).split('\n')[0].slice(0, 80)}`]); }
};

const db = await import('../state.mjs');
await t('upsertSubmission', () => db.upsertSubmission({ domain: 'a.com', status: 'pending_review', source: 's' }));
await t('currentStatus', () => { if (db.currentStatus('a.com').status !== 'pending_review') throw new Error('读回不对'); });
await t('守卫拦截', () => { if (!db.upsertSubmission({ domain: 'a.com', status: 'blocked', source: 's' }).blockedRegression) throw new Error('投达态被打回了'); });
await t('历史 raw 键归一', () => { if (db.currentStatus('WWW.A.com').status !== 'pending_review') throw new Error('行侧未归一'); });
await t('claimDelivery 拒投达', () => { if (db.claimDelivery({ domain: 'a.com', source: 's' }).claimed) throw new Error('投达态不该放行'); });
await t('claimDelivery 放行', () => { if (!db.claimDelivery({ domain: 'new.com', source: 's' }).claimed) throw new Error('新域该放行'); });
await t('claimDelivery 二次挡', () => { if (db.claimDelivery({ domain: 'new.com', source: 's' }).claimed) throw new Error('二次认领必须挡住'); });
await t('recordEvent', () => db.recordEvent({ domain: 'a.com', event_type: 'note', source: 's' }));
await t('add/activeConstraints', () => { db.addConstraint({ domain: 'a.com', reason_code: 'entry_404' }); db.activeConstraints('a.com'); });
await t('humanTaskAdd/pending', () => { db.humanTaskAdd({ domain: 'a.com', blocker: 'x' }); db.pendingHumanTasks(); });
await t('ensureAmbiguousTask', () => db.ensureDeliveryAmbiguousTask({ domain: 'new.com' }));
await t('recordCost/spentToday', () => { db.recordCost({ provider: 'llm', amount_usd: 0.003 }); if (db.spentToday('llm') !== 0.003) throw new Error('成本读回不对'); });
await t('save/loadRecipe', () => { db.saveRecipe('a.com', [{ action: 'fill' }], 'success', 'n'); if (!db.loadRecipe('a.com')) throw new Error('recipe 读不回'); });
await t('recordVerification/rows', () => { db.recordVerification({ domain: 'a.com', result: 'online', source_url: 'u' }); db.verificationRows('a.com'); });
await t('knownOnlineDomains', () => db.knownOnlineDomains());
await t('domainsWithStatus', () => db.domainsWithStatus(['pending_review']));
await t('stateRows', () => db.stateRows('a.com'));
await t('withFileLock', () => db.withFileLock(`${D}/x`, () => 1));
await t('canonDomain', () => { if (db.canonDomain('WWW.A.com') !== 'a.com') throw new Error('canon 不对'); });
// 坏账本必须 fail-closed(曾经被静默跳过 → currentStatus 返回 null → 认领放行)。
// DIR 是模块加载时冻结的,必须起子进程换环境才测得到 —— 别在本进程里假装测过。
await t('坏行 fail-closed', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const bad = `${D}/bad`;
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(`${bad}/state.jsonl`, '{"src":"x.com","status":"success"');   // 截断的 success 行
  const out = execFileSync(process.execPath, ['-e', `
    import('${new URL('../state.mjs', import.meta.url).pathname}').then(d => {
      try { d.claimDelivery({ domain: 'x.com', source: 't' }); console.log('LEAKED'); }
      catch { console.log('THREW'); }
    });`], { env: { ...process.env, OUTREACH_STATE_DIR: bad }, encoding: 'utf8' }).trim();
  if (out !== 'THREW') throw new Error(`截断行没有 fail-closed(子进程输出 ${out})`);
});

// ── 认领闸的生命周期(R13 的 4 条 P1 全在这里,回归必须覆盖)──
await t('终态一律不可再认领', () => {
  for (const [st, dom] of [['manual','m1.com'],['skipped_paid','sp.com'],['skipped_badge','sb.com'],
                           ['skipped_fit','sf.com'],['success','su.com'],['pending_review','pr.com'],
                           ['emailed','em.com']]) {
    db.upsertSubmission({ domain: dom, status: st, source: 't' });
    if (db.claimDelivery({ domain: dom, source: 't' }).claimed) throw new Error(`${st} 竟可再认领`);
  }
});
await t('可重试态仍可认领', () => {
  for (const [st, dom] of [['blocked','b1.com'],['failed','f1.com'],['email_verified','ev.com']]) {
    db.upsertSubmission({ domain: dom, status: st, source: 't' });
    if (!db.claimDelivery({ domain: dom, source: 't' }).claimed) throw new Error(`${st} 该可认领`);
  }
});
await t('已投达域不因 skipped_badge 复活', () => {
  db.claimDelivery({ domain: 'sx.com', source: 'a' });
  db.upsertSubmission({ domain: 'sx.com', status: 'success', source: 'a', reason_code: 'published' });
  db.upsertSubmission({ domain: 'sx.com', status: 'skipped_badge', source: 'm', reason_code: 'badge_required' });
  if (db.claimDelivery({ domain: 'sx.com', source: 'a2' }).claimed) throw new Error('已投达的域变回可认领了');
});
await t('email_verified 两边都认', () => db.upsertSubmission({ domain: 'ev2.com', status: 'email_verified', source: 't' }));
// 落账失败必须把标记撤回,否则该域此后永远认领不了
await t('写账失败 → 标记回滚', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const dir = `${D}/rollback`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/state.jsonl.lock`, `tok pid=${process.pid} now\n`);   // 活进程占住锁
  const url = new URL('../state.mjs', import.meta.url).pathname;
  const out = execFileSync(process.execPath, ['-e', `
    import('${url}').then(d => {
      try { d.claimDelivery({ domain: 'x.com', source: 't' }); } catch {}
      console.log(require('fs').existsSync('${dir}/claims/x.com.claim') ? 'LEAKED' : 'ROLLED');
    });`], { env: { ...process.env, OUTREACH_STATE_DIR: dir }, encoding: 'utf8' }).trim();
  if (out !== 'ROLLED') throw new Error('标记没回滚,该域将永远认领不了');
});
// 锁路径损坏必须抛,不能忙循环(曾经挂到 driver 的 900s 外层超时)
await t('锁路径损坏不忙循环', async () => {
  const fs = await import('node:fs');
  const dir = `${D}/badlock`;
  fs.mkdirSync(`${dir}/s.lock`, { recursive: true });         // 锁路径是目录
  const t0 = Date.now();
  try { db.withFileLock(`${dir}/s`, () => {}, 1000); throw new Error('竟拿到锁'); }
  catch (e) { if (Date.now() - t0 > 3000) throw new Error(`耗时 ${Date.now() - t0}ms,疑似忙循环`); }
});

const lc = await import('../llm_config.mjs');
await t('llm_config.load', () => lc.load());
await t('chatUrl 归一', () => { if (lc.chatUrl('https://x.com') !== 'https://x.com/v1/chat/completions') throw new Error('base URL 未归一'); });
await t('originOf', () => { if (lc.originOf('https://x.com/v1') !== 'https|x.com|443') throw new Error('origin 归一不对'); });
await t('originOf 拒畸形', () => { if (/^https?\|/.test(lc.originOf('https://a\\@b.com/v1'))) throw new Error('畸形地址未拒'); });
await t('mask 不回显全量', () => { if (lc.mask('sk-abcdefghijklmn').includes('defghij')) throw new Error('key 泄漏'); });

const og = await import('../outbound_guard.mjs');
await t('outbound 拒内网', () => { if (og.validateUrlLite('http://127.0.0.1/x')) throw new Error('内网未拦'); });
await t('outbound 拒碰瓷域', () => { if (og.hostInRoot('evil-x.com', 'x.com')) throw new Error('碰瓷域未拦'); });
const ss = await import('../submission_safety.mjs');
await t('回执分类', () => { if (ss.classifyReceiptText('Your submission has been received') !== 'success') throw new Error('回执判不出'); });
await t('回执否定优先', () => { if (ss.classifyReceiptText('Your submission was not received') !== null) throw new Error('否定句未过滤'); });
await t('hasSubmitVerb', () => { if (!ss.hasSubmitVerb('Submit')) throw new Error('x'); });
const wd = await import('../wall_detect.mjs');
await t('hostAllowed 拒外域', () => { if (wd.hostAllowed('evil.com', 'x.com')) throw new Error('未拦'); });
await t('inferConstraint', () => wd.inferConstraint('skipped_paid', ''));
const rt = await import('../agent_submit_runtime.mjs');
await t('makeWatchdogPlan 钳制', () => { if (rt.makeWatchdogPlan(20, 30000).triggerMs >= 20 * 60000) throw new Error('未按硬杀预算钳住'); });
await t('actionResult', () => rt.normalizeActionResult('x'));
const rd = await import('../rootdomain.mjs');
await t('rootDomain(PSL)', () => { if (rd.rootDomain('a.b.example.co.uk') !== 'example.co.uk') throw new Error('得到 ' + rd.rootDomain('a.b.example.co.uk')); });
const cs = await import('../capsolver.mjs');
await t('capsolver.hasKey', () => cs.hasKey());

const bad = res.filter((r) => !r[0]);
for (const [good, name, err] of res) if (!good) console.log(`   ❌ ${name} → ${err}`);
console.log(`   ${res.length - bad.length}/${res.length} 通过${bad.length ? '' : ' ✅'}`);
process.exit(bad.length ? 1 : 0);
