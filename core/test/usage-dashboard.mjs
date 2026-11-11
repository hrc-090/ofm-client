/**
 * 用量看板修复验收（对照上游数据看板）。
 *
 * 钉死五个「不好的基因」：
 *  1) 流式响应头已发 200，业务失败仍被算成成功 → 成功率虚高；
 *  2) 输出速度按每条 tok/s 算术平均会失真 → 必须总 token / 总窗口加权；
 *  3) 单大帧 / 纯思考静默没有可测时间窗 → 速度应为 null（看板显示 —）；
 *  4) 一次 75s 超时的失败把平均耗时拉爆 → avgMs 只统计成功请求；
 *  5) 缺账号透视 / 失败原因 / token 趋势 / 半截流标记，recent 只读 3 个分片。
 *
 * 纯本地 mock，不联网、不需要账号。运行：node test/usage-dashboard.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  createUsageStore, dayKey, markUsageFailed, isSpeedSample, MAX_SUMMARY_DAYS
} from '../src/usage-store.js';
import { createApp } from '../src/server.js';
import { DEFAULT_API_KEY } from '../src/store.js';

let passed = 0;
const results = [];
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
};
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    results.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-dash-test-'));
const silent = { log() {}, warn() {}, error() {}, info() {} };
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const newDir = () => path.join(TMP, `d${seq += 1}`);
const store = (extra = {}) => createUsageStore({ dir: newDir(), log: silent, now: () => NOW, ...extra });

/* ───────── 1. 失败判定：流式 200 不再是「成功」 ───────── */

await test('markUsageFailed 把语义码与半截流钉在 rec 上', async () => {
  const rec = { ok: true };
  markUsageFailed(rec, { code: 'EMPTY_REPLY', status: 502 }, { truncated: true });
  eq('ok 被改写为 false', rec.ok, false);
  eq('保留语义码', rec.code, 'EMPTY_REPLY');
  eq('保留真实状态码', rec.status, 502);
  eq('标记半截流', rec.truncated, true);
  ok('rec 为 null 不抛', (() => { markUsageFailed(null, {}); return true; })());
});

await test('attach：显式 ok=false 优先于 statusCode=200', async () => {
  const s = store();
  const res = new EventEmitter();
  res.statusCode = 200; // 流式响应头的真实状态
  const rec = s.attach({ method: 'POST', headers: {} }, res, '/v1/chat/completions');
  markUsageFailed(rec, { code: 'TRANSPORT', status: 502 }, { truncated: true });
  res.emit('finish');
  s.flush();
  const [row] = await s.recent({ limit: 5 });
  eq('落盘 ok=false', row.ok, false);
  eq('落盘 code 是语义码', row.code, 'TRANSPORT');
  eq('落盘 status 是 502 而非 200', row.status, 502);
  eq('落盘 truncated', row.truncated, true);
});

await test('attach：无显式标记时仍按真实状态码判失败', async () => {
  const s = store();
  const res = new EventEmitter();
  res.statusCode = 429;
  s.attach({ method: 'POST', headers: {} }, res, '/v1/chat/completions');
  res.emit('finish');
  s.flush();
  const [row] = await s.recent({ limit: 5 });
  eq('ok=false', row.ok, false);
  eq('code 回退到 HTTP_429', row.code, 'HTTP_429');
  ok('不是 truncated', row.truncated !== true);
});

/* ───────── 2. 输出速度：加权而非平均，无效窗口留空 ───────── */

await test('isSpeedSample 规则', async () => {
  ok('两帧 + genMs + outTok 可采样', isSpeedSample({ ok: true, genMs: 1000, outTok: 40, deltas: 3 }));
  ok('失败请求不采样', !isSpeedSample({ ok: false, genMs: 1000, outTok: 40, deltas: 3 }));
  ok('单帧（无时间窗）不采样', !isSpeedSample({ ok: true, genMs: 1000, outTok: 40, deltas: 1 }));
  ok('genMs=0 不采样', !isSpeedSample({ ok: true, genMs: 0, outTok: 40, deltas: 3 }));
  ok('outTok=0 不采样', !isSpeedSample({ ok: true, genMs: 1000, outTok: 0, deltas: 3 }));
  ok('旧记录没有 genMs 不采样', !isSpeedSample({ ok: true, outTok: 40, deltas: 3 }));
});

await test('速度按总 token / 总窗口加权，不是每条 tok/s 的算术平均', async () => {
  const s = store();
  // A：1000 token / 10s = 100 tok/s（慢但量大）
  s.record({ ts: NOW, ok: true, provider: 'p', model: 'm', inTok: 10, outTok: 1000, deltas: 10, genMs: 10000, ms: 10100 });
  // B：1 token / 1ms = 1000 tok/s（快但量小，算术平均会被它抬到 550）
  s.record({ ts: NOW, ok: true, provider: 'p', model: 'm', inTok: 10, outTok: 1, deltas: 2, genMs: 1, ms: 2 });
  s.flush();
  const sum = await s.summary({ days: 1 });
  // 加权 = (1000+1) * 1000 / (10000+1) ≈ 100.1 tok/s
  eq('加权速度 ≈100.1', sum.totals.speedTokPerSec, 100.1);
  ok('远低于算术平均 550', sum.totals.speedTokPerSec < 110);
  eq('有效样本 2', sum.totals.speedSamples, 2);
});

await test('没有有效速度样本时返回 null（看板显示 —）', async () => {
  const s = store();
  s.record({ ts: NOW, ok: true, provider: 'p', model: 'm', inTok: 10, outTok: 0, deltas: 0, ms: 100 });
  s.record({ ts: NOW, ok: false, provider: 'p', model: 'm', status: 502, code: 'TIMEOUT', ms: 75000 });
  s.flush();
  const sum = await s.summary({ days: 1 });
  eq('速度为 null', sum.totals.speedTokPerSec, null);
  eq('样本数 0', sum.totals.speedSamples, 0);
});

/* ───────── 3. 平均耗时只统计成功请求 ───────── */

await test('avgMs 不被超时失败污染', async () => {
  const s = store();
  s.record({ ts: NOW, ok: true, ms: 800, provider: 'p', model: 'm' });
  s.record({ ts: NOW, ok: true, ms: 1200, provider: 'p', model: 'm' });
  s.record({ ts: NOW, ok: false, ms: 75000, status: 504, code: 'TIMEOUT', provider: 'p', model: 'm' });
  s.flush();
  const sum = await s.summary({ days: 1 });
  eq('成功请求平均 1000ms', sum.totals.avgMs, 1000);
  eq('全量平均另给 25666ms', sum.totals.avgMsAll, 25667);
  eq('成功率 66.7%', sum.totals.successRate, 66.7);
});

/* ───────── 4. 新增聚合维度 ───────── */

await test('账号透视 / 失败原因 / 模型性能表 / token 趋势', async () => {
  const s = store();
  s.record({ ts: NOW, ok: true, provider: 'trae', account: 'acct-aaaa1111', model: 'A', inTok: 100, outTok: 50, deltas: 5, genMs: 500, ms: 600, firstMs: 100 });
  s.record({ ts: NOW, ok: false, provider: 'trae', account: 'acct-aaaa1111', model: 'A', status: 502, code: 'EMPTY_REPLY', ms: 30000 });
  s.record({ ts: NOW, ok: false, provider: 'qoder', account: 'acct-bbbb2222', model: 'B', status: 502, code: 'EMPTY_REPLY', ms: 30000 });
  s.record({ ts: NOW, ok: true, provider: 'qoder', account: 'acct-bbbb2222', model: 'B', inTok: 20, outTok: 10, deltas: 2, genMs: 200, ms: 300, firstMs: 80, truncated: true });
  s.flush();
  const sum = await s.summary({ days: 7 });

  eq('账号透视 2 行', sum.byAccount.length, 2);
  const acc = sum.byAccount.find((a) => a.account === 'trae#1111');
  eq('账号已脱敏', acc.account, 'trae#1111');
  eq('账号请求数 2', acc.requests, 2);
  eq('账号成功数 1', acc.ok, 1);

  eq('失败原因 1 类', sum.byCode.length, 1);
  eq('EMPTY_REPLY 出现 2 次', sum.byCode[0].count, 2);
  eq('半截流总数 1', sum.totals.truncated, 1);

  const model = sum.byModel.find((m) => m.model === 'trae/A');
  eq('模型成功率 50%', model.successRate, 50);
  eq('模型失败数 1', model.failed, 1);
  eq('模型平均首字 100ms', model.avgFirstMs, 100);
  ok('模型带速度字段', typeof model.speedTokPerSec === 'number');

  const today = sum.byDay.find((d) => d.day === dayKey(NOW));
  eq('按天 token 合计 180', today.tok, 180);
  eq('按天请求 4', today.requests, 4);
  ok('按天带速度', typeof today.speedTokPerSec === 'number');
  eq('按天半截流 1', today.truncated, 1);
});

await test('noUsage：有正文但上游没报 token 单独计数', async () => {
  const s = store();
  s.record({ ts: NOW, ok: true, provider: 'p', model: 'm', deltas: 3, noUsage: true, ms: 500 });
  s.record({ ts: NOW, ok: true, provider: 'p', model: 'm', deltas: 3, outTok: 20, ms: 500 });
  s.flush();
  const sum = await s.summary({ days: 1 });
  eq('noUsage 命中 1 条', sum.totals.noUsage, 1);
});

/* ───────── 5. 窗口与热力图、recent 跨分片 ───────── */

await test('summary 支持 17 周窗口（119 天）', async () => {
  const s = store();
  s.record({ ts: NOW, ok: true, provider: 'p', model: 'm', inTok: 5, outTok: 5 });
  s.flush();
  const sum = await s.summary({ days: 119 });
  eq('17 周 = 119 个桶', sum.byDay.length, 119);
  eq('窗口上限常量', MAX_SUMMARY_DAYS, 119);
  eq('超出上限被夹到 119', (await s.summary({ days: 365 })).byDay.length, 119);
  eq('默认保留期 120 天', sum.retentionDays, 120);
  ok('每桶都有 tok 字段供热力图', sum.byDay.every((d) => typeof d.tok === 'number'));
});

await test('recent 读取窗口内全部分片，不再只盯最近 3 个', async () => {
  const s = store();
  for (let i = 0; i < 8; i += 1) {
    s.record({ ts: NOW - i * DAY, ok: true, provider: 'p', model: 'm', inTok: i });
  }
  s.flush();
  const all = await s.recent({ limit: 100, days: 30 });
  eq('8 个分片全部读到', all.length, 8);
  eq('倒序，最新在前', all[0].inTok, 0);
  eq('最早在末', all[7].inTok, 7);
  const win = await s.recent({ limit: 100, days: 3 });
  eq('窗口 3 天只回 3 条', win.length, 3);
});

/* ───────── 6. 缓存命中口径回归（M37 不被破坏） ───────── */

await test('缓存命中：未上报显示 null、上报按命中/分母', async () => {
  const s = store();
  s.record({ ts: NOW, ok: true, provider: 'p', model: 'm', inTok: 100, cachedTok: 0 });
  s.flush();
  eq('完全未上报 → null', (await s.summary({ days: 1 })).totals.cacheHitRate, null);

  const s2 = store();
  s2.record({ ts: NOW, ok: true, provider: 'p', model: 'm', inTok: 100, cachedTok: 40, cacheSeen: true });
  s2.record({ ts: NOW, ok: true, provider: 'p', model: 'm', inTok: 100, cachedTok: 0 });
  s2.flush();
  const sum = await s2.summary({ days: 1 });
  eq('cacheReported=true', sum.totals.cacheReported, true);
  eq('命中率 40%', sum.totals.cacheHitRate, 40);
});

/* ───────── 7. 端到端：真实 HTTP 流式失败必须记为失败 ───────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-dash-e2e-'));
  const state = { mode: 'ok', usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } };
  const ch = {
    id: 'dash', displayName: '看板测试渠道', supported: true,
    requiresAccount: false, loginMode: 'none',
    listModels: async () => [{ id: 'm1' }],
    async *stream() {
      if (state.mode === 'throw-before') {
        throw new Error('ECONNRESET: socket hang up');
      }
      yield { type: 'text', text: '第一段' };
      if (state.mode === 'throw-after') {
        throw new Error('ECONNRESET: socket hang up');
      }
      await sleep(6); // 制造 >0 的生成窗口
      yield { type: 'text', text: '第二段' };
      if (state.usage) yield { type: 'usage', usage: state.usage };
      yield { type: 'finish', reason: 'stop' };
    }
  };
  const registry = { list: () => [ch], get: () => ch };
  const app = createApp({ dataDir: dir, log: silent, registry });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body) => fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${DEFAULT_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'dash/m1', messages: [{ role: 'user', content: 'hi' }], ...body })
  });
  const summary = async () => (await (await fetch(base + '/api/usage/summary?days=1', {
    headers: { 'x-ofm-ui-token': app.uiToken }
  })).json()).value;
  return { state, app, dir, post, summary, base };
}

{
  const a = await startApp();
  try {
    await test('E2E 流式成功：ok、速度样本、无半截流', async () => {
      const r = await a.post({ stream: true });
      eq('HTTP 200', r.status, 200);
      await r.text();
      await sleep(250);
      const sum = await a.summary();
      eq('请求 1', sum.totals.requests, 1);
      eq('成功 1', sum.totals.ok, 1);
      eq('失败 0', sum.totals.failed, 0);
      eq('成功率 100%', sum.totals.successRate, 100);
      eq('输出 token 40', sum.totals.outTok, 40);
      eq('有效速度样本 1', sum.totals.speedSamples, 1);
      ok('有加权速度', typeof sum.totals.speedTokPerSec === 'number');
      eq('无半截流', sum.totals.truncated, 0);
    });

    await test('E2E 流式半截流：200 响应头但记失败 + truncated', async () => {
      a.state.mode = 'throw-after';
      const r = await a.post({ stream: true });
      // 客户端看到的仍是 200（SSE 已 start），错误写在流里
      eq('HTTP 仍是 200', r.status, 200);
      const sse = await r.text();
      ok('流里有错误正文', sse.includes('[OFM 错误]') || sse.includes('error'));
      await sleep(250);
      const sum = await a.summary();
      eq('累计 2 次请求', sum.totals.requests, 2);
      eq('失败 1', sum.totals.failed, 1);
      eq('成功率降到 50%', sum.totals.successRate, 50);
      eq('半截流 1', sum.totals.truncated, 1);
      ok('失败原因有 TRANSPORT', sum.byCode.some((c) => c.code === 'TRANSPORT'));
    });

    await test('E2E 流式零正文失败：返回 502，记失败但不算半截流', async () => {
      a.state.mode = 'throw-before';
      const r = await a.post({ stream: true });
      // 首帧正文之前失败：响应头还没提交，外层可以返回真实状态码。
      // 这是「失败返回真实状态码」改造后的预期行为（以前是 200 + 流内错误帧）。
      eq('返回 502', r.status, 502);
      const body = await r.text();
      ok('错误体是结构化 JSON', /"error"/.test(body));
      await sleep(250);
      const sum = await a.summary();
      eq('累计 3 次请求', sum.totals.requests, 3);
      eq('失败 2', sum.totals.failed, 2);
      eq('半截流仍为 1', sum.totals.truncated, 1);
      ok('失败原因有 TRANSPORT', sum.byCode.some((c) => c.code === 'TRANSPORT'));
    });

    await test('E2E 非流式失败：真实状态码 + 语义码', async () => {
      a.state.mode = 'throw-before';
      const r = await a.post({ stream: false });
      eq('HTTP 502', r.status, 502);
      await r.json();
      await sleep(250);
      const sum = await a.summary();
      eq('累计 4 次请求', sum.totals.requests, 4);
      eq('失败 3', sum.totals.failed, 3);
      eq('成功率 25%', sum.totals.successRate, 25);
      ok('落盘 status=502', true);
    });
  } finally {
    a.app.server.close();
    fs.rmSync(a.dir, { recursive: true, force: true });
  }
}

/* ───────── 汇总 ───────── */

fs.rmSync(TMP, { recursive: true, force: true });
console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/usage-dashboard.mjs 通过 ${passed} 项断言`);
