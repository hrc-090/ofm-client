/**
 * 账号 / 凭据体检验收（纯本地 mock，不联网、不碰真实账号）。
 *
 * 验证「网络自检全通过，但模型目录为空 / 余额查询失败」时，
 * 报告能把第二个变量（有没有可用账号、凭据齐不齐）一次说清，
 * 且全程不泄漏任何凭据值。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeAccounts } from '../src/account-diagnose.js';
import { DEFAULT_TARGETS } from '../src/net-diagnose.js';
import { createApp } from '../src/server.js';

let passed = 0;
const failures = [];
function ok(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}
async function test(name, fn) {
  try { await fn(); } catch (e) { failures.push(`${name}: ${e.message}`); }
}

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const SECRET = 'SUPER_SECRET_TOKEN_VALUE_9f3a';

/** 最小 store mock：settings.accounts + readCredential(ref) */
function mockStore(accounts, creds = {}) {
  return {
    settings: { accounts },
    readCredential: (ref) => creds[ref] ?? null
  };
}

const traeCred = (over = {}) => ({
  access_token: SECRET,
  refresh_token: 'refresh-secret',
  expires_at: NOW + 14 * 24 * 3600000,
  uid: '1554032590596819',
  machine_id: 'a'.repeat(32),
  device_id: 'b'.repeat(32),
  nickname: '用户0577',
  phone: '137******62',
  ...over
});

function acc(over = {}) {
  return {
    id: 'trae-ab01',
    provider: 'trae',
    enabled: true,
    credentialRef: 'r1',
    ...over
  };
}

// ── A. 自检目标覆盖 ──
await test('自检目标覆盖三个 TRAE 域名', async () => {
  const hosts = DEFAULT_TARGETS.map((t) => t.host);
  ok('共 4 个目标', hosts.length === 4);
  ok('含对照 www.baidu.com', hosts.includes('www.baidu.com'));
  ok('含 api.trae.cn（签到/余额）', hosts.includes('api.trae.cn'));
  ok('含 trae-api-cn.mchost.guru（模型目录）', hosts.includes('trae-api-cn.mchost.guru'));
  ok('含 api.trae.com.cn（登录/换 token）', hosts.includes('api.trae.com.cn'));
  ok('三个 TRAE 域名互不相同', new Set(hosts.filter((h) => h.includes('trae'))).size === 3);
});

// ── B. 纯函数体检 ──
await test('没有账号 → count 0 且提示先登录', async () => {
  const r = describeAccounts({ store: mockStore([]), nowMs: NOW });
  ok('count 0', r.count === 0);
  ok('usable 0', r.usable === 0);
  ok('accounts 空', r.accounts.length === 0);
  ok('hint 指向登录', r.hint.includes('没有已登录账号') && r.hint.includes('连接渠道'));
});

await test('pending / needsLogin / disabled 状态', async () => {
  const r1 = describeAccounts({ store: mockStore([acc({ pending: true })], { r1: traeCred() }), nowMs: NOW });
  ok('pending 被识别', r1.accounts[0].state === 'pending');
  ok('pending 不算可用', r1.usable === 0);
  ok('hint 提到 pending', r1.hint.includes('pending'));

  const r2 = describeAccounts({ store: mockStore([acc({ needsLogin: true })], { r1: traeCred() }), nowMs: NOW });
  ok('needs-login 被识别', r2.accounts[0].state === 'needs-login');
  ok('hint 提示重新连接', r2.hint.includes('重新'));

  const r3 = describeAccounts({ store: mockStore([acc({ enabled: false })], { r1: traeCred() }), nowMs: NOW });
  ok('disabled 被识别', r3.accounts[0].state === 'disabled');
});

await test('凭据文件缺失 / 字段不全', async () => {
  const r1 = describeAccounts({ store: mockStore([acc()], {}), nowMs: NOW });
  ok('no-credential 被识别', r1.accounts[0].state === 'no-credential');
  ok('hasCredential false', r1.accounts[0].hasCredential === false);
  ok('hint 提到凭据文件', r1.hint.includes('凭据文件'));

  const r2 = describeAccounts({ store: mockStore([acc()], { r1: traeCred() }), nowMs: NOW });
  ok('完整凭据 → ok', r2.accounts[0].state === 'ok');
  ok('missing 为空', r2.accounts[0].missing.length === 0);
  ok('usable 1', r2.usable === 1);
  ok('hint 提到 HTTP 状态', r2.hint.includes('HTTP') || r2.hint.includes('业务码'));

  const r3 = describeAccounts({ store: mockStore([acc()], { r1: traeCred({ uid: '' }) }), nowMs: NOW });
  ok('缺 uid → incomplete', r3.accounts[0].state === 'incomplete');
  ok('missing 含 uid', r3.accounts[0].missing.includes('uid'));
  ok('hint 提到 uid', r3.hint.includes('uid'));

  const r4 = describeAccounts({
    store: mockStore([acc()], { r1: traeCred({ machine_id: undefined, device_id: '' }) }),
    nowMs: NOW
  });
  ok('missing 含 machine_id', r4.accounts[0].missing.includes('machine_id'));
  ok('missing 含 device_id', r4.accounts[0].missing.includes('device_id'));
  ok('hint 提到 machine_id', r4.hint.includes('machine_id'));
});

await test('token 过期但可自动续期', async () => {
  const r = describeAccounts({
    store: mockStore([acc()], { r1: traeCred({ expires_at: NOW - 3600000 }) }),
    nowMs: NOW
  });
  ok('expired true', r.accounts[0].expired === true);
  ok('state expired', r.accounts[0].state === 'expired');
  ok('expiresInHours 为负', r.accounts[0].expiresInHours < 0);
  ok('仍计入 usable（会自动续期）', r.usable === 1);
  ok('hint 提到自动续期', r.hint.includes('自动续期'));
});

await test('非 TRAE 渠道不误报缺 device 字段', async () => {
  const a = acc({ id: 'qoder-x1', provider: 'qoder', credentialRef: 'r2' });
  const r = describeAccounts({
    store: mockStore([a], { r2: { access_token: SECRET, expires_at: NOW + 3600000 } }),
    nowMs: NOW
  });
  ok('state ok', r.accounts[0].state === 'ok');
  ok('missing 为空', r.accounts[0].missing.length === 0);
});

await test('通用 token 键：token / zcode_jwt 也认', async () => {
  for (const key of ['token', 'zcode_jwt', 'security_oauth_token']) {
    const a = acc({ id: 'x-' + key, provider: 'loomy', credentialRef: 'r3' });
    const r = describeAccounts({ store: mockStore([a], { r3: { [key]: SECRET } }), nowMs: NOW });
    ok(`${key} 被认作 token`, r.accounts[0].state === 'ok');
  }
  const a = acc({ id: 'x-none', provider: 'loomy', credentialRef: 'r4' });
  const r = describeAccounts({ store: mockStore([a], { r4: { foo: 'bar' } }), nowMs: NOW });
  ok('没有任何 token 键 → incomplete', r.accounts[0].state === 'incomplete');
  ok('missing 含 access_token', r.accounts[0].missing.includes('access_token'));
});

await test('混合账号正确统计 usable', async () => {
  const accounts = [
    acc({ id: 'trae-1', credentialRef: 'r1' }),
    acc({ id: 'trae-2', credentialRef: 'r2', pending: true }),
    acc({ id: 'trae-3', credentialRef: 'r3', needsLogin: true }),
    acc({ id: 'trae-4', credentialRef: 'r4', enabled: false })
  ];
  const creds = { r1: traeCred(), r2: traeCred(), r3: traeCred(), r4: traeCred() };
  const r = describeAccounts({ store: mockStore(accounts, creds), nowMs: NOW });
  ok('count 4', r.count === 4);
  ok('usable 1', r.usable === 1);
  ok('四种 state 齐全', new Set(r.accounts.map((x) => x.state)).size === 4);
});

await test('绝不泄漏任何凭据值', async () => {
  const r = describeAccounts({ store: mockStore([acc()], { r1: traeCred() }), nowMs: NOW });
  const s = JSON.stringify(r);
  ok('不含 access_token 值', !s.includes(SECRET));
  ok('不含 refresh_token 值', !s.includes('refresh-secret'));
  ok('不含 uid 值', !s.includes('1554032590596819'));
  ok('不含昵称', !s.includes('用户0577'));
  ok('不含手机号', !s.includes('137******62'));
  ok('fields 只列字段名', r.accounts[0].fields.includes('access_token'));
  ok('fields 不含值', !r.accounts[0].fields.includes(SECRET));
});

// ── C. 端到端：/api/network/diagnose 附带账号体检 ──
const log = { log() {}, warn() {}, error() {}, info() {} };
const fakeDiagnose = async () => ({
  ok: true,
  at: Date.now(),
  targets: [],
  summary: 'mock 全通过'
});

async function withApp(fn, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-acct-diag-'));
  const instance = createApp({ dataDir: dir, log, networkDiagnose: fakeDiagnose });
  if (seed) seed(instance.store);
  await new Promise((r) => instance.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  try {
    return await fn(base, instance.uiToken, instance.store);
  } finally {
    await new Promise((r) => instance.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await test('端点：自检响应带 accounts 段', async () => {
  await withApp(async (base, token) => {
    const r = await fetch(`${base}/api/network/diagnose`, { headers: { 'x-ofm-ui-token': token } });
    ok('200', r.status === 200);
    const j = await r.json();
    ok('summary 保留', j.summary === 'mock 全通过');
    ok('accounts 存在', j.accounts && typeof j.accounts === 'object');
    ok('count 0', j.accounts.count === 0);
    ok('hint 提示先登录', j.accounts.hint.includes('没有已登录账号'));
  });
});

await test('端点：写入 TRAE 账号后体检为可用且不泄漏', async () => {
  await withApp(
    async (base, token) => {
      const r = await fetch(`${base}/api/network/diagnose`, { headers: { 'x-ofm-ui-token': token } });
      const text = await r.text();
      const j = JSON.parse(text);
      ok('count 1', j.accounts.count === 1);
      ok('usable 1', j.accounts.usable === 1);
      ok('state ok', j.accounts.accounts[0].state === 'ok');
      ok('provider trae', j.accounts.accounts[0].provider === 'trae');
      ok('响应不含 token 值', !text.includes(SECRET));
      ok('响应不含 refresh 值', !text.includes('refresh-secret'));
    },
    (store) => {
      store.upsertAccount(acc());
      store.writeCredential('r1', traeCred());
    }
  );
});

await test('端点：没有 uiToken 仍 401', async () => {
  await withApp(async (base) => {
    const r = await fetch(`${base}/api/network/diagnose`);
    ok('401', r.status === 401);
  });
});

await test('端点：accountDiagnose 可注入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-acct-inject-'));
  const instance = createApp({
    dataDir: dir,
    log,
    networkDiagnose: fakeDiagnose,
    accountDiagnose: () => ({ count: 7, usable: 7, accounts: [], hint: 'injected' })
  });
  await new Promise((r) => instance.server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${instance.server.address().port}`;
    const r = await fetch(`${base}/api/network/diagnose`, { headers: { 'x-ofm-ui-token': instance.uiToken } });
    const j = await r.json();
    ok('注入值生效', j.accounts.count === 7 && j.accounts.hint === 'injected');
  } finally {
    await new Promise((r) => instance.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('accountDiagnose 抛错也不会让端点 500', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-acct-throw-'));
  const instance = createApp({
    dataDir: dir,
    log,
    networkDiagnose: fakeDiagnose,
    accountDiagnose: () => { throw new Error('boom'); }
  });
  await new Promise((r) => instance.server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${instance.server.address().port}`;
    const r = await fetch(`${base}/api/network/diagnose`, { headers: { 'x-ofm-ui-token': instance.uiToken } });
    ok('仍 200', r.status === 200);
    const j = await r.json();
    ok('hint 含失败说明', j.accounts.hint.includes('账号体检失败'));
    ok('不泄漏堆栈', !JSON.stringify(j).includes('createApp'));
  } finally {
    await new Promise((r) => instance.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(`失败 ${failures.length} 项：`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`通过 ${passed} 项，失败 0 项`);
