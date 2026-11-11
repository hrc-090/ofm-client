/**
 * 与上游对齐的能力验收：响应体嗅探、工具线缆、思考档位、延迟响应头、
 * 用量窗口保护、速度口径、省 Token、Kilo 渠道。
 * 纯本地，不联网。运行：node test/upstream-alignment.mjs
 */
import assert from 'node:assert/strict';

import { sniffBody, looksLikeSse } from '../src/http-client.js';
import { createToolWire } from '../src/tool-wire.js';
import { takeModelEffort, explicitEffort, effortLevel, budgetForEffort } from '../src/effort.js';
import { deferStreamResponse } from '../src/deferred-response.js';
import { sanitizeUsage, readCacheTokens } from '../src/usage-cache.js';
import { speedTokens } from '../src/usage-store.js';
import { compressOutbound, injectPrompts, saverConfig } from '../src/token-saver/index.js';
import { KiloChannel } from '../src/channels/kilo/index.js';
import { createRegistry } from '../src/registry.js';

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

// ── 响应体嗅探 ──────────────────────────────────────────────────────────────
await test('sniffBody', () => {
  ok('data: 开头 = sse', sniffBody('data: {"a":1}\n\n') === 'sse');
  ok('id: 开头也 = sse（旧版会误判）', sniffBody('id: 1\nevent: ping\n\n') === 'sse');
  ok('retry: 开头 = sse', sniffBody('retry: 3000\n\n') === 'sse');
  ok('注释帧 = sse', sniffBody(': keepalive\n\n') === 'sse');
  ok('JSON = json', sniffBody('{"choices":[]}') === 'json');
  ok('数组 = json', sniffBody('[1,2]') === 'json');
  ok('HTML 页面单独归类', sniffBody('<!DOCTYPE html><html><title>502</title>') === 'html');
  ok('空响应', sniffBody('   \n') === 'empty');
  ok('BOM + data 仍识别', sniffBody('\uFEFFdata: x') === 'sse');
  ok('looksLikeSse 走同一判据', looksLikeSse('id: 1\n') === true);
  ok('普通文本不是 SSE', looksLikeSse('hello') === false);
});

// ── 工具线缆 ────────────────────────────────────────────────────────────────
await test('tool-wire index 重排', () => {
  const w = createToolWire([{ name: 'search' }]);
  const a = w.admit({ index: 2, id: 'c1', name: 'search', argumentsDelta: '{"q"' });
  const b = w.admit({ index: 2, argumentsDelta: ':1}' });
  ok('首个调用 index 归 0', a.kind === 'open' && a.index === 0);
  ok('首帧带 name 与首批参数', a.name === 'search' && a.args === '{"q"');
  ok('后续增量复用同一 index', b.kind === 'args' && b.index === 0);
  ok('count 只算真实调用', w.count === 1);
});

await test('tool-wire decoy 抑制', () => {
  const w = createToolWire([{ name: 'search' }]);
  const r = w.admit({ index: 0, id: 'x', name: 'read', argumentsDelta: '{"path":"/etc/passwd"}' });
  ok('未声明的 read 被丢弃', r.kind === 'drop');
  const after = w.admit({ index: 0, argumentsDelta: ' more' });
  ok('被抑制后后续帧也丢', after.kind === 'drop');
  ok('不计入工具数', w.count === 0);
});

await test('tool-wire 声明过 read 就放行', () => {
  const w = createToolWire([{ name: 'read' }]);
  const r = w.admit({ index: 0, name: 'read', argumentsDelta: '{}' });
  ok('调用方自己的 read 不被当成 decoy', r.kind === 'open' && r.name === 'read');
});

await test('tool-wire name 未到先挂起参数', () => {
  const w = createToolWire([{ name: 'grep' }]);
  const first = w.admit({ index: 1, id: 'c9', argumentsDelta: '{"pat"' });
  ok('没有 name 时不下发', first.kind === 'drop');
  const second = w.admit({ index: 1, name: 'grep', argumentsDelta: ':"x"}' });
  ok('name 到达时把挂起参数拼回去', second.kind === 'open' && second.args === '{"pat":"x"}');
  ok('id 从挂起帧继承', second.id === 'c9');
});

await test('tool-wire 空帧不下发', () => {
  const w = createToolWire([{ name: 'grep' }]);
  w.admit({ index: 0, name: 'grep', argumentsDelta: '{}' });
  const empty = w.admit({ index: 0 });
  ok('无参数增量的帧被丢弃', empty.kind === 'drop');
});

await test('tool-wire 两个调用连续编号', () => {
  const w = createToolWire([{ name: 'a' }, { name: 'b' }]);
  const a = w.admit({ index: 7, name: 'a', argumentsDelta: '{}' });
  const b = w.admit({ index: 9, name: 'b', argumentsDelta: '{}' });
  ok('跨块序号仍从 0 连续', a.index === 0 && b.index === 1);
});

// ── 思考档位 ────────────────────────────────────────────────────────────────
await test('思考档位入口', () => {
  const b1 = { model: 'trae/X(high)' };
  ok('模型名尾部档位被取出', takeModelEffort(b1) === 'high');
  ok('模型名被剥干净', b1.model === 'trae/X');
  ok('档位写进 reasoning_effort', b1.reasoning_effort === 'high');

  const b2 = { model: 'trae/X', reasoning_effort: 'high' };
  takeModelEffort(b2);
  ok('显式档位优先于空后缀', b2.reasoning_effort === 'high');

  const b3 = { model: 'vendor/model (preview)' };
  ok('括号里不是档位就不剥', takeModelEffort(b3) === null && b3.model === 'vendor/model (preview)');

  ok('reasoning.effort 被识别', explicitEffort({ reasoning: { effort: 'low' } }) === 'low');
  ok('空串不算', explicitEffort({ reasoning_effort: '  ' }) === null);
  ok('别名归一', effortLevel('HIGH') === 'deep' && effortLevel('low') === 'light');
  ok('未知值返回 null', effortLevel('turbo') === null);
});

await test('预算阶梯', () => {
  ok('light → 2048', budgetForEffort('light', {}) === 2048);
  ok('balanced → 8192', budgetForEffort('balanced', {}) === 8192);
  ok('deep 无上限时不变', budgetForEffort('deep', {}) === null);
  ok('模型上限压住档位', budgetForEffort('balanced', { modelMaxOutput: 4096 }) === 4096);
  ok('客户端 max_tokens 更小时不放大', budgetForEffort('balanced', { requested: 1000 }) === 1000);
  ok('思考不可关闭翻倍', budgetForEffort('light', { alwaysThinking: true }) === 4096);
  ok('未知档位不套预算', budgetForEffort('turbo', {}) === null);
});

// ── 延迟响应头 ──────────────────────────────────────────────────────────────
function fakeRes() {
  const calls = [];
  const res = {
    destroyed: false,
    headersSent: false,
    calls,
    writeHead(...args) {
      calls.push(['head', ...args]);
      res.headersSent = true;
    },
    write(...args) {
      calls.push(['write', args[0]]);
      return true;
    },
    end() {
      calls.push(['end']);
    },
    flushHeaders() {},
    on() {},
    once() {}
  };
  return res;
}

await test('延迟响应头', () => {
  const res = fakeRes();
  const staged = deferStreamResponse(res, 0);
  staged.response.writeHead(200, { 'content-type': 'text/event-stream' });
  staged.response.write('data: a\n\n');
  ok('未提交时什么都没发', res.calls.length === 0 && res.headersSent === false);
  ok('committed 反映真实状态', staged.committed === false);
  staged.commit();
  ok('提交后先发头再刷缓冲', res.calls[0][0] === 'head' && res.calls[1][1] === 'data: a\n\n');
  ok('提交后 headersSent 为真', res.headersSent === true);
});

await test('延迟响应头：失败不提交', () => {
  const res = fakeRes();
  const staged = deferStreamResponse(res, 0);
  staged.response.writeHead(200, {});
  staged.response.write('data: partial\n\n');
  staged.dispose();
  ok('dispose 后仍无任何写出', res.calls.length === 0 && res.headersSent === false);
});

await test('延迟响应头：单块超过 64KB 自动提交', () => {
  const res = fakeRes();
  const staged = deferStreamResponse(res, 0);
  staged.response.writeHead(200, {});
  staged.response.write('x'.repeat(70 * 1024));
  ok('大块触发提交', staged.committed === true && res.headersSent === true);
});

// ── 用量窗口保护 / 速度口径 ─────────────────────────────────────────────────
await test('sanitizeUsage', () => {
  const u = { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 };
  ok('正常用量原样返回', sanitizeUsage(u, 128000) === u);
  const over = sanitizeUsage({ prompt_tokens: 200000, completion_tokens: 50, total_tokens: 200050 }, 128000);
  ok('超窗口时输入侧清零', over.prompt_tokens === 0 && over.total_tokens === 50);
  ok('输出侧保留', over.completion_tokens === 50);
  ok('无输出时返回 undefined', sanitizeUsage({ prompt_tokens: 200000, total_tokens: 200000 }, 128000) === undefined);
  ok('没给窗口就不处理', sanitizeUsage({ prompt_tokens: 200000 }, undefined).prompt_tokens === 200000);
});

await test('速度分子剔除未流式下发的思考', () => {
  ok('有思考帧时全额计入', speedTokens({ outTok: 422, reasonTok: 291, sawReasoning: true }) === 422);
  ok('无思考帧时减掉思考', speedTokens({ outTok: 422, reasonTok: 291, sawReasoning: false }) === 131);
  ok('没有思考字段时不变', speedTokens({ outTok: 100 }) === 100);
  ok('不会减成负数', speedTokens({ outTok: 10, reasonTok: 50 }) === 0);
});

// ── 省 Token ────────────────────────────────────────────────────────────────
const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  'index 1111111..2222222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,60 +1,60 @@',
  ...Array.from({ length: 60 }, (_, i) => `-const old${i} = ${i};`),
  ...Array.from({ length: 60 }, (_, i) => `+const next${i} = ${i};`)
].join('\n');

await test('RTK 只压工具输出', () => {
  const body = {
    messages: [
      { role: 'system', content: DIFF },
      { role: 'user', content: DIFF },
      { role: 'tool', content: DIFF },
      { role: 'assistant', content: DIFF }
    ]
  };
  const stats = compressOutbound(body, 'chat', { tokenSaver: { rtk: true } });
  ok('确有节省', stats.saved > 0, JSON.stringify(stats));
  ok('tool 结果被压短', body.messages[2].content.length < DIFF.length);
  ok('system 不动', body.messages[0].content === DIFF);
  ok('user 不动', body.messages[1].content === DIFF);
  ok('assistant 不动', body.messages[3].content === DIFF);
  ok('统计口径一致', stats.bytesBefore - stats.bytesAfter === stats.saved);
});

await test('RTK 关闭时不动', () => {
  const body = { messages: [{ role: 'tool', content: DIFF }] };
  const stats = compressOutbound(body, 'chat', { tokenSaver: { rtk: false } });
  ok('开关关闭无节省', stats.saved === 0);
  ok('内容原样', body.messages[0].content === DIFF);
});

await test('RTK Anthropic tool_result 与错误结果', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: DIFF },
          { type: 'tool_result', tool_use_id: 'b', is_error: true, content: DIFF }
        ]
      }
    ]
  };
  compressOutbound(body, 'messages', { tokenSaver: { rtk: true } });
  ok('tool_result 被压短', body.messages[0].content[0].content.length < DIFF.length);
  ok('错误结果不压', body.messages[0].content[1].content === DIFF);
});

await test('提示词瘦身注入', () => {
  const internal = { messages: [{ role: 'user', content: 'hi' }] };
  const r = injectPrompts(internal, { tokenSaver: { caveman: 'lite' } });
  ok('没有 system 时插一条', internal.messages[0].role === 'system');
  ok('注入记录带档位', r.injected[0].id === 'caveman' && r.injected[0].level === 'lite');
  ok('用户消息未被改写', internal.messages[1].content === 'hi');

  const withSys = { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }] };
  injectPrompts(withSys, { tokenSaver: { caveman: 'off', ponytail: 'full' } });
  ok('已有 system 时追加而不是新建', withSys.messages.length === 2);
  ok('原文保留在开头', withSys.messages[0].content.startsWith('S\n\n'));
});

await test('省 Token 默认值', () => {
  ok('RTK 默认开', saverConfig({}).rtk === true);
  ok('提示词默认关', saverConfig({}).caveman === 'off' && saverConfig({}).ponytail === 'off');
  ok('未知档位回落 off', saverConfig({ tokenSaver: { caveman: 'wat' } }).caveman === 'off');
});

// ── Kilo 渠道 ───────────────────────────────────────────────────────────────
await test('Kilo 只广播免费模型', async () => {
  const ch = new KiloChannel({
    listingImpl: async () => ({
      data: [
        { id: 'free/one', name: 'Free One', context_length: 64000, isFree: true },
        { id: 'paid/two', name: 'Paid Two', isFree: false },
        { id: 'free/three', isFree: true, architecture: { input_modalities: ['text', 'image'] } }
      ]
    })
  });
  const list = await ch.listModels();
  ok('过滤掉付费 id', list.length === 2 && !list.some((m) => m.id === 'paid/two'));
  ok('免费标记保留', list.every((m) => m.free === true));
  ok('上下文窗口解析', list[0].contextWindow === 64000);
  ok('多模态识别', list[1].multimodal === true);
});

await test('Kilo 清单失败回退自动路由', async () => {
  const ch = new KiloChannel({ listingImpl: async () => { throw new Error('boom'); } });
  const list = await ch.listModels();
  ok('回退一条自动路由', list.length === 1 && list[0].id === 'kilo-auto/free');
  ok('保留失败原因', /boom/.test(ch.lastModelWarning));
});

await test('Kilo 注册为免账号渠道', () => {
  const reg = createRegistry();
  const ch = reg.get('kilo');
  ok('registry 里有 kilo', Boolean(ch));
  ok('不需要账号', ch.requiresAccount === false);
  ok('列表里可见', reg.list().some((c) => c.id === 'kilo' && c.requiresAccount === false));
});

console.log(`\n${results.length ? `✗ ${results.length} 项失败` : `✓ 全部通过（${passed} 项）`}`);
if (results.length) {
  for (const r of results) console.error('  - ' + r);
  process.exit(1);
}
