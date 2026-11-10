/**
 * 固定 API Key + 第三方 /v1/models 验收（不联网、不依赖真实账号）。
 *
 * 覆盖本次修的两个问题：
 *  - 清数据 / 重装后 Key 变化，导致第三方客户端里配的旧 Key 401 → 拿不到模型；
 *  - 登录成功后没有自动失效缓存 / 预热，模型列表不会自动出现。
 *
 * 运行：node test/api-key-model.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store, DEFAULT_API_KEY, defaultApiKey } from '../src/store.js';
import { createApp } from '../src/server.js';

delete process.env.OFM_API_KEY;

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-key-test-'));
const log = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const results = [];
async function test(name, fn) {
  try { await fn(); } catch (e) {
    results.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

// ── 1. Store 层：固定默认值与持久化 ──
const dirA = mkDir();
try {
  await test('默认 Key 是固定常量，不再随机', () => {
    ok('常量值', DEFAULT_API_KEY === 'ofm-local-key');
    ok('defaultApiKey() 一致', defaultApiKey() === DEFAULT_API_KEY);
    const s = new Store(dirA);
    ok('首次启动就是固定值', s.settings.forward.key === DEFAULT_API_KEY);
    ok('已落盘', JSON.parse(fs.readFileSync(path.join(dirA, 'settings.json'), 'utf8')).forward.key === DEFAULT_API_KEY);
  });

  await test('重新构造 Store（模拟重启 / 重装）Key 不变', () => {
    const s2 = new Store(dirA);
    ok('仍是同一个值', s2.settings.forward.key === DEFAULT_API_KEY);
    ok('没有退化成长随机值', !/^ofm-[A-Za-z0-9_-]{20,}$/.test(s2.settings.forward.key));
  });

  await test('setApiKey 落盘并持久化', () => {
    const s = new Store(dirA);
    const k = s.setApiKey('my-fixed-key-2026');
    ok('返回新值', k === 'my-fixed-key-2026');
    ok('写进 settings.json', new Store(dirA).settings.forward.key === k);
  });

  await test('非法 Key 被拒绝且不改盘上值', () => {
    const s = new Store(dirA);
    for (const bad of ['', '  ', 'abc', 'has space', 'a/b', 'x'.repeat(129)]) {
      assert.throws(() => s.setApiKey(bad));
    }
    ok('盘上值未被破坏', new Store(dirA).settings.forward.key === 'my-fixed-key-2026');
  });
} finally {
  fs.rmSync(dirA, { recursive: true, force: true });
}

// ── 2. HTTP 层：固定 Key 鉴权 / 第三方 /v1/models / 运行时同步 ──
const dirB = mkDir();
// 空 registry：默认注册表里的 mock 渠道免账号也会贡献模型，列表就不会为空。
// 这里刻意注入空表，才能验证「空列表给 hint」这条。
const emptyRegistry = {
  list: () => [],
  get: (id) => ({ id, loginMode: 'none', supported: false, requiresAccount: true })
};
const { server, uiToken } = createApp({ dataDir: dirB, log, registry: emptyRegistry });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const ui = { 'x-ofm-ui-token': uiToken, 'content-type': 'application/json' };

const get = (p, headers = {}) => fetch(base + p, { headers });
const post = (p, body, headers = ui) =>
  fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });

try {
  await test('第三方用固定 Key 能取 /v1/models', async () => {
    const r = await get('/v1/models', { authorization: `Bearer ${DEFAULT_API_KEY}` });
    const j = await r.json();
    ok('HTTP 200', r.status === 200, `status=${r.status}`);
    ok('object=list', j.object === 'list');
    ok('data 是数组', Array.isArray(j.data));
    ok('空列表给了可读原因', typeof j.hint === 'string' && j.hint.length > 0);
  });

  await test('其它常见鉴权头也能取模型', async () => {
    const a = await get('/v1/models', { 'x-api-key': DEFAULT_API_KEY });
    const b = await get('/v1/models', { 'x-goog-api-key': DEFAULT_API_KEY });
    const c = await get(`/v1/models?key=${DEFAULT_API_KEY}`);
    ok('x-api-key', a.status === 200);
    ok('x-goog-api-key', b.status === 200);
    ok('?key=', c.status === 200);
  });

  await test('错误 Key 返回 401', async () => {
    const r = await get('/v1/models', { authorization: 'Bearer wrong-key' });
    ok('401', r.status === 401);
  });

  await test('CORS 放行任意自定义头（网页版第三方）', async () => {
    const r = await fetch(base + '/v1/models', { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-headers': 'x-stainless-lang, authorization' } });
    ok('预检 204', r.status === 204);
    ok('allow-origin', r.headers.get('access-control-allow-origin') === '*');
    ok('allow-headers=*', r.headers.get('access-control-allow-headers') === '*');
  });

  await test('设置固定 Key 后立即生效', async () => {
    const r = await post('/api/settings/key', { key: 'client-key-abc' });
    const j = await r.json();
    ok('ok=true', j.ok === true);
    ok('返回新 Key', j.key === 'client-key-abc');
    ok('旧固定值失效', (await get('/v1/models', { authorization: `Bearer ${DEFAULT_API_KEY}` })).status === 401);
    ok('新值可用', (await get('/v1/models', { authorization: 'Bearer client-key-abc' })).status === 200);
    ok('已落盘', new Store(dirB).settings.forward.key === 'client-key-abc');
  });

  await test('留空保存 = 恢复固定默认值', async () => {
    const j = await (await post('/api/settings/key', { key: '' })).json();
    ok('恢复默认', j.key === DEFAULT_API_KEY);
    ok('默认值重新可用', (await get('/v1/models', { authorization: `Bearer ${DEFAULT_API_KEY}` })).status === 200);
  });

  await test('非法 Key 走业务失败而不是 500', async () => {
    const r = await post('/api/settings/key', { key: 'a b' });
    const j = await r.json();
    ok('HTTP 200', r.status === 200);
    ok('ok=false', j.ok === false);
    ok('有原因', String(j.error).includes('6-128'));
  });

  await test('改 Key 后同步 runtime.json（App 界面显示跟上）', async () => {
    const rp = path.join(dirB, 'runtime.json');
    fs.writeFileSync(rp, JSON.stringify({ port: 18900, key: 'stale', uiToken: 'x' }));
    await post('/api/settings/key', { key: 'runtime-synced-key' });
    const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    ok('runtime.json 的 key 已更新', r.key === 'runtime-synced-key');
    ok('其它字段保留', r.port === 18900 && r.uiToken === 'x');
    // 复原，避免影响后续用例
    await post('/api/settings/key', { key: '' });
    fs.rmSync(rp, { force: true });
  });

  await test('/api/models 空列表也带 hint（App 用）', async () => {
    const j = await (await get('/api/models', ui)).json();
    ok('data 是数组', Array.isArray(j.data));
    ok('有 hint', typeof j.hint === 'string' && j.hint.includes('/v1/models'));
  });
} finally {
  server.close();
  fs.rmSync(dirB, { recursive: true, force: true });
}

// ── 3. 登录完成后自动预热模型目录 ──
const dirC = mkDir();
let listModelsCalls = 0;
const mockChannel = {
  id: 'trae', name: 'trae', displayName: 'MOCK', loginMode: 'callback',
  supported: true, requiresAccount: true, note: '',
  login: {
    start: async () => ({ loginUrl: 'https://example.test/auth' }),
    poll: async () => ({ done: false }),
    complete: async () => ({
      success: true, nickname: '测试', expiresAt: Date.now() + 3600000,
      credential: { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600000 }
    })
  },
  listModels: async () => { listModelsCalls += 1; return [{ id: 'mock-model', displayName: 'Mock' }]; },
  credential: async () => ({ access_token: 'at' }),
  chat: async () => { throw new Error('not used'); }
};
const mockRegistry = {
  get: (id) => (id === 'trae' ? mockChannel : { id, loginMode: 'none', supported: false }),
  list: () => [{ id: 'trae', displayName: 'MOCK', loginMode: 'callback', supported: true, requiresAccount: true, note: '' }]
};
const appC = createApp({ dataDir: dirC, log, registry: mockRegistry });
await new Promise((r) => appC.server.listen(0, '127.0.0.1', r));
const baseC = `http://127.0.0.1:${appC.server.address().port}`;
const uiC = { 'x-ofm-ui-token': appC.uiToken, 'content-type': 'application/json' };

try {
  await test('登录成功后自动预热，模型列表随即出现', async () => {
    const started = await (await fetch(baseC + '/api/accounts', {
      method: 'POST', headers: uiC, body: JSON.stringify({ provider: 'trae' })
    })).json();
    ok('拿到 accountId', Boolean(started.accountId));

    const done = await (await fetch(baseC + '/api/login/complete', {
      method: 'POST', headers: uiC,
      body: JSON.stringify({ url: 'http://127.0.0.1:18080/authorize?refreshToken=x', accountId: started.accountId })
    })).json();
    ok('登录完成', done.ok === true, JSON.stringify(done));

    await sleep(150); // 预热是 Promise.resolve().then(...)，等一个微任务周期
    ok('自动调用了 listModels', listModelsCalls > 0, `calls=${listModelsCalls}`);

    const models = await (await fetch(baseC + '/v1/models', {
      headers: { authorization: `Bearer ${DEFAULT_API_KEY}` }
    })).json();
    // /v1/models 的 id 保持原始 provider/model，渠道名只放 display_name
    ok('/v1/models 有模型了', models.data.some((m) => m.real_id === 'trae/mock-model'), JSON.stringify(models));
    ok('真实 id 带 provider 前缀', models.data[0]?.real_id?.startsWith('trae/'));
    ok('id 未被装饰', models.data[0]?.id === 'trae/mock-model');
    ok('display_name 带渠道名', models.data[0]?.display_name?.includes('[MOCK]'));
    ok('有 owned_by 供第三方识别', models.data[0]?.owned_by === 'trae');
  });
} finally {
  appC.server.close();
  fs.rmSync(dirC, { recursive: true, force: true });
}

console.log(`\n${passed} 项通过，${results.length} 项失败`);
if (results.length) {
  results.forEach((r) => console.error(`  - ${r}`));
  process.exit(1);
}
