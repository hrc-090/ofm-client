/**
 * 缓存命中 token 全链路验收（M37）。
 *
 * 「缓存命中一直是零」的根因有三层，这里逐层钉死：
 *  1) 上游命名有六种，归一化层（OpenAI / TRAE / Anthropic）旧版把字段削没了；
 *  2) 上游根本不上报缓存字段时，看板不该显示「命中 0」，而应显示「—」；
 *  3) 回传第三方客户端的 usage 里 cached_tokens 旧版写死 0。
 *
 * 纯本地，不联网、不需要账号。运行：node test/cache-tokens.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCacheTokens, attachCacheTokens, publicUsage, cachedOrNull } from '../src/usage-cache.js';
import { normalizeUsage, deltasFromChunk, aggregateDeltas } from '../src/openai-compat.js';
import { mapUsage } from '../src/channels/trae/protocol.js';
import { consumeAnthropicStream } from '../src/anthropic-compat.js';
import { toResponsesObject, ResponsesStreamWriter } from '../src/convert/responses.js';
import { anthropicUsage, toAnthropicMessage, AnthropicStreamWriter } from '../src/convert/anthropic.js';
import { createUsageStore, dayKey } from '../src/usage-store.js';
import { createApp } from '../src/server.js';
import { DEFAULT_API_KEY } from '../src/store.js';

let passed = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const eq = (name, actual, expect) => ok(name, actual === expect, `got=${JSON.stringify(actual)} want=${JSON.stringify(expect)}`);

/* ───────── 1. 统一读取：六种命名 + 上报区分 ───────── */

// OpenAI Chat
{
  const u = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } };
  const r = readCacheTokens(u);
  eq('OpenAI Chat 命中数', r.hit, 40);
  eq('OpenAI Chat 已上报', r.reported, true);
}
// OpenAI Responses
{
  const u = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 33 } };
  eq('Responses 命中数', readCacheTokens(u).hit, 33);
}
// Anthropic 读命中
{
  const u = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 55 };
  const r = readCacheTokens(u);
  eq('Anthropic 命中数', r.hit, 55);
  eq('Anthropic 已上报', r.reported, true);
}
// DeepSeek / Moonshot
{
  const u = { prompt_tokens: 100, prompt_cache_hit_tokens: 66, prompt_cache_miss_tokens: 34 };
  eq('DeepSeek 命中数', readCacheTokens(u).hit, 66);
}
// 顶层 cached_tokens（归一化后 / 部分网关）
{
  eq('顶层 cached_tokens', readCacheTokens({ cached_tokens: 12 }).hit, 12);
}
// 只有写入缓存、没有命中：算上报，命中为 0
{
  const r = readCacheTokens({ input_tokens: 100, cache_creation_input_tokens: 30 });
  eq('仅写入缓存 → 命中 0', r.hit, 0);
  eq('仅写入缓存 → 仍算上报', r.reported, true);
}
{
  const r = readCacheTokens({ prompt_cache_miss_tokens: 50 });
  eq('仅冷缓存 → 命中 0', r.hit, 0);
  eq('仅冷缓存 → 仍算上报', r.reported, true);
}
// 显式上报 0 ≠ 没上报
{
  const r = readCacheTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } });
  eq('显式 0 → 命中 0', r.hit, 0);
  eq('显式 0 → 已上报', r.reported, true);
}
// 完全没有缓存字段
{
  const r = readCacheTokens({ prompt_tokens: 100, completion_tokens: 20 });
  eq('未上报 → 命中 0', r.hit, 0);
  eq('未上报 → reported=false', r.reported, false);
  ok('未上报 → reported 与显式 0 可区分', r.reported === false);
}
// 脏值容错
{
  eq('负数不算命中', readCacheTokens({ cached_tokens: -5 }).reported, false);
  eq('NaN 不算命中', readCacheTokens({ cached_tokens: 'abc' }).reported, false);
  eq('字符串数字可读', readCacheTokens({ cached_tokens: '42' }).hit, 42);
  eq('null/undefined 安全', readCacheTokens(null).reported, false);
  eq('空对象安全', readCacheTokens({}).reported, false);
}

/* ───────── 2. attach / publicUsage / cachedOrNull ───────── */

{
  const out = attachCacheTokens({ prompt_tokens: 100 }, { cache_read_input_tokens: 25 });
  eq('attach 挂 cached_tokens', out.cached_tokens, 25);
  const none = attachCacheTokens({ prompt_tokens: 100 }, { prompt_tokens: 100 });
  ok('未上报不写 cached_tokens 键', !('cached_tokens' in none));
}
{
  const pub = publicUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 40 });
  eq('publicUsage 折算 cached_tokens', pub.prompt_tokens_details.cached_tokens, 40);
  ok('publicUsage 剥掉内部 cached_tokens 顶层', !('cached_tokens' in pub));
  eq('publicUsage 保留 total_tokens', pub.total_tokens, 120);
  const pub2 = publicUsage({ prompt_tokens: 10, completion_tokens: 5 });
  ok('未上报时 publicUsage 不造 details', !('prompt_tokens_details' in pub2));
  const pub3 = publicUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { audio_tokens: 3 }, cached_tokens: 7 });
  eq('publicUsage 合并已有 details', pub3.prompt_tokens_details.audio_tokens, 3);
  eq('publicUsage details 用命中数覆盖', pub3.prompt_tokens_details.cached_tokens, 7);
  eq('cachedOrNull 有值', cachedOrNull({ cached_tokens: 9 }), 9);
  eq('cachedOrNull 无值', cachedOrNull({ prompt_tokens: 1 }), null);
}

/* ───────── 3. 三个归一化点都保留命中数 ───────── */

{
  const raw = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } };
  eq('normalizeUsage 保留命中', normalizeUsage(raw).cached_tokens, 40);
  const none = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20 });
  ok('normalizeUsage 未上报不造字段', !('cached_tokens' in none));
  eq('normalizeUsage Anthropic 命名', normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 30 }).cached_tokens, 30);
}
{
  // TRAE 自定义协议：旧版 mapUsage 只留 3 个总数，缓存字段全丢
  const raw = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 45 } };
  eq('mapUsage(TRAE) 保留命中', mapUsage(raw).cached_tokens, 45);
  eq('mapUsage(TRAE) Anthropic 命名', mapUsage({ input_tokens: 80, cache_read_input_tokens: 22 }).cached_tokens, 22);
  ok('mapUsage 未上报不造字段', !('cached_tokens' in mapUsage({ prompt_tokens: 5, completion_tokens: 5 })));
}
{
  // OpenAI 流式 chunk → delta → 聚合，命中数一路不丢
  const chunk = { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } };
  const deltas = [...deltasFromChunk(chunk)];
  const usageDelta = deltas.find((d) => d.type === 'usage');
  eq('流式 chunk usage 带命中', usageDelta.usage.cached_tokens, 40);
  const agg = aggregateDeltas([...deltas, { type: 'text', text: 'hi' }]);
  eq('aggregateDeltas 保留命中', agg.usage.cached_tokens, 40);
  // 非流式 completion 走 deltasFromCompletion（内部）→ normalizeUsage，
  // 与流式共用同一归一化，这里直接验它不会把命中削掉。
  const completionUsage = { prompt_tokens: 100, completion_tokens: 20, input_tokens_details: { cached_tokens: 18 } };
  eq('非流式 completion 归一化保留命中', normalizeUsage(completionUsage).cached_tokens, 18);
}
{
  // Anthropic 原生 SSE：cache_read_input_tokens 只在 message_start 出现
  const events = [
    { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 } } }) },
    { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }) },
    { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }) }
  ];
  async function* gen() { for (const e of events) yield e; }
  const deltas = [];
  for await (const d of consumeAnthropicStream(gen())) deltas.push(d);
  const usageDelta = deltas.find((d) => d.type === 'usage');
  ok('Anthropic 流产出 usage delta', !!usageDelta);
  eq('Anthropic 流保留读命中', usageDelta.usage.cached_tokens, 60);
  eq('Anthropic 流 output 取 message_delta', usageDelta.usage.completion_tokens, 20);
  eq('Anthropic 流 input 取 message_start', usageDelta.usage.prompt_tokens, 100);
}

/* ───────── 4. 回传第三方客户端不再写死 0 ───────── */

{
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 40 };
  const obj = toResponsesObject({ id: 'r1', model: 'm', text: 'ok', toolCalls: [], finishReason: 'stop', usage });
  eq('Responses 非流式带命中', obj.usage.input_tokens_details.cached_tokens, 40);
  const sse = new ResponsesStreamWriter({ id: 'r2', model: 'm' }).finish({ finishReason: 'stop', usage });
  ok('Responses 流式带命中', sse.includes('"cached_tokens":40'));
  const obj0 = toResponsesObject({ id: 'r3', model: 'm', text: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  eq('Responses 未上报填 0（不编造）', obj0.usage.input_tokens_details.cached_tokens, 0);
}
{
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 40 };
  eq('anthropicUsage 带读命中', anthropicUsage(usage).cache_read_input_tokens, 40);
  const msg = toAnthropicMessage({ id: 'm1', model: 'm', text: 'ok', toolCalls: [], finishReason: 'stop', usage });
  eq('Anthropic 非流式带读命中', msg.usage.cache_read_input_tokens, 40);
  const sse = new AnthropicStreamWriter({ id: 'm2', model: 'm' }).finish({ finishReason: 'stop', usage });
  ok('Anthropic 流式 message_delta 带读命中', sse.includes('"cache_read_input_tokens":40'));
  const msg0 = toAnthropicMessage({ id: 'm3', model: 'm', text: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5 } });
  ok('Anthropic 未上报不带读命中字段', !('cache_read_input_tokens' in msg0.usage));
}

/* ───────── 5. 统计聚合：未上报 ≠ 命中 0 ───────── */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cache-test-'));
const silent = { warn() {} };
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();
let seq = 0;
const newDir = () => path.join(TMP, `d${seq += 1}`);

{
  // 窗口内全是「未上报」：cacheReported=false、命中率 null、cachedTok=0
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({ ts: NOW, ok: true, inTok: 100, outTok: 20, cachedTok: 0, cacheSeen: false });
  s.record({ ts: NOW, ok: true, inTok: 200, outTok: 30, cachedTok: 0, cacheSeen: false });
  s.flush();
  const sum = await s.summary({ days: 7 });
  eq('全未上报 → cachedTok 0', sum.totals.cachedTok, 0);
  eq('全未上报 → cacheReported=false', sum.totals.cacheReported, false);
  eq('全未上报 → cacheReportedReqs 0', sum.totals.cacheReportedReqs, 0);
  eq('全未上报 → 命中率 null（看板显示 —）', sum.totals.cacheHitRate, null);
}
{
  // 部分上报：命中率分母只算上报过的请求，不被未上报请求稀释
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({ ts: NOW, ok: true, inTok: 100, outTok: 20, cachedTok: 50, cacheSeen: true }); // 上报，命中 50/100
  s.record({ ts: NOW, ok: true, inTok: 900, outTok: 30, cachedTok: 0, cacheSeen: false }); // 未上报，大输入
  s.flush();
  const sum = await s.summary({ days: 7 });
  eq('部分上报 → cacheReported=true', sum.totals.cacheReported, true);
  eq('部分上报 → 上报数 1', sum.totals.cacheReportedReqs, 1);
  // 分母 100（只算上报记录），不是 1000；命中率 50% 而非 5%
  eq('部分上报 → 命中率 50%（不被稀释）', sum.totals.cacheHitRate, 50);
}
{
  // 显式上报 0：算上报，命中率 0%（真实地显示 0，而不是「—」）
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({ ts: NOW, ok: true, inTok: 100, outTok: 20, cachedTok: 0, cacheSeen: true });
  s.flush();
  const sum = await s.summary({ days: 7 });
  eq('显式 0 → cacheReported=true', sum.totals.cacheReported, true);
  eq('显式 0 → 命中率 0', sum.totals.cacheHitRate, 0);
}
{
  // Anthropic 语义：cache_read 不计入 input_tokens 时命中数可能 > inTok，夹到 100
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({ ts: NOW, ok: true, inTok: 10, outTok: 20, cachedTok: 90, cacheSeen: true });
  s.flush();
  const sum = await s.summary({ days: 7 });
  eq('命中率夹到 100 防越界', sum.totals.cacheHitRate, 100);
}
{
  // 旧记录兼容：没有 cacheSeen 标记但 cachedTok>0，用命中数反推为「已上报」
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({ ts: NOW, ok: true, inTok: 200, outTok: 20, cachedTok: 100 }); // 无 cacheSeen（旧版落盘）
  s.flush();
  const sum = await s.summary({ days: 7 });
  eq('旧记录反推 → cacheReported=true', sum.totals.cacheReported, true);
  eq('旧记录反推 → 命中率 50%', sum.totals.cacheHitRate, 50);
  const rows = fs.readFileSync(path.join(dir, `${dayKey(NOW)}.jsonl`), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  ok('cacheSeen=false 不落盘（稀疏标记）', !('cacheSeen' in rows[0]));
}
{
  // cacheSeen=true 才落盘
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({ ts: NOW, ok: true, inTok: 100, outTok: 20, cachedTok: 40, cacheSeen: true });
  s.flush();
  const rows = fs.readFileSync(path.join(dir, `${dayKey(NOW)}.jsonl`), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  eq('cacheSeen=true 落盘', rows[0].cacheSeen, true);
}

/* ───────── 6. 端到端：真实 HTTP 请求 → /api/usage/summary ───────── */

/** 起一个真 server，渠道按需吐指定形状的 usage delta（模拟各归一化层的产物） */
const e2eLog = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cache-e2e-'));
  const state = { usage: null };
  const ch = {
    id: 'cache', displayName: '缓存测试渠道', supported: true,
    requiresAccount: false, loginMode: 'none',
    listModels: async () => [{ id: 'm1' }],
    async *stream() {
      yield { type: 'text', text: 'ok' };
      if (state.usage) yield { type: 'usage', usage: state.usage };
      yield { type: 'finish', reason: 'stop' };
    }
  };
  const registry = { list: () => [ch], get: () => ch };
  const { server, uiToken } = createApp({ dataDir: dir, log: e2eLog, registry });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${DEFAULT_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body })
  });
  const summary = async () => (await (await fetch(base + '/api/usage/summary?days=1', {
    headers: { 'x-ofm-ui-token': uiToken }
  })).json()).value;
  return { state, server, dir, post, summary };
}

// 场景 1：上游上报缓存（非流式 + 流式），回传客户端 + 落盘 + 聚合全链路
{
  const a = await startApp();
  try {
    a.state.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 40 };
    const r1 = await a.post({ model: 'cache/m1', stream: false });
    const j1 = await r1.json();
    eq('E2E 非流式 200', r1.status, 200);
    eq('E2E 回传客户端 usage 带命中 40', j1.usage?.prompt_tokens_details?.cached_tokens, 40);

    a.state.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 30 };
    const r2 = await a.post({ model: 'cache/m1', stream: true });
    const sse = await r2.text();
    ok('E2E 流式 usage 帧带命中 30', /"cached_tokens":30/.test(sse));

    await sleep(250);
    const sum = await a.summary();
    eq('E2E 两条请求', sum.totals.requests, 2);
    eq('E2E cachedTok 汇总 70', sum.totals.cachedTok, 70);
    eq('E2E cacheReported=true', sum.totals.cacheReported, true);
    eq('E2E 上报数 2', sum.totals.cacheReportedReqs, 2);
    eq('E2E 命中率 35%（分母=200）', sum.totals.cacheHitRate, 35);
  } finally {
    a.server.close();
    fs.rmSync(a.dir, { recursive: true, force: true });
  }
}

// 场景 2：上游完全不上报缓存 → 看板应显示「—」而不是 0%
{
  const a = await startApp();
  try {
    a.state.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    const r = await a.post({ model: 'cache/m1', stream: false });
    const j = await r.json();
    ok('E2E 未上报响应不编造 details', !('prompt_tokens_details' in (j.usage || {})));
    await sleep(250);
    const sum = await a.summary();
    eq('E2E 未上报 cachedTok 0', sum.totals.cachedTok, 0);
    eq('E2E 未上报 cacheReported=false', sum.totals.cacheReported, false);
    eq('E2E 未上报命中率 null（看板显示 —）', sum.totals.cacheHitRate, null);
  } finally {
    a.server.close();
    fs.rmSync(a.dir, { recursive: true, force: true });
  }
}

// 场景 3：渠道漏挂统一字段、只吐上游原始命名 → server 兜底仍能记到
{
  const a = await startApp();
  try {
    a.state.usage = { prompt_tokens: 100, completion_tokens: 20, cache_read_input_tokens: 50 };
    const r = await a.post({ model: 'cache/m1', stream: false });
    await r.text();
    await sleep(250);
    const sum = await a.summary();
    eq('E2E 原始命名兜底记到命中 50', sum.totals.cachedTok, 50);
    eq('E2E 原始命名兜底 cacheReported=true', sum.totals.cacheReported, true);
  } finally {
    a.server.close();
    fs.rmSync(a.dir, { recursive: true, force: true });
  }
}

console.log(`\n✓ test/cache-tokens.mjs 通过 ${passed} 项断言`);
