/**
 * TRAE「只回 metadata 就断流」验收：HTTP 200 / 0 正文的根因与重试。
 * 纯 mock，不联网、不需要真实账号。运行：node test/trae-empty-retry.mjs
 *
 * 真实报告（2026-11-09，Doubao-Seed-Code）：
 *   HTTP 200 / text/event-stream / 1 帧 / 有效帧 0
 *   样本：event:metadata data:{"model":"","session_id":"..."}
 *
 * 覆盖：
 *  1. max_tokens 收敛（默认 32000 / 模型声明上限 / 全局 64000 安全线）
 *  2. 模型目录解析出 model_detail_list[].max_tokens
 *  3. 首轮零正文 → 自动重试一次，且过程帧（finish）绝不提前下发
 *  4. 两轮都零正文 → 一个 delta 都不下发，交给 dispatch 抛 EMPTY_REPLY
 *  5. 目录没加载过时先补目录，避免发错通道
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { TraeChannel } from '../src/channels/trae/index.js';
import { resolveMaxTokens } from '../src/channels/trae/protocol.js';
import { parseCatalog } from '../src/channels/trae/models.js';

let passed = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const results = [];
async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    results.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

const CRED = {
  access_token: 'AT',
  uid: '1554032590596819',
  machine_id: 'a'.repeat(32),
  device_id: 'b'.repeat(32)
};
const ACCOUNT = { id: 'trae-test', provider: 'trae', generation: 0 };

const META_ONLY =
  'event:metadata\ndata:{"model":"","session_id":"7d5c617a-f95d-4fab-9c66-1bfd9eec4c22","prompt_completion_id":0}\n\n';
const META_AND_DONE = `${META_ONLY}event:done\ndata:{"finish_reason":"stop"}\n\n`;
const OUTPUT_OK =
  'event:output\ndata:{"response":"你好"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n';

function mockRes(text) {
  const raw = Readable.from([Buffer.from(text)]);
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    raw,
    text: async () => text,
    destroy: () => raw.destroy()
  };
}

/** 按顺序返回预置响应，并记录每次请求体 */
function makeChannel(responses, { catalog = null } = {}) {
  const bodies = [];
  let i = 0;
  const ch = new TraeChannel({
    // 给一个空目录：既避免联网，也验证「模型不在目录里」的降级路径
    fetchModelsImpl: async () => catalog || [],
    openImpl: async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return mockRes(r);
    }
  });
  return { ch, bodies, calls: () => i };
}

async function collect(ch, req, trace) {
  const out = [];
  for await (const d of ch.stream(
    { modelId: 'Doubao-Seed-Code', model: 'trae/Doubao-Seed-Code', messages: [{ role: 'user', content: 'hi' }], ...req },
    { account: ACCOUNT, credential: CRED, signal: null, trace }
  )) {
    out.push(d);
  }
  return out;
}

/* ───────── 1. 输出额度收敛 ───────── */

await test('max_tokens：默认 32000，按模型上限收敛，全局 64000 封顶', async () => {
  ok('未指定 → 32000', resolveMaxTokens({}) === 32000);
  ok('模型声明 16000 → 16000', resolveMaxTokens({ modelMaxOutputTokens: 16000 }) === 16000);
  ok('客户端要 64000、模型 32000 → 32000', resolveMaxTokens({ asked: 64000, modelMaxOutputTokens: 32000 }) === 32000);
  ok('客户端要 128000、无模型信息 → 64000', resolveMaxTokens({ asked: 128000 }) === 64000);
  ok('非法值 → 默认', resolveMaxTokens({ asked: -5 }) === 32000);
});

/* ───────── 2. 目录解析出模型的 max_tokens ───────── */

await test('目录：model_detail_list[].max_tokens 被解析（优先 __dev）', async () => {
  const catalog = parseCatalog({
    function_configs: [
      {
        function: 'solo_coder',
        config_info_list: [
          {
            config_name: 'Doubao-Seed-Code',
            usage: 'chat_completion',
            config_switch: true,
            is_invisible_to_user: false,
            display_config: { display_name: 'Doubao Seed Code' },
            model_detail_list: [
              { model_name: 'Doubao-Seed-Code__max', max_tokens: 128000 },
              { model_name: 'Doubao-Seed-Code__dev', max_tokens: 16000 }
            ]
          }
        ]
      }
    ]
  });
  ok('解析出一条模型', catalog.length === 1, `实际 ${catalog.length}`);
  ok('id 正确', catalog[0]?.id === 'Doubao-Seed-Code');
  ok('通道正确', catalog[0]?.channel === 'solo_coder');
  ok('取 __dev 的 16000', catalog[0]?.maxOutputTokens === 16000, `实际 ${catalog[0]?.maxOutputTokens}`);
});

/* ───────── 3. 零正文自动重试 ───────── */

await test('空流：首轮只有 metadata → 自动重试，正文正常产出', async () => {
  const trace = {};
  const { ch, bodies, calls } = makeChannel([META_ONLY, OUTPUT_OK]);
  const deltas = await collect(ch, { maxTokens: 64 }, trace);

  ok('发了 2 次请求', calls() === 2, `实际 ${calls()}`);
  ok('拿到正文', deltas.some((d) => d.type === 'text' && d.text === '你好'));
  ok('第一轮的 finish 没有提前下发', deltas[0]?.type === 'text', `首帧是 ${deltas[0]?.type}`);
  ok('正文之后才有 finish', deltas[deltas.length - 1]?.type === 'finish');
  ok('trace 记录尝试 2 次', trace.attempts === 2);
  ok('trace 记录零正文 1 次', trace.emptyAttempts === 1);
  ok('首轮沿用客户端额度 64', bodies[0]?.max_tokens === 64, `实际 ${bodies[0]?.max_tokens}`);
  ok('重试改为模型默认 32000', bodies[1]?.max_tokens === 32000, `实际 ${bodies[1]?.max_tokens}`);
  ok('重试用的是新会话（请求体重新构造）', bodies[0] !== bodies[1]);
});

await test('空流：metadata + done 也算零正文，仍会重试', async () => {
  const trace = {};
  const { ch, calls } = makeChannel([META_AND_DONE, OUTPUT_OK]);
  const deltas = await collect(ch, {}, trace);
  ok('发了 2 次请求', calls() === 2, `实际 ${calls()}`);
  ok('拿到正文', deltas.some((d) => d.type === 'text'));
  ok('只下发一次 finish', deltas.filter((d) => d.type === 'finish').length === 1);
});

await test('空流：两轮都零正文 → 不下发任何 delta（交给 dispatch 报错）', async () => {
  const trace = {};
  const { ch, calls } = makeChannel([META_ONLY]);
  const deltas = await collect(ch, {}, trace);
  ok('确实试了 2 次', calls() === 2, `实际 ${calls()}`);
  ok('一个 delta 都没有', deltas.length === 0, `实际 ${deltas.length}`);
  ok('trace 记录 2 次空轮', trace.emptyAttempts === 2, `实际 ${trace.emptyAttempts}`);
  ok('trace 保留上游样本', /metadata/.test(trace.sample || ''));
});

await test('空流：客户端额度超模型上限 → 首轮就按模型上限发', async () => {
  const catalog = [
    { id: 'Doubao-Seed-Code', name: 'Doubao Seed Code', channel: 'solo_coder', maxOutputTokens: 16000 }
  ];
  const { ch, bodies } = makeChannel([OUTPUT_OK], { catalog });
  await collect(ch, { maxTokens: 64000 });
  ok('max_tokens 收敛到 16000', bodies[0]?.max_tokens === 16000, `实际 ${bodies[0]?.max_tokens}`);
});

/* ───────── 5. 目录未加载 → 先补目录再选通道 ───────── */

await test('通道：modelIndex 为空时先补目录，避免发错通道', async () => {
  const catalog = [
    { id: 'Doubao-Seed-Code', name: 'Doubao Seed Code', channel: 'solo_coder', maxOutputTokens: 32000 }
  ];
  const { ch, bodies } = makeChannel([OUTPUT_OK], { catalog });
  const trace = {};
  await collect(ch, {}, trace);
  ok('请求体用了目录里的通道', bodies[0]?.function === 'solo_coder', `实际 ${bodies[0]?.function}`);
  ok('trace 标记模型在目录中', trace.modelInCatalog === true);
  ok('trace 记录通道', trace.upstreamFunction === 'solo_coder');
  ok('请求摘要可读', trace.request?.model === 'Doubao-Seed-Code' && trace.request?.max_tokens === 32000);
});

/* ───────── 汇总 ───────── */

console.log(`\n${passed} 项断言通过`);
if (results.length) {
  console.error(`\n${results.length} 个用例失败：`);
  for (const r of results) console.error(` - ${r}`);
  process.exit(1);
}
