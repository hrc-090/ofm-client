/**
 * 凭据自愈 + 登录 session 解包验收（纯本地 mock，不联网、不碰真实账号）。
 *
 * 真机自检报告：网络四层全通过，但「1 个账号，0 个可用 / trae [incomplete]
 * 缺 machine_id、device_id，token 剩余 336h」。根因是 login-manager 把
 * channel.login.start() 的外层包装对象 { loginUrl, session, instructions }
 * 整体当 session 传给 complete，而 completeLogin 读的 machineId/deviceId
 * 在内层 → 落库时是 undefined，被 JSON.stringify 省略。
 *
 * 本测试验证两件事：
 *   A. 修复后新登录的凭据带 machine_id / device_id（且内层字段仍能读到）；
 *   B. 存量缺字段凭据在启动时自动补齐并写回，用户无需重新登录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { TraeChannel } from '../src/channels/trae/index.js';
import { repairTraeCredential, repairStoredCredentials } from '../src/credential-repair.js';
import { describeAccounts } from '../src/account-diagnose.js';

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
async function test(name, fn) {
  try { await fn(); } catch (e) { failures.push(`${name}: ${e.message}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-repair-'));
const log = { log() {}, warn() {}, error() {} };
const NOW = Date.now();

const baseCred = (over = {}) => ({
  access_token: 'AT_SECRET',
  refresh_token: 'RT_SECRET',
  expires_at: NOW + 336 * 3600000,
  uid: '1554032590596819',
  nickname: '用户0577',
  ...over
});

// ── A. 纯函数：补齐规则 ──
await test('补齐缺失的两个设备标识，且是 32 位 hex', async () => {
  const { credential, added, needsRelogin } = repairTraeCredential(baseCred());
  ok('added 两个字段', added.join(',') === 'machine_id,device_id', added.join(','));
  ok('needsRelogin false', needsRelogin === false);
  ok('machine_id 是 32 hex', /^[0-9a-f]{32}$/.test(credential.machine_id), credential.machine_id);
  ok('device_id 是 32 hex', /^[0-9a-f]{32}$/.test(credential.device_id), credential.device_id);
  ok('两者不相等', credential.machine_id !== credential.device_id);
});

await test('派生是确定性的（每次启动不自造新设备，避免风控）', async () => {
  const a = repairTraeCredential(baseCred()).credential;
  const b = repairTraeCredential(baseCred()).credential;
  ok('machine_id 稳定', a.machine_id === b.machine_id);
  ok('device_id 稳定', a.device_id === b.device_id);
  const c = repairTraeCredential(baseCred({ uid: 'another-uid' })).credential;
  ok('不同 uid 不同 machine_id', c.machine_id !== a.machine_id);
});

await test('绝不覆盖已有值，只补缺的', async () => {
  const cred = baseCred({ machine_id: 'KEEP_ME_MACHINE' });
  const { credential, added } = repairTraeCredential(cred);
  ok('只补 device_id', added.join(',') === 'device_id', added.join(','));
  ok('machine_id 原样', credential.machine_id === 'KEEP_ME_MACHINE');
  ok('空串也视为缺失', repairTraeCredential(baseCred({ device_id: '  ' })).added.includes('device_id'));
});

await test('不改动 token / uid / 其它字段', async () => {
  const cred = baseCred();
  const { credential } = repairTraeCredential(cred);
  ok('access_token 未变', credential.access_token === cred.access_token);
  ok('refresh_token 未变', credential.refresh_token === cred.refresh_token);
  ok('uid 未变', credential.uid === cred.uid);
  ok('expires_at 未变', credential.expires_at === cred.expires_at);
  ok('原对象未被修改', cred.machine_id === undefined);
});

await test('uid 缺失不编造，标记需重新登录', async () => {
  const r = repairTraeCredential(baseCred({ uid: '' }));
  ok('needsRelogin true', r.needsRelogin === true);
  ok('不补字段', r.added.length === 0 && r.credential.machine_id === undefined);
  ok('非对象输入不炸', repairTraeCredential(null).added.length === 0);
});

// ── B. store 层：只修 trae、幂等、写回、脱敏 ──
await test('repairStoredCredentials 只处理 trae 且幂等', async () => {
  const dataDir = tmp();
  const store = new Store(dataDir);
  store.update((s) => {
    s.accounts = [
      { id: 'trae-1', provider: 'trae', enabled: true, credentialRef: 'R1' },
      { id: 'qoder-1', provider: 'qoder', enabled: true, credentialRef: 'R2' }
    ];
  });
  store.writeCredential('R1', baseCred());
  store.writeCredential('R2', { access_token: 'Q', uid: 'u' });

  const r1 = repairStoredCredentials(store, { log });
  ok('扫描 1 个 trae', r1.scanned === 1);
  ok('修复 1 个', r1.repaired === 1);
  ok('added 含两字段', r1.added.join(',') === 'machine_id,device_id');
  ok('账号 id 记录（不含凭据值）', r1.accounts.includes('trae-1'));
  ok('qoder 凭据未被改动', store.readCredential('R2').machine_id === undefined);

  const saved = store.readCredential('R1');
  ok('已写回文件', /^[0-9a-f]{32}$/.test(saved.machine_id));
  ok('token 保持', saved.access_token === 'AT_SECRET');

  const r2 = repairStoredCredentials(store, { log });
  ok('第二次不再写盘（幂等）', r2.repaired === 0 && r2.added.length === 0);
  ok('值不变', store.readCredential('R1').machine_id === saved.machine_id);

  const summary = JSON.stringify(r1);
  ok('摘要不含 token 值', !summary.includes('AT_SECRET') && !summary.includes('RT_SECRET'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── C. 登录链路：session 摊平后 machineId 能落库 ──
/**
 * mock 渠道刻意复现真实 TRAE 的 start() 返回形状：
 *   { loginUrl, session: { machineId, deviceId, ... }, instructions }
 * complete 把从 session 读到的 machineId/deviceId 写进 credential —— 模拟 completeLogin。
 */
function wrappedChannel() {
  return {
    id: 'trae', name: 'trae', displayName: 'MOCK TRAE', loginMode: 'callback',
    supported: true, requiresAccount: true, note: '',
    login: {
      start: async () => ({
        loginUrl: 'https://example.test/authorization?machine_id=MID&device_id=DID',
        session: { machineId: 'MID_FROM_INNER', deviceId: 'DID_FROM_INNER', completed: false },
        instructions: '把回调链接粘贴回 App'
      }),
      poll: async (session) =>
        session.result ? { done: true, ...session.result } : { done: false, status: 'waiting-callback' },
      complete: async (session, url) => {
        const result = {
          success: true,
          nickname: '测试账号',
          expiresAt: NOW + 3600000,
          credential: {
            access_token: 'AT', refresh_token: 'RT', expires_at: NOW + 3600000,
            uid: 'U1',
            machine_id: session.machineId,
            device_id: session.deviceId
          }
        };
        session.result = result;
        return result;
      }
    },
    models: async () => [],
    credential: async () => ({}),
    listModels: async () => [],
    chat: async () => { throw new Error('not used'); }
  };
}

await test('登录落库带 machine_id / device_id（回归根因）', async () => {
  const dataDir = tmp();
  const channel = wrappedChannel();
  const registry = {
    get: (id) => (id === 'trae' ? channel : { id, loginMode: 'none', supported: false }),
    list: () => [{ id: 'trae', displayName: 'MOCK TRAE', loginMode: 'callback', supported: true, note: '' }]
  };
  const { server, uiToken } = createApp({ dataDir, log, registry });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-ofm-ui-token': uiToken, 'content-type': 'application/json' };
  try {
    const start = await fetch(`${base}/api/accounts`, {
      method: 'POST', headers, body: JSON.stringify({ provider: 'trae' })
    }).then((r) => r.json());
    ok('start 返回 loginUrl', String(start.loginUrl).includes('/authorization'));
    ok('start 返回 instructions', String(start.instructions).includes('粘贴'));

    const done = await fetch(`${base}/api/login/complete`, {
      method: 'POST', headers,
      body: JSON.stringify({ url: 'http://127.0.0.1:18080/authorize?refreshToken=x' })
    }).then((r) => r.json());
    ok('粘贴回调完成', done.ok === true, JSON.stringify(done));

    const credFiles = fs.readdirSync(path.join(dataDir, 'credentials'));
    const cred = JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials', credFiles[0]), 'utf8'));
    ok('machine_id 落库为内层值', cred.machine_id === 'MID_FROM_INNER', String(cred.machine_id));
    ok('device_id 落库为内层值', cred.device_id === 'DID_FROM_INNER', String(cred.device_id));
    ok('不再是 undefined 被省略', Object.prototype.hasOwnProperty.call(cred, 'machine_id'));
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

await test('摊平后 poll 仍读得到内层字段，且 result 挂在同一个 session 上', async () => {
  const dataDir = tmp();
  const channel = wrappedChannel();
  const registry = {
    get: (id) => (id === 'trae' ? channel : { id, loginMode: 'none', supported: false }),
    list: () => [{ id: 'trae', displayName: 'MOCK TRAE', loginMode: 'callback', supported: true, note: '' }]
  };
  const { server, uiToken, logins } = createApp({ dataDir, log, registry });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const headers = { 'x-ofm-ui-token': uiToken, 'content-type': 'application/json' };
  try {
    const start = await fetch(`http://127.0.0.1:${server.address().port}/api/accounts`, {
      method: 'POST', headers, body: JSON.stringify({ provider: 'trae' })
    }).then((r) => r.json());
    const rec = logins.sessions.get(start.accountId);
    ok('session 含内层 machineId', rec.session.machineId === 'MID_FROM_INNER');
    ok('session 含外层 loginUrl', String(rec.session.loginUrl).includes('/authorization'));
    ok('session 含 instructions', String(rec.session.instructions).includes('粘贴'));
    ok('嵌套的 session 键已移除', rec.session.session === undefined);

    await fetch(`http://127.0.0.1:${server.address().port}/api/login/complete`, {
      method: 'POST', headers,
      body: JSON.stringify({ url: 'http://127.0.0.1:18080/authorize?refreshToken=x', accountId: start.accountId })
    });
    const polled = await logins.poll(start.accountId).catch(() => null);
    // 完成后会话已删除，poll 会回落到「已完成账号」
    ok('完成后不报错', polled === null || polled.done === true);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── D. 端到端：存量账号启动即自愈，体检从 incomplete 变 ok ──
await test('createApp 启动自愈：incomplete → ok，无需重新登录', async () => {
  const dataDir = tmp();
  const pre = new Store(dataDir);
  pre.update((s) => {
    s.accounts = [{ id: 'trae-old', provider: 'trae', enabled: true, credentialRef: 'OLD' }];
  });
  pre.writeCredential('OLD', baseCred()); // 故意缺 machine_id / device_id
  ok('修复前是 incomplete', describeAccounts({ store: pre, nowMs: NOW }).accounts[0].state === 'incomplete');

  const { server } = createApp({ dataDir, log });
  ok('启动即写回', /^[0-9a-f]{32}$/.test(new Store(dataDir).readCredential('OLD').machine_id));
  const after = describeAccounts({ store: new Store(dataDir), nowMs: NOW });
  ok('体检变 ok', after.accounts[0].state === 'ok', after.accounts[0].state);
  ok('usable 变 1', after.usable === 1);
  ok('missing 清空', after.accounts[0].missing.length === 0);
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── E. TraeChannel.credential 惰性兜底 ──
await test('TRAE 取凭据时惰性补齐，请求头不会是 undefined', async () => {
  const ch = new TraeChannel();
  const store = {
    readCredential: () => baseCred(),
    writeCredential() {},
    update() {}
  };
  const cred = await ch.credential(store, { id: 'a1', credentialRef: 'R', provider: 'trae' });
  ok('machine_id 有值', /^[0-9a-f]{32}$/.test(cred.machine_id));
  ok('device_id 有值', /^[0-9a-f]{32}$/.test(cred.device_id));
  ok('token 未动', cred.access_token === 'AT_SECRET');
});

console.log(`\n${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
