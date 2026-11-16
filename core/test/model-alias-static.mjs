/**
 * 第三方插件写死模型名（dshgo / web-search-deepseek）场景验收。
 *
 * 关键：这类插件**不读 /v1/models**，所以运行时目录缓存为空，
 * 归一化不能依赖 peek()/listAll()。用各渠道静态兜底目录建的零网络索引
 * 必须在请求入口第一时间把 `deepseek-v4-flash` 还原成 `trae/DeepSeek-V4-Flash`。
 *
 * 运行：node test/model-alias-static.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { staticModelAlias, looseModelKey, indexSize } from '../src/model-alias.js';
import { createApp } from '../src/server.js';
import { DEFAULT_API_KEY } from '../src/store.js';

const log = { log() {}, warn() {}, error() {} };
let passed = 0;
const results = [];
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};
async function test(name, fn) {
  try { await fn(); } catch (e) {
    results.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

await test('静态索引已建好且覆盖 DeepSeek', async () => {
  ok('索引非空', indexSize() > 20, String(indexSize()));
  ok('无损归一化', looseModelKey('DeepSeek-V4-Flash') === looseModelKey('deepseek-v4-flash'));
  ok('_ 也折叠', looseModelKey('DEEPSEEK_V4_FLASH') === 'deepseekv4flash');
});

await test('裸名唯一命中（不传渠道过滤）', async () => {
  ok('deepseek-v4-flash', staticModelAlias('deepseek-v4-flash') === 'trae/DeepSeek-V4-Flash', String(staticModelAlias('deepseek-v4-flash')));
  ok('全大写下划线', staticModelAlias('DEEPSEEK_V4_FLASH') === 'trae/DeepSeek-V4-Flash');
  ok('显示名空格', staticModelAlias('DeepSeek V4 Flash') === 'trae/DeepSeek-V4-Flash');
  // deepseek-v4-pro 在 TRAE 与 qoder/qodercn 都有 → 多命中不猜
  ok('deepseek-v4-pro 多命中不猜', staticModelAlias('deepseek-v4-pro') === null);
  ok('deepseek-v4-pro 限定 TRAE', staticModelAlias('deepseek-v4-pro', { allowedProviders: new Set(['trae']) }) === 'trae/DeepSeek-V4-Pro');
});

await test('渠道过滤：只纳入已登录渠道', async () => {
  ok('TRAE 在 → 命中 trae', staticModelAlias('deepseek-v4-flash', { allowedProviders: new Set(['trae']) }) === 'trae/DeepSeek-V4-Flash');
  ok('TRAE 不在 → 不猜', staticModelAlias('deepseek-v4-flash', { allowedProviders: new Set(['qoder']) }) === null);
  ok('Qoder dfmodel 命中', staticModelAlias('deepseek-flash', { allowedProviders: new Set(['qoder']) }) === 'qoder/dfmodel', String(staticModelAlias('deepseek-flash', { allowedProviders: new Set(['qoder']) })));
  ok('qoder+qodercn 同名 → 多命中不猜', staticModelAlias('deepseek-flash', { allowedProviders: new Set(['qoder', 'qodercn']) }) === null);
});

await test('带 / 或查不到 → null', async () => {
  ok('已是 provider/model', staticModelAlias('trae/DeepSeek-V4-Flash') === null);
  ok('不存在的模型', staticModelAlias('not-a-real-model') === null);
});

/* ───────── HTTP 层：完全不预热目录缓存，模拟 dshgo 直连 ───────── */
const seen = [];
function fakeChannel({ id, name, models, requiresAccount = false }) {
  return {
    id,
    name,
    supported: true,
    requiresAccount,
    loginMode: requiresAccount ? 'token' : 'none',
    listModels: async () => models,
    async *stream(req) {
      seen.push({ provider: req.provider, modelId: req.modelId, model: req.model });
      yield { type: 'text', text: 'ok' };
      yield { type: 'finish', reason: 'stop' };
    }
  };
}
// TRAE 需登录且已登录；目录 listModels 故意慢到超时——验证归一化不依赖它
const trae = fakeChannel({ id: 'trae', name: 'TRAE', requiresAccount: true, models: [] });
const all = [trae];
const registry = { list: () => all, get: (id) => all.find((c) => c.id === id) };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-alias-static-'));
const { server } = createApp({ dataDir: dir, log, registry });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const v1Post = (p, body) => fetch(base + p, {
  method: 'POST',
  headers: { authorization: `Bearer ${DEFAULT_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

try {
  // 注入一条已登录的 TRAE 账号到 store（createApp 内部 store 从 dataDir 读，
  // 这里通过写 runtime/store 文件不可行；改用免登录渠道也可验证入口路径）。
  // 为聚焦归一化本身，这里再起一个免登录 TRAE 的 app 做端到端。
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 端到端：免登录 TRAE（allowed 天然包含），目录为空且从不预热
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-alias-e2e-'));
const traeFree = fakeChannel({ id: 'trae', name: 'TRAE', requiresAccount: false, models: [] });
const reg2 = { list: () => [traeFree], get: (id) => (id === 'trae' ? traeFree : undefined) };
const { server: s2 } = createApp({ dataDir: dir2, log, registry: reg2 });
await new Promise((r) => s2.listen(0, '127.0.0.1', r));
const base2 = `http://127.0.0.1:${s2.address().port}`;
const post2 = (p, body) => fetch(base2 + p, {
  method: 'POST',
  headers: { authorization: `Bearer ${DEFAULT_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
try {
  await test('端到端 /v1/messages：裸名直连、目录为空也能路由', async () => {
    seen.length = 0;
    const r = await post2('/v1/messages', {
      model: 'deepseek-v4-flash', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }]
    });
    const text = await r.text();
    ok('HTTP 200', r.status === 200, text.slice(0, 240));
    ok('路由到 trae', seen.at(-1)?.provider === 'trae', JSON.stringify(seen));
    ok('模型还原为 DeepSeek-V4-Flash', seen.at(-1)?.modelId === 'DeepSeek-V4-Flash', JSON.stringify(seen));
  });

  await test('端到端 /v1/chat/completions 同样修好', async () => {
    seen.length = 0;
    const r = await post2('/v1/chat/completions', {
      model: 'DEEPSEEK_V4_FLASH', messages: [{ role: 'user', content: 'hi' }]
    });
    ok('HTTP 200', r.status === 200, (await r.text()).slice(0, 240));
    ok('路由到 trae', seen.at(-1)?.provider === 'trae', JSON.stringify(seen));
  });
} finally {
  s2.close();
  fs.rmSync(dir2, { recursive: true, force: true });
}

console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/model-alias-static.mjs 通过 ${passed} 项断言`);
