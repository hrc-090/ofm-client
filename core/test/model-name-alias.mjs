/**
 * 第三方插件自定义模型名口径兼容验收。
 *
 * 背景：内置网页搜索插件把 model 写成 `deepseek-v4-flash`，
 * 目录里真实 id 是 `DeepSeek-V4-Flash`、显示名是 `DeepSeek V4 Flash`。
 * 以前只做精确匹配，大小写 / `- _ 空格` 一变就报
 * 「模型 id 必须形如 provider/model」。这里验证无损归一化后唯一命中能路由，
 * 多命中仍然宁可报清晰 400，不猜渠道。
 *
 * 运行：node test/model-name-alias.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
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

const seen = [];
function fakeChannel({ id, name, models }) {
  return {
    id,
    name,
    supported: true,
    requiresAccount: false,
    loginMode: 'none',
    listModels: async () => models,
    async *stream(req) {
      seen.push({ provider: req.provider, modelId: req.modelId, model: req.model });
      yield { type: 'text', text: 'ok' };
      yield { type: 'finish', reason: 'stop' };
    }
  };
}
const all = [
  fakeChannel({
    id: 'trae', name: 'TRAE', models: [
      { id: 'DeepSeek-V4-Flash', displayName: 'DeepSeek V4 Flash' },
      { id: 'DeepSeek-V4-Flash-Official', displayName: 'DeepSeek V4 Flash Official' },
      { id: 'DeepSeek-Flash', displayName: 'DeepSeek Flash' }
    ]
  }),
  fakeChannel({
    id: 'qoder', name: 'Qoder', models: [
      { id: 'dfmodel', displayName: 'DeepSeek-Flash' }
    ]
  })
];
const registry = { list: () => all, get: (id) => all.find((c) => c.id === id) };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-model-alias-'));
const { server } = createApp({ dataDir: dir, log, registry });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const v1Get = (p) => fetch(base + p, { headers: { authorization: `Bearer ${DEFAULT_API_KEY}` } });
const v1Post = (p, body) => fetch(base + p, {
  method: 'POST',
  headers: { authorization: `Bearer ${DEFAULT_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

try {
  await test('目录里能拿到真实 id', async () => {
    const j = await (await v1Get('/v1/models')).json();
    ok('有 DeepSeek-V4-Flash', j.data.some((m) => m.id === 'trae/DeepSeek-V4-Flash'), JSON.stringify(j.data.map((m) => m.id)));
  });

  await test('Anthropic 入口：deepseek-v4-flash 唯一命中并路由', async () => {
    seen.length = 0;
    const r = await v1Post('/v1/messages', {
      model: 'deepseek-v4-flash', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }]
    });
    const text = await r.text();
    ok('HTTP 200', r.status === 200, text.slice(0, 240));
    ok('路由到 trae', seen.at(-1)?.provider === 'trae', JSON.stringify(seen));
    ok('模型 id 还原成上游大小写', seen.at(-1)?.modelId === 'DeepSeek-V4-Flash', JSON.stringify(seen));
  });

  await test('OpenAI 入口：下划线 + 全大写也认', async () => {
    seen.length = 0;
    const r = await v1Post('/v1/chat/completions', {
      model: 'DEEPSEEK_V4_FLASH', messages: [{ role: 'user', content: 'hi' }]
    });
    ok('HTTP 200', r.status === 200, (await r.text()).slice(0, 240));
    ok('路由到 trae', seen.at(-1)?.provider === 'trae', JSON.stringify(seen));
  });

  await test('显示名（空格分隔）仍能命中', async () => {
    seen.length = 0;
    const r = await v1Post('/v1/messages', {
      model: 'DeepSeek V4 Flash', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }]
    });
    ok('HTTP 200', r.status === 200, (await r.text()).slice(0, 240));
    ok('路由到 trae', seen.at(-1)?.provider === 'trae', JSON.stringify(seen));
  });

  await test('归一化后多命中仍不猜，给清晰 400', async () => {
    seen.length = 0;
    const r = await v1Post('/v1/messages', {
      model: 'deepseek-flash', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }]
    });
    const j = await r.json();
    ok('HTTP 400', r.status === 400, JSON.stringify(j));
    ok('提示 provider/model', JSON.stringify(j).includes('provider/model'), JSON.stringify(j));
    ok('没有乱路由', seen.length === 0, JSON.stringify(seen));
  });

  await test('目录里查不到时不猜渠道', async () => {
    seen.length = 0;
    const r = await v1Post('/v1/messages', {
      model: 'not-a-real-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }]
    });
    ok('HTTP 400', r.status === 400, (await r.text()).slice(0, 240));
    ok('没有乱路由', seen.length === 0, JSON.stringify(seen));
  });
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/model-name-alias.mjs 通过 ${passed} 项断言`);
