// creds.mjs — 站点注册凭据的并发安全读写(2026-08-16 从生产 creds.js 移植)
//
// 移植改动:凭证文件路径从私仓 db/creds.json 改为 outreach/creds.json
// (env OUTREACH_CREDS 可覆盖);账号策略注释里的私仓实证细节删去,机制不变。
//
// 为什么需要锁:无锁的 读→改→整文件覆写 在两个进程并发注册不同站点时,
// 后写的会把先写的那条抹掉,账号密码永久丢失且无声。
// 两条保障:
//   1. 排他锁:同目录 .creds.lock,O_EXCL 创建;陈旧锁(持锁进程已死)自动接管;
//      锁文件带随机 token+pid,release 只删仍是自己的锁。
//   2. 原子写:写临时文件 → fsync → rename(读者要么见旧版要么见新版,不见半截)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CREDS = process.env.OUTREACH_CREDS || path.join(HERE, 'creds.json');
export const LOCK = path.join(path.dirname(CREDS), '.creds.lock');
const MODE = 0o600;                 // 含密钥,不给同组/其他人读
const LOCK_STALE_MS = 30_000;       // 超过 30 秒且持锁进程已死的锁认定为崩溃残留
const LOCK_WAIT_MS = 15_000;
const RETRY_MS = 50;

let myToken = null;                 // 本进程当前持有的锁 token(release 只删自己的)

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function lockPid(content) {
  const f = (content || '').trim().split(/\s+/).find(x => /^\d+$/.test(x));
  return f ? Number(f) : null;
}

function acquire() {
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, 'wx');       // O_CREAT|O_EXCL:已存在就抛
      const token = crypto.randomUUID();
      fs.writeSync(fd, `${token} ${process.pid} ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      myToken = token;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 陈旧锁接管:rename 成只有自己知道的名字 = 原子偷,抢到的人才有权删。
      try {
        const age = Date.now() - fs.statSync(LOCK).mtimeMs;
        if (age > LOCK_STALE_MS) {
          const pid = lockPid(fs.readFileSync(LOCK, 'utf8'));
          if (pid && pidAlive(pid)) {
            // 持锁进程还活着:mtime 陈旧不算数,不能偷
          } else {
            const grave = `${LOCK}.stale.${crypto.randomUUID()}`;
            try { fs.renameSync(LOCK, grave); fs.unlinkSync(grave); } catch { /* 抢输/已被接管 */ }
            continue;
          }
        }
      } catch { /* 锁刚被别人释放,下一轮就能抢到 */ }
      if (Date.now() - t0 > LOCK_WAIT_MS) {
        throw new Error(`creds.json 锁等待超时(${LOCK_WAIT_MS}ms),疑似死锁: ${LOCK}`);
      }
      sleepSync(RETRY_MS);
    }
  }
}

function release() {
  const tok = myToken;
  myToken = null;
  if (!tok) return;
  try {
    const cur = fs.readFileSync(LOCK, 'utf8').trim().split(/\s+/)[0];
    if (cur === tok) fs.unlinkSync(LOCK);
  } catch { /* 已被陈旧接管/已释放,无所谓 */ }
}

/** 只读。不加锁 —— 原子 rename 保证读到的一定是某个完整版本。 */
export function read() {
  try {
    return JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

/** 原子写:临时文件 → fsync → rename */
export function writeAtomic(obj) {
  const tmp = `${CREDS}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, 'w', MODE);
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, MODE);
    fs.renameSync(tmp, CREDS);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/** 加锁的读改写。fn 收到锁内重新读取的最新对象;fn 抛错则不写入。 */
export function update(fn) {
  acquire();
  try {
    const obj = read();
    const ret = fn(obj);
    writeAtomic(obj);
    return ret;
  } finally {
    release();
  }
}

/** 便捷:取某个域名的凭据(只读) */
export function get(k) { return read()[k]; }

/* ============================================================
   账号键策略

   默认:账号**按站共享**,键就是域名 —— 一个站一个账号,全产品复用。
   例外:站方限制"一个账号只能收录一个产品"时,才给该产品单开账号,
        键为 `<域名>#<产品slug>`。
   ============================================================ */
export const perProductKey = (dom, slug) => `${dom}#${slug}`;

/** 取该站该产品应使用的账号键。已存在产品专属账号就用它,否则用共享键。 */
export function accountKey(dom, slug) {
  if (!slug) return dom;
  const all = read();
  return all[perProductKey(dom, slug)] ? perProductKey(dom, slug) : dom;
}

/** 站方限制一账号一产品时调用:把该站该产品切成独立账号。
 *
 * ⚠️ `email` 必须传**该产品自己的**地址,否则站方看到的还是同一个邮箱,
 * 照样判为已有账号 —— 一账号一产品的限制根本没绕过。
 */
export function forkAccount(dom, slug, reason, email) {
  const addr = String(email || '').trim();
  return update((creds) => {
    const key = perProductKey(dom, slug);
    if (creds[key]) return key;                       // 已经分过,幂等
    const shared = (creds[dom] || {}).email || '';
    if (!addr) {
      throw new Error(`creds.forkAccount(${dom}, ${slug}): 必须给该产品自己的邮箱 —— `
        + `复用共享邮箱 ${shared || '(空)'} 等于没分账号`);
    }
    if (addr.toLowerCase() === shared.toLowerCase()) {
      throw new Error(`creds.forkAccount(${dom}, ${slug}): 邮箱 ${addr} 与共享账号相同,`
        + `站方仍会识别为已有账号`);
    }
    creds[key] = {
      user: slug, email: addr, pass: null,
      via: '站方限制一账号一产品,单开', reason: String(reason || '').slice(0, 200),
      at: new Date().toISOString().slice(0, 10),
    };
    return key;
  });
}

/** 该站该产品实际应使用的登录邮箱。有产品专属账号就用它的,否则用传入的默认值。 */
export function accountEmail(dom, slug, fallback) {
  const all = read();
  const k = perProductKey(dom, slug);
  return (all[k] && all[k].email) || (all[dom] && all[dom].email) || fallback || '';
}
