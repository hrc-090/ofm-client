/**
 * 登录回调兜底验收（不联网、不依赖真实账号）。
 *
 * 背景：浏览器授权成功后要跳 http://127.0.0.1:18080/authorize，但那个端口
 * 可能没人监听（电脑浏览器登录 / App 被回收 / 端口占用），此时用户会看到
 * ERR_CONNECTION_REFUSED。本测试验证「把回调链接粘回 App」这条兜底链路：
 *   /api/login/complete → resolveCallbackTarget → logins.completeCallback → 账号落库
 * 用注入的 mock 渠道替换真实渠道，全程不发外网请求。
 *
 * 运行：node test/login-callback.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import {
  normalizeCallbackUrl,
  resolveCallbackTarget,
  getCallbackServerState,
  setBrowserTarget
} from '../src/browser-callback.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-login-test-'));
const log = { log() {}, warn() {}, error() {} };
const seen = [];

// mock 渠道：complete 只解析 URL query，模拟真实渠道「不校验 host」的行为
const channel = {
  id: 'trae',
  name: 'trae',
  displayName: 'MOCK TRAE',
  loginMode: 'callback',
  supported: true,
  requiresAccount: true,
  note: '',
  login: {
    start: async () => ({ loginUrl: 'https://example.test/authorization' }),
    poll: async (session) =>
      session.result ? { done: true, ...session.result } : { done: false, status: 'waiting-callback' },
    complete: async (session, url) => {
      seen.push(url);
      let u;
      try {
        u = new URL(url);
      } catch {
        return { success: false, error: '回调链接格式不正确' };
      }
      const rt = u.searchParams.get('refreshToken');
      if (!rt) return { success: false, error: '回调链接里没有 refreshToken' };
      const result = {
        success: true,
        nickname: '测试账号',
        expiresAt: Date.now() + 3600000,
        credential: { access_token: 'at', refresh_token: rt, expires_at: Date.now() + 3600000 }
      };
      session.result = result;
      return result;
    }
  },
  models: async () => [],
  credential: async () => ({}),
  chat: async () => { throw new Error('not used'); }
};

const registry = {
  get: (id) => (id === 'trae' ? channel : { id, loginMode: 'none', supported: false }),
  list: () => [{ id: 'trae', displayName: 'MOCK TRAE', loginMode: 'callback', supported: true, note: '' }]
};

const { server, logins, uiToken } = createApp({ dataDir, log, registry });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const ui = { 'x-ofm-ui-token': uiToken, 'content-type': 'application/json' };

const req = async (p, { method = 'GET', body, headers = ui } = {}) => {
  const r = await fetch(base + p, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = {};
  try { json = await r.json(); } catch { /* 忽略 */ }
  return { status: r.status, json };
};
const post = (p, body) => req(p, { method: 'POST', body });
const startLogin = async () => (await post('/api/accounts', { provider: 'trae' })).json.accountId;

const FULL = 'http://127.0.0.1:18080/authorize?isRedirect=true&refreshToken=abc%3D.xyz&userJwt=%7B%7D';

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

try {
  await test('URL 归一化：完整 URL 原样保留', () => {
    ok('完整 18080 URL', normalizeCallbackUrl(FULL) === FULL);
    ok('自定义 scheme 保留', normalizeCallbackUrl('ofm://login/cb?a=b') === 'ofm://login/cb?a=b');
    ok('空串返回空', normalizeCallbackUrl('  ') === '');
  });

  await test('URL 归一化：裸 query / 裸 key=value 自动补成绝对地址', () => {
    const a = normalizeCallbackUrl('?refreshToken=abc');
    const b = normalizeCallbackUrl('refreshToken=abc');
    ok('?query 可解析', new URL(a).searchParams.get('refreshToken') === 'abc');
    ok('裸 key=value 可解析', new URL(b).searchParams.get('refreshToken') === 'abc');
    ok('前缀是 authorize', a.includes('/authorize?') && b.includes('/authorize?'));
  });

  await test('/api/status 暴露回调端口状态', async () => {
    const r = await req('/api/status');
    ok('有 callback 字段', r.json.callback && typeof r.json.callback === 'object');
    ok('未启动 18080 时 listening=false', r.json.callback.listening === false);
    ok('状态对象含 port', r.json.callback.port === 18080);
    ok('模块级状态一致', getCallbackServerState().listening === false);
  });

  await test('无待完成会话时粘贴：明确提示而不是 500', async () => {
    const r = await post('/api/login/complete', { url: FULL });
    ok('HTTP 200', r.status === 200);
    ok('ok=false', r.json.ok === false);
    ok('提示重新发起登录', String(r.json.error).includes('重新点'));
    ok('不打印链接内容', !JSON.stringify(r.json).includes('refreshToken=abc'));
  });

  await test('管理接口仍需要 uiToken', async () => {
    const r = await post('/api/login/complete', { url: FULL });
    const noUi = await req('/api/login/complete', {
      method: 'POST', body: { url: FULL }, headers: { 'content-type': 'application/json' }
    });
    ok('带 uiToken 不是 401', r.status !== 401);
    ok('不带 uiToken 是 401', noUi.status === 401);
  });

  await test('粘贴完整 18080 链接 → 登录完成并落库', async () => {
    const id = await startLogin();
    const r = await post('/api/login/complete', { url: FULL });
    ok('ok=true', r.json.ok === true, JSON.stringify(r.json));
    ok('返回 accountId', r.json.accountId === id);
    ok('账号不再 pending', r.json.account?.pending === false);
    ok('needsLogin=false', r.json.account?.needsLogin === false);
    const list = (await req('/api/accounts')).json.data || [];
    ok('账号进入列表', list.some((a) => a.id === id && a.nickname === '测试账号'));
    ok('渠道收到完整 URL', seen.at(-1) === FULL);
  });

  await test('粘贴「电脑浏览器」host 的链接也能完成（host 不校验）', async () => {
    const id = await startLogin();
    const url = 'https://api.trae.com.cn/authorize?isRedirect=true&refreshToken=pc%3D.token';
    const r = await post('/api/login/complete', { url, accountId: id });
    ok('ok=true', r.json.ok === true, JSON.stringify(r.json));
    ok('凭据用的是新 refreshToken', r.json.account?.id === id);
  });

  await test('粘贴裸 ?query 也能完成', async () => {
    await startLogin();
    const r = await post('/api/login/complete', { url: '?refreshToken=bare%3D.query' });
    ok('ok=true', r.json.ok === true, JSON.stringify(r.json));
    ok('归一化后带 authorize', seen.at(-1).includes('/authorize?'));
  });

  await test('粘贴裸 refreshToken=… 也能完成', async () => {
    await startLogin();
    const r = await post('/api/login/complete', { url: 'refreshToken=bare%3D.kv' });
    ok('ok=true', r.json.ok === true, JSON.stringify(r.json));
  });

  await test('链接缺 refreshToken：业务失败不 500，占位账号被清理', async () => {
    const id = await startLogin();
    const r = await post('/api/login/complete', { url: 'http://127.0.0.1:18080/authorize?foo=bar' });
    ok('HTTP 200', r.status === 200);
    ok('ok=false', r.json.ok === false);
    ok('有明确错误', String(r.json.error).includes('refreshToken'));
    const list = (await req('/api/accounts')).json.data || [];
    ok('占位账号已删除', !list.some((a) => a.id === id));
  });

  await test('browser-target 优先级：多会话时落到指定账号', async () => {
    const id1 = await startLogin();
    const id2 = await startLogin();
    await post('/api/login/browser-target', { accountId: id2 });
    ok('解析到 target', resolveCallbackTarget(logins) === id2);
    const r = await post('/api/login/complete', { url: FULL });
    ok('完成的是 id2', r.json.accountId === id2, JSON.stringify(r.json));
    ok('id1 会话仍在', logins.sessions.has(id1));
    // 成功后 target 被清掉，下一次落到最近一个 callback 会话
    const r2 = await post('/api/login/complete', { url: FULL });
    ok('回落到剩余会话 id1', r2.json.accountId === id1, JSON.stringify(r2.json));
    setBrowserTarget(null);
  });

  await test('会话全部结束后解析返回 null', () => {
    ok('无会话', resolveCallbackTarget(logins) === null);
  });
} finally {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} 项通过，${results.length} 项失败`);
if (results.length) {
  results.forEach((r) => console.error(`  - ${r}`));
  process.exit(1);
}
