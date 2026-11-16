/**
 * 后台自动续期 + 统一过期解析 + 单账号刷新锁（纯 mock，不联网、不碰真实账号）。
 *
 * 对照上游 channel pack (trae.ts / trae-adapter.ts) 与本地 auto-checkin.js：
 * 验证秒级/ISO/JWT 过期时间不再被判成「永不需续」、并发刷新只发一次、
 * 定时扫描的跳过规则与失败语义、状态文件原子写与脏数据回落。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseExpiryMs, jwtExpiresAtMs, credentialExpiresAtMs,
  isCredentialExpired, expiresWithin, isRefreshable, describeExpiry
} from '../src/credential-expiry.js';
import {
  shouldRefresh, withRefreshLock, clearRefreshLocks, ensureCredential
} from '../src/channels/credential.js';
import {
  sanitizeAutoRenew, createAutoRenewStore, createAutoRenew,
  AUTO_RENEW_FILE, AUTO_RENEW_DELAY_MS, AUTO_RENEW_TICK_MS, AUTO_RENEW_AHEAD_MS,
  autoRenewDelayMs, autoRenewTickMs, autoRenewAheadMs
} from '../src/auto-renew.js';
import { OfmError, Codes } from '../src/errors.js';

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
async function test(name, fn) {
  try { await fn(); } catch (e) { failures.push(`${name}: ${e.message}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-renew-'));
const NOW = Date.now();

/* ───────── 1. 过期时间统一解析 ───────── */
console.log('— 过期时间统一解析 —');

ok('数字毫秒原样', parseExpiryMs(NOW + 3600000) === NOW + 3600000);
ok('数字秒转毫秒', parseExpiryMs(1731484800) === 1731484800 * 1000);
ok('数字字符串秒转毫秒', parseExpiryMs('1731484800') === 1731484800 * 1000);
ok('数字字符串毫秒原样', parseExpiryMs(String(NOW)) === NOW);
ok('ISO 串可解析', parseExpiryMs('2026-11-16T10:00:00Z') === Date.parse('2026-11-16T10:00:00Z'));
ok('空串/空白返回 undefined', parseExpiryMs('  ') === undefined);
ok('非法字符串返回 undefined', parseExpiryMs('not-a-date') === undefined);
ok('负数返回 undefined', parseExpiryMs(-5) === undefined);
ok('null/undefined 返回 undefined', parseExpiryMs(null) === undefined && parseExpiryMs(undefined) === undefined);
ok('0 返回 undefined', parseExpiryMs(0) === undefined);

// 构造一个只带 exp 的 JWT（不验签，仅解码）
const makeJwt = (expSec) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec, uid: 'u' })}.sig`;
};
const jwtSec = Math.floor(NOW / 1000) + 7200;
ok('JWT exp 秒转毫秒', jwtExpiresAtMs(makeJwt(jwtSec)) === jwtSec * 1000);
ok('JWT 非字符串返回 undefined', jwtExpiresAtMs(null) === undefined);
ok('JWT 段数不足返回 undefined', jwtExpiresAtMs('abc') === undefined);
ok('JWT payload 非法返回 undefined', jwtExpiresAtMs('a.!!!.c') === undefined);
ok('JWT 无 exp 返回 undefined', jwtExpiresAtMs(`${Buffer.from('{}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`) === undefined);

ok('凭据优先取 expires_at', credentialExpiresAtMs({ expires_at: NOW + 1000, expire_time: NOW + 9999 }) === NOW + 1000);
ok('回退 expire_time', credentialExpiresAtMs({ expire_time: NOW + 2000 }) === NOW + 2000);
ok('回退 expiresAt', credentialExpiresAtMs({ expiresAt: '1731484800' }) === 1731484800 * 1000);
ok('回退 JWT exp', credentialExpiresAtMs({ access_token: makeJwt(jwtSec) }) === jwtSec * 1000);
ok('回退 token 字段的 JWT', credentialExpiresAtMs({ token: makeJwt(jwtSec) }) === jwtSec * 1000);
ok('全无来源返回 undefined', credentialExpiresAtMs({ access_token: 'opaque' }) === undefined);
ok('非对象返回 undefined', credentialExpiresAtMs('x') === undefined);

const past = { expires_at: NOW - 1000 };
const future = { expires_at: NOW + 7200000 };
ok('已过期判定', isCredentialExpired(past, NOW) === true);
ok('未过期判定', isCredentialExpired(future, NOW) === false);
ok('无过期时间不判过期', isCredentialExpired({ access_token: 'opaque' }, NOW) === false);
ok('expiresWithin 命中 60s 窗口', expiresWithin({ expires_at: NOW + 30000 }, 60000, NOW) === true);
ok('expiresWithin 已过期也算命中', expiresWithin(past, 60000, NOW) === true);
ok('expiresWithin 未到窗口为假', expiresWithin(future, 60000, NOW) === false);
ok('expiresWithin 无过期时间为假', expiresWithin({ access_token: 'opaque' }, 60000, NOW) === false);
ok('isRefreshable 认 refresh_token', isRefreshable({ refresh_token: 'RT' }) === true);
ok('isRefreshable 认 refreshToken', isRefreshable({ refreshToken: 'RT' }) === true);
ok('isRefreshable 空串为假', isRefreshable({ refresh_token: '  ' }) === false);
ok('isRefreshable 无为假', isRefreshable({ access_token: 'AT' }) === false);
ok('describeExpiry 不含凭据值', !describeExpiry({ refresh_token: 'RT_SECRET', expires_at: NOW + 3600000 }, NOW).includes('RT_SECRET'));
ok('describeExpiry 无过期时间', describeExpiry({ access_token: 'opaque' }, NOW) === '无过期时间');

/* ───────── 2. shouldRefresh 用统一解析 ───────── */
console.log('— shouldRefresh 与刷新锁 —');
ok('秒级过期时间也能触发续期（旧实现会漏）', shouldRefresh({ expires_at: String(Math.floor(NOW / 1000) + 30) }, 60000, NOW) === true);
ok('JWT exp 也能触发续期', shouldRefresh({ access_token: makeJwt(Math.floor(NOW / 1000) + 30) }, 60000, NOW) === true);
ok('永久 token 不触发', shouldRefresh({ access_token: 'opaque' }, 60000, NOW) === false);
ok('远期不触发', shouldRefresh(future, 60000, NOW) === false);

await test('withRefreshLock 并发只跑一次', async () => {
  clearRefreshLocks();
  let calls = 0;
  const fn = async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return 'done'; };
  const [a, b, c] = await Promise.all([withRefreshLock('x', fn), withRefreshLock('x', fn), withRefreshLock('x', fn)]);
  ok('三次并发复用同一 Promise', a === 'done' && b === 'done' && c === 'done', `${a}/${b}/${c}`);
  ok('底层函数只调一次', calls === 1, `calls=${calls}`);
  const d = await withRefreshLock('x', fn);
  ok('锁结束后可再次刷新', d === 'done' && calls === 2, `calls=${calls}`);
});

await test('withRefreshLock 失败后释放锁', async () => {
  clearRefreshLocks();
  const boom = async () => { throw new Error('x'); };
  await withRefreshLock('k', boom).catch(() => {});
  let second = 0;
  await withRefreshLock('k', async () => { second += 1; }).catch(() => {});
  ok('失败后能重新进锁', second === 1);
});

await test('ensureCredential force 走锁且回写', async () => {
  clearRefreshLocks();
  const creds = { r1: { access_token: 'OLD', expires_at: NOW - 1000, refresh_token: 'RT' } };
  const accounts = [{ id: 'a1', provider: 'trae', credentialRef: 'r1' }];
  const store = {
    settings: { accounts },
    readCredential: (ref) => creds[ref],
    writeCredential: (ref, data) => { creds[ref] = data; },
    update: (fn) => fn({ accounts })
  };
  let calls = 0;
  const refresh = async () => { calls += 1; return { access_token: 'NEW', expires_at: NOW + 7200000 }; };
  const [x, y] = await Promise.all([
    ensureCredential(store, accounts[0], { refresh, force: true }),
    ensureCredential(store, accounts[0], { refresh, force: true })
  ]);
  ok('并发 force 只刷新一次', calls === 1, `calls=${calls}`);
  ok('两次都拿到新凭据', x.access_token === 'NEW' && y.access_token === 'NEW');
  ok('凭据已回写', creds.r1.access_token === 'NEW');
  ok('账号 expiresAt 已更新', accounts[0].expiresAt === NOW + 7200000);
  ok('needsLogin 清除', accounts[0].needsLogin === false);
});

await test('ensureCredential 传输失败沿用旧凭据且不标 needsLogin', async () => {
  clearRefreshLocks();
  const old = { access_token: 'OLD', expires_at: NOW - 1000, refresh_token: 'RT' };
  const creds = { r2: old };
  const accounts = [{ id: 'a2', provider: 'trae', credentialRef: 'r2' }];
  const store = {
    settings: { accounts },
    readCredential: (ref) => creds[ref],
    writeCredential: (ref, data) => { creds[ref] = data; },
    update: (fn) => fn({ accounts })
  };
  const refresh = async () => { throw new OfmError(Codes.TRANSPORT, 'network down'); };
  const got = await ensureCredential(store, accounts[0], { refresh, force: true });
  ok('返回原凭据对象引用', got === old);
  ok('不标 needsLogin', accounts[0].needsLogin !== true);
});

await test('ensureCredential AUTH 失败标 needsLogin', async () => {
  clearRefreshLocks();
  const creds = { r3: { access_token: 'OLD', expires_at: NOW - 1000, refresh_token: 'RT' } };
  const accounts = [{ id: 'a3', provider: 'trae', credentialRef: 'r3' }];
  const store = {
    settings: { accounts },
    readCredential: (ref) => creds[ref],
    writeCredential: () => {},
    update: (fn) => fn({ accounts })
  };
  const refresh = async () => { throw new OfmError(Codes.AUTH, 'expired'); };
  await ensureCredential(store, accounts[0], { refresh, force: true }).catch(() => {});
  ok('标 needsLogin', accounts[0].needsLogin === true);
});

/* ───────── 3. 状态文件与脏数据 ───────── */
console.log('— 状态文件与脏数据 —');
ok('脏数据 null 回落默认', sanitizeAutoRenew(null).enabled === true);
ok('只有显式 false 才关闭', sanitizeAutoRenew({ enabled: 'false' }).enabled === true && sanitizeAutoRenew({ enabled: false }).enabled === false);
ok('非法 lastAt 归零', sanitizeAutoRenew({ lastAt: -1 }).lastAt === 0);
ok('channels 截断到上限', sanitizeAutoRenew({ channels: Array.from({ length: 100 }, (_, i) => ({ provider: 'p', text: String(i) })) }).channels.length === 64);
ok('channels 过滤非法项', sanitizeAutoRenew({ channels: [null, 3, { provider: 'p' }] }).channels.length === 0);
ok('accounts 忽略数组', Array.isArray(sanitizeAutoRenew({ accounts: [] }).accounts) === false);
ok('accounts 清洗字段', sanitizeAutoRenew({ accounts: { a: { lastAt: 5, outcome: 'ok', junk: 1 } } }).accounts.a.lastAt === 5);

await test('状态文件 tmp+rename 原子写', async () => {
  const dir = tmp();
  const st = createAutoRenewStore(dir, { warn() {} });
  ok('读不存在文件回落默认', st.load().enabled === true && st.load().lastAt === 0);
  st.save({ enabled: true, lastAt: 123, lastResult: 'x', channels: [], accounts: {} });
  ok('落盘文件名固定', fs.existsSync(path.join(dir, AUTO_RENEW_FILE)));
  ok('不留 .tmp', !fs.existsSync(path.join(dir, `${AUTO_RENEW_FILE}.tmp`)));
  ok('回读一致', st.load().lastAt === 123);
  ok('带 schema', JSON.parse(fs.readFileSync(path.join(dir, AUTO_RENEW_FILE), 'utf8')).schema === 'ofm/auto-renew/v1');
  fs.writeFileSync(path.join(dir, AUTO_RENEW_FILE), '{broken');
  ok('损坏文件回落默认', st.load().lastAt === 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('delay 默认 8s', autoRenewDelayMs({}) === AUTO_RENEW_DELAY_MS);
ok('delay env 0 合法', autoRenewDelayMs({ OFM_AUTO_RENEW_DELAY_MS: '0' }) === 0);
ok('delay env 非法回落', autoRenewDelayMs({ OFM_AUTO_RENEW_DELAY_MS: 'abc' }) === AUTO_RENEW_DELAY_MS);
ok('tick env 生效', autoRenewTickMs({ OFM_AUTO_RENEW_TICK_MS: '60000' }) === 60000);
ok('ahead env 生效', autoRenewAheadMs({ OFM_AUTO_RENEW_AHEAD_MS: '900000' }) === 900000);
ok('ahead 默认 >= tick 默认', AUTO_RENEW_AHEAD_MS >= AUTO_RENEW_TICK_MS);

/* ───────── 4. 调度器 ───────── */
console.log('— 调度器扫描与失败语义 —');

function harness(opts = {}) {
  const {
    accounts = [], creds = {}, handlers = {}, clock = () => NOW,
    stateDoc = null, ahead = 45 * 60000, tick = 30 * 60000, delay = 0, retry = 5 * 60000
  } = opts;
  const settings = { accounts };
  const store = {
    settings,
    readCredential: (ref) => creds[ref],
    writeCredential: (ref, data) => { creds[ref] = data; },
    update: (fn) => fn(settings)
  };
  const registry = {
    get(provider) {
      if (provider === 'kilo') return { id: 'kilo', requiresAccount: false, renewable: false };
      if (provider === 'loomy') return { id: 'loomy', requiresAccount: true, renewable: false };
      if (provider === 'ghost') throw new Error('unknown');
      return {
        id: provider, requiresAccount: true, renewable: true,
        credential: async (s, acc, o) => (handlers[provider] || (() => s.readCredential(acc.credentialRef)))(s, acc, o)
      };
    }
  };
  const dir = tmp();
  const stateStore = createAutoRenewStore(dir, { warn() {} });
  if (stateDoc) stateStore.save(stateDoc);
  const logs = [];
  const records = [];
  const scheduled = [];
  const ticks = [];
  const renew = createAutoRenew({
    store, registry, stateStore,
    now: clock, env: {},
    delayMs: delay, tickMs: tick, aheadMs: ahead, retryMs: retry,
    schedule: (fn, ms) => { scheduled.push(ms); return { cancel: () => {} }; },
    scheduleTick: (fn, ms) => { ticks.push({ fn, ms }); return { cancel: () => {} }; },
    warn: (m) => logs.push(m),
    record: (e) => records.push(e)
  });
  return { renew, store, creds, logs, records, scheduled, ticks, dir, stateStore };
}

const expSoon = () => NOW + 10 * 60000; // 10 分钟后过期，落在 45min 窗口内
const expFar = () => NOW + 10 * 3600000;

await test('刷新成功：记 ok 与新的有效期', async () => {
  clearRefreshLocks();
  const creds = { c1: { access_token: 'OLD', expires_at: expSoon(), refresh_token: 'RT' } };
  const h = harness({
    accounts: [{ id: 'a1', provider: 'trae', credentialRef: 'c1' }],
    creds,
    handlers: { trae: async (s) => ({ access_token: 'NEW', expires_at: expFar() }) }
  });
  const r = await h.renew.runIfDue('manual');
  ok('ok 计数 1', r.ok === 1, JSON.stringify(r));
  ok('状态 lastResult 含续期', h.renew.state().lastResult.includes('续期 1'));
  ok('channels 有结果', h.renew.state().channels.length === 1);
  ok('结果文案不含凭据值', !JSON.stringify(h.renew.state().channels).includes('OLD') && !JSON.stringify(h.renew.state().channels).includes('RT'));
  ok('accounts 记 lastOkAt', h.renew.state().accounts.a1.lastOkAt > 0);
  ok('日志与打点都记了', h.logs.length > 0 && h.records.length > 0);
  ok('打点不含凭据值', !JSON.stringify(h.records).includes('RT'));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('沿用旧凭据（传输失败）：不标终态、写退避', async () => {
  clearRefreshLocks();
  const old = { access_token: 'OLD', expires_at: expSoon(), refresh_token: 'RT' };
  const h = harness({
    accounts: [{ id: 'a2', provider: 'trae', credentialRef: 'c2' }],
    creds: { c2: old },
    handlers: { trae: async (s, acc) => s.readCredential(acc.credentialRef) }
  });
  const r = await h.renew.runIfDue('manual');
  ok('unchanged 计数 1', r.unchanged === 1, JSON.stringify(r));
  ok('记 lastFailAt', h.renew.state().accounts.a2.lastFailAt > 0);
  ok('outcome=unchanged', h.renew.state().accounts.a2.outcome === 'unchanged');
  // 退避期内第二轮要跳过
  const r2 = await h.renew.runIfDue('manual');
  ok('退避期内跳过', r2.skipped === 1 && r2.unchanged === 0, JSON.stringify(r2));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('渠道包装返回值（补设备字段）不会被误判成续期成功', async () => {
  clearRefreshLocks();
  // 模拟 TRAE：credential() 用 repairTraeCredential 补 machine_id 后返回新对象，
  // 但 token / 过期时间没变 —— 这是「沿用旧凭据」，不能算 ok。
  const old = { access_token: 'OLD', expires_at: expSoon(), refresh_token: 'RT' };
  const h = harness({
    accounts: [{ id: 'aw', provider: 'trae', credentialRef: 'cw' }],
    creds: { cw: old },
    handlers: {
      trae: async (s, acc) => ({ ...s.readCredential(acc.credentialRef), machine_id: 'derived' })
    }
  });
  const r = await h.renew.runIfDue('manual');
  ok('判为 unchanged 而非 ok', r.unchanged === 1 && r.ok === 0, JSON.stringify(r));
  ok('记失败退避待重试', h.renew.state().accounts.aw.outcome === 'unchanged');
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('token 换新但过期时间不变也算续期成功', async () => {
  clearRefreshLocks();
  const old = { access_token: 'OLD', expires_at: expSoon(), refresh_token: 'RT' };
  const h = harness({
    accounts: [{ id: 'av', provider: 'trae', credentialRef: 'cv' }],
    creds: { cv: old },
    handlers: {
      trae: async (s, acc) => ({ ...s.readCredential(acc.credentialRef), access_token: 'FRESH' })
    }
  });
  const r = await h.renew.runIfDue('manual');
  ok('token 变化即判 ok', r.ok === 1 && r.unchanged === 0, JSON.stringify(r));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('过期时间前移但 token 不变也算续期成功', async () => {
  clearRefreshLocks();
  const h = harness({
    accounts: [{ id: 'au', provider: 'trae', credentialRef: 'cu' }],
    creds: { cu: { access_token: 'SAME', expires_at: expSoon(), refresh_token: 'RT' } },
    handlers: {
      trae: async (s, acc) => ({ ...s.readCredential(acc.credentialRef), expires_at: expFar() })
    }
  });
  const r = await h.renew.runIfDue('manual');
  ok('过期时间推进即判 ok', r.ok === 1, JSON.stringify(r));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('AUTH 失败标需重登，UPSTREAM 失败只记 error', async () => {
  clearRefreshLocks();
  const h = harness({
    accounts: [
      { id: 'a3', provider: 'trae', credentialRef: 'c3' },
      { id: 'a4', provider: 'qoder', credentialRef: 'c4' }
    ],
    creds: {
      c3: { access_token: 'A', expires_at: expSoon(), refresh_token: 'RT' },
      c4: { access_token: 'B', expires_at: expSoon(), refresh_token: 'RT' }
    },
    handlers: {
      trae: async () => { throw new OfmError(Codes.AUTH, 'expired'); },
      qoder: async () => { throw new OfmError(Codes.UPSTREAM, '502'); }
    }
  });
  const r = await h.renew.runIfDue('manual');
  ok('authFailed 1', r.authFailed === 1, JSON.stringify(r));
  ok('errored 1', r.errored === 1, JSON.stringify(r));
  ok('结果汇总可读', r.result.includes('需重登 1') && r.result.includes('失败 1'));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('跳过规则：停用/需重登/免登录/无刷新端点/未知渠道/无过期/未到窗口', async () => {
  clearRefreshLocks();
  const h = harness({
    accounts: [
      { id: 'b1', provider: 'trae', credentialRef: 'd1', enabled: false },
      { id: 'b2', provider: 'trae', credentialRef: 'd2', needsLogin: true },
      { id: 'b3', provider: 'kilo' },
      { id: 'b4', provider: 'loomy', credentialRef: 'd4' },
      { id: 'b5', provider: 'ghost', credentialRef: 'd5' },
      { id: 'b6', provider: 'trae', credentialRef: 'd6' }, // 无过期时间
      { id: 'b7', provider: 'trae', credentialRef: 'd7' }  // 远期
    ],
    creds: {
      d1: { access_token: 'A', expires_at: expSoon() },
      d2: { access_token: 'A', expires_at: expSoon() },
      d4: { access_token: 'A', expires_at: expSoon() },
      d5: { access_token: 'A', expires_at: expSoon() },
      d6: { access_token: 'opaque' },
      d7: { access_token: 'A', expires_at: expFar() }
    },
    handlers: { trae: async () => ({ access_token: 'NEW', expires_at: expFar() }) }
  });
  const r = await h.renew.runIfDue('manual');
  ok('7 个账号全跳过', r.skipped === 7 && r.ok === 0, JSON.stringify(r));
  ok('跳过原因可区分', new Set(h.renew.state().channels.map((c) => c.outcome)).size === 1);
  ok('含「需重新登录」原因', h.renew.state().channels.some((c) => c.text.includes('需重新登录')));
  ok('含「无需续期」原因', h.renew.state().channels.some((c) => c.text.includes('无需续期')));
  ok('含「无过期时间」原因', h.renew.state().channels.some((c) => c.text.includes('无过期时间')));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('开关与手动触发', async () => {
  clearRefreshLocks();
  const h = harness({ accounts: [], creds: {}, delay: 123, tick: 456 });
  ok('默认开启', h.renew.state().enabled === true);
  await h.renew.setEnabled(false);
  ok('可关闭', h.renew.state().enabled === false);
  const r = await h.renew.runIfDue('manual');
  ok('关闭时不跑', r === null);
  await h.renew.setEnabled(true);
  ok('可再开启', h.renew.state().enabled === true);
  ok('开启会排定一轮', h.records.some((e) => e.outcome === 'started'));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('start/stop 定时器与 0 延迟', async () => {
  clearRefreshLocks();
  const h = harness({ accounts: [], creds: {}, delay: 0, tick: 456 });
  h.renew.start();
  ok('0 延迟不排一次性定时器', h.scheduled.length === 0);
  ok('周期巡检已排定', h.ticks.length === 1 && h.ticks[0].ms === 456);
  await new Promise((r) => setTimeout(r, 10));
  ok('0 延迟立刻跑了一轮', h.records.some((e) => e.trigger === 'startup'));
  h.renew.start();
  ok('重复 start 不重复排定', h.ticks.length === 1);
  h.renew.stop();
  ok('state 反映定时器配置', h.renew.state().tickMs === 456 && h.renew.state().aheadMs > 0);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('inflight 去重复用同一个 Promise', async () => {
  clearRefreshLocks();
  let calls = 0;
  const h = harness({
    accounts: [{ id: 'a9', provider: 'trae', credentialRef: 'c9' }],
    creds: { c9: { access_token: 'A', expires_at: expSoon() } },
    handlers: { trae: async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return { access_token: 'NEW', expires_at: expFar() }; } }
  });
  const [x, y] = await Promise.all([h.renew.runIfDue('manual'), h.renew.runIfDue('manual')]);
  ok('两次共用同一个结果', x === y && x.ok === 1);
  ok('底层只跑一轮', calls === 1, `calls=${calls}`);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

await test('状态文件脏数据不会让调度器崩', async () => {
  clearRefreshLocks();
  const h = harness({ accounts: [], creds: {}, stateDoc: { enabled: false, lastAt: 'bad', channels: 'x', accounts: 3 } });
  ok('从磁盘读回并归一', h.renew.state().enabled === false && h.renew.state().lastAt === 0);
  const r = await h.renew.runIfDue('manual');
  ok('关闭状态直接返回', r === null);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

/* ───────── 汇总 ───────── */
console.log(`\n${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.error('  ✗', f);
  process.exit(1);
}
