/**
 * Raccoon 登录改造验收（不联网、不依赖真实账号）。
 *
 * 背景：官方扫码落地页 `/login/mp` 现在是 404，旧实现把它当登录地址丢给浏览器，
 * 用户只能看到 404（链接里的 code 还是本地随机生成的，官网根本不认）。
 * 现在改为：
 *   1. 本机提供 `http://127.0.0.1:<port>/raccoon/login` 入口（对齐上游），
 *      页面再跳到官网仍可用的 `/login`；
 *   2. App 在 WebView 里登录后，把站点 Cookie 回传 `/api/accounts/:id/cookie`；
 *   3. 渠道用模型目录接口验活，只把真能调的 token 写成凭据。
 *
 * 运行：node test/raccoon-login.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { RaccoonChannel, parseCookieHeader, tokenCandidates, RACCOON_LOGIN_TARGET } from '../src/channels/raccoon/index.js';
import { raccoonLoginPage } from '../src/channels/raccoon/login-page.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-raccoon-test-'));
const log = { log() {}, warn() {}, error() {} };

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

/* ── 纯函数：Cookie 解析 ── */
await test('Cookie 串解析：普通 / 带空格 / 引号', () => {
  const c = parseCookieHeader('a=1; b=2;  c = 3 ');
  ok('a=1', c.a === '1');
  ok('b=2', c.b === '2');
  ok('c=3（去空格）', c.c === '3');

  const q = parseCookieHeader('xhx_token="quoted-value"');
  ok('引号被剥掉', q.xhx_token === 'quoted-value');

  ok('空串安全', Object.keys(parseCookieHeader('')).length === 0);
  ok('非字符串安全', Object.keys(parseCookieHeader(null)).length === 0);
  ok('没有等号的行被忽略', Object.keys(parseCookieHeader('garbage; a=1')).length === 1);
});

await test('Cookie 串解析：value 是 URL 编码时解一层', () => {
  const c = parseCookieHeader('xhx_token=eyJhbGciOi%3D%3D.abc');
  ok('解出原始 token', c.xhx_token === 'eyJhbGciOi==.abc');
  // 解不开的百分号不能把整条解析炸掉
  const bad = parseCookieHeader('xhx_token=%E0%A4%A; ok=1');
  ok('坏编码不抛错', bad.ok === '1');
});

await test('候选 token：按优先级取，且去重', () => {
  const list = tokenCandidates('raccoon_token=r1; xhx_token=x1; access_token=a1');
  ok('xhx_token 优先', list[0].token === 'x1' && list[0].source === 'xhx_token');
  ok('raccoon_token 次之', list[1].token === 'r1');
  ok('access_token 兜底', list[2].token === 'a1');

  const dup = tokenCandidates('xhx_token=same; raccoon_token=same');
  ok('同一个值只留一个', dup.length === 1);
});

await test('候选 token：允许直接粘贴裸 token', () => {
  const bare = tokenCandidates('eyJhbGciOiJIUzI1NiJ9.payload.sig');
  ok('裸 token 被接收', bare.length === 1 && bare[0].source === 'pasted');
  ok('裸 token 不误判', tokenCandidates('note=hello').length === 0);
  ok('空串无候选', tokenCandidates('   ').length === 0);
});

/* ── 登录页 ── */
await test('本机登录页：跳到可用的 /login，不再出现 /login/mp', () => {
  const html = raccoonLoginPage({ target: RACCOON_LOGIN_TARGET });
  ok('声明 utf-8 与移动视口', html.includes('charset="utf-8"') && html.includes('width=device-width'));
  ok('包含落地地址', html.includes('https://xiaohuanxiong.com/login'));
  ok('不再引用 404 的扫码页', !html.includes('/login/mp'));
  ok('有手动兜底按钮', html.includes('手动打开登录页'));
  ok('提示不要用扫码', html.includes('扫码'));
});

await test('渠道元信息：改成本机 cookie 模式', () => {
  const ch = new RaccoonChannel();
  ok('loginMode=cookie', ch.loginMode === 'cookie');
  ok('仍有登录能力', ch.supported === true && ch.requiresAccount === true);
});

await test('start() 返回相对本机入口，由服务端补成完整地址', async () => {
  const ch = new RaccoonChannel();
  const r = await ch.login.start();
  ok('loginUrl 是相对路径', r.loginUrl === '/raccoon/login');
  ok('不再是官网 404 地址', !r.loginUrl.includes('login/mp'));
  ok('有操作说明', typeof r.instructions === 'string' && r.instructions.length > 0);
});

/* ── 端到端：本机路由 + cookie 落库（mock 渠道，不发外网） ── */
const mock = {
  id: 'raccoon',
  name: 'raccoon',
  displayName: 'MOCK RACCOON',
  loginMode: 'cookie',
  supported: true,
  requiresAccount: true,
  note: '',
  login: {
    start: async () => ({ loginUrl: '/raccoon/login', session: {} }),
    poll: async () => ({ done: false, status: 'waiting' }),
    cookie: async (session, raw) => {
      if (raw.includes('good')) {
        return {
          success: true,
          nickname: '浣熊测试号',
          credential: { access_token: 'good-token', expires_at: Date.now() + 3600000 }
        };
      }
      return { success: false, error: '登录态无效或已过期' };
    }
  },
  models: async () => [],
  credential: async () => ({}),
  chat: async () => { throw new Error('not used'); }
};

const registry = {
  get: (id) => (id === 'raccoon' ? mock : { id, loginMode: 'none', supported: false }),
  list: () => [{ id: 'raccoon', displayName: 'MOCK RACCOON', loginMode: 'cookie', supported: true, note: '' }]
};

const { server, logins, store, uiToken } = createApp({ dataDir, log, registry });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const ui = { 'x-ofm-ui-token': uiToken, 'content-type': 'application/json' };
const req = async (p, { method = 'GET', body, headers = ui } = {}) => {
  const r = await fetch(base + p, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* 非 JSON（登录页 HTML） */ }
  return { status: r.status, json, text, type: r.headers.get('content-type') || '' };
};

try {
  await test('GET /raccoon/login：不带 uiToken 也能拿到 HTML', async () => {
    const r = await req('/raccoon/login', { headers: {} });
    ok('HTTP 200', r.status === 200, String(r.status));
    ok('content-type 是 html', r.type.includes('text/html'));
    ok('返回登录页', r.text.includes('连接 Raccoon'));
    ok('指向官网 /login', r.text.includes('https://xiaohuanxiong.com/login'));
    ok('没有 404 路径', !r.text.includes('login/mp'));
  });

  await test('GET /login/raccoon 别名同样可用', async () => {
    const r = await req('/login/raccoon', { headers: {} });
    ok('HTTP 200', r.status === 200);
    ok('是同一页', r.text.includes('连接 Raccoon'));
  });

  await test('POST /api/accounts：相对入口被补成本机绝对地址', async () => {
    const r = await req('/api/accounts', { method: 'POST', body: { provider: 'raccoon' } });
    ok('HTTP 200', r.status === 200);
    ok('mode=cookie', r.json.mode === 'cookie', JSON.stringify(r.json));
    ok('loginUrl 是绝对地址', String(r.json.loginUrl).startsWith('http://127.0.0.1:'), r.json.loginUrl);
    ok('loginUrl 指向本机 /raccoon/login', String(r.json.loginUrl).endsWith('/raccoon/login'));
    ok('账号先入池且 pending', store.findAccount(r.json.accountId)?.pending === true);
    globalThis.__acc = r.json.accountId;
  });

  await test('POST /api/accounts/:id/cookie：有效凭据落库', async () => {
    const id = globalThis.__acc;
    const r = await req(`/api/accounts/${id}/cookie`, {
      method: 'POST',
      body: { cookie: 'xhx_token=good; raccoon_token=other' }
    });
    ok('HTTP 200', r.status === 200, r.text);
    ok('success=true', r.json.success === true);
    ok('昵称写回', r.json.account?.nickname === '浣熊测试号');
    ok('不再是 pending', store.findAccount(id)?.pending === false);
    ok('会话已清理', !logins.sessions.has(id));
    ok('凭据已落盘', store.readCredential(store.findAccount(id).credentialRef)?.access_token === 'good-token');
  });

  await test('POST /api/accounts/:id/cookie：无效凭据删占位账号，不留幽灵', async () => {
    const start = await req('/api/accounts', { method: 'POST', body: { provider: 'raccoon' } });
    const id = start.json.accountId;
    const r = await req(`/api/accounts/${id}/cookie`, { method: 'POST', body: { cookie: 'xhx_token=bad' } });
    ok('不是 500', r.status < 500, String(r.status));
    ok('提示失效', String(r.json?.error?.message || r.json?.error || '').includes('失效') || r.status === 401);
    ok('占位账号被删掉', store.findAccount(id) === undefined);
    ok('会话被删掉', !logins.sessions.has(id));
  });

  await test('会话不存在时导入：明确报错', async () => {
    const r = await req('/api/accounts/raccoon-nope/cookie', { method: 'POST', body: { cookie: 'xhx_token=x' } });
    ok('不是 500', r.status < 500);
    ok('提示会话不存在', String(JSON.stringify(r.json)).includes('登录会话'));
  });

  await test('管理接口仍然要 uiToken，登录页是唯一例外', async () => {
    const noUi = await req('/api/accounts', { method: 'POST', body: { provider: 'raccoon' }, headers: { 'content-type': 'application/json' } });
    ok('不带 token 是 401', noUi.status === 401);
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
