/**
 * 对话链路验收：定位「第三方接入 API 无回复」。
 * 纯 mock，不联网、不需要真实账号。运行：node test/chat-diagnose.mjs
 *
 * 覆盖四层：
 *  1. TRAE 响应形状解析（自定义帧 / 标准 OpenAI 帧 / 业务错误 / 整段 JSON / 心跳）
 *  2. SSE 首有效内容帧超时（只有心跳时不能无限挂起）
 *  3. dispatch 零内容保护 + 流式错误下发为可见文本
 *  4. /api/chat/diagnose 报告字段与脱敏
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { parseTraeEvent } from '../src/channels/trae/protocol.js';
import { iterateSse, looksLikeSse } from '../src/http-client.js';
import { chatStream } from '../src/dispatch.js';
import { createApp } from '../src/server.js';
import { Codes } from '../src/errors.js';

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-chat-test-'));
const dataDir = () => fs.mkdtempSync(path.join(TMP, 'app-'));
const silentLog = { info() {}, warn() {}, error() {}, log() {} };

/* ───────── 1. 响应形状解析 ───────── */

async function contentCountOf(text) {
  let n = 0;
  for await (const evt of iterateSse(Readable.from([Buffer.from(text)]), { idleTimeoutMs: 1000 })) {
    const ev = parseTraeEvent(evt.event, evt.data);
    if (ev.response || ev.reasoningContent || ev.toolCalls?.length) n += 1;
  }
  return n;
}

const SHAPES = [
  ['TRAE 自定义 output 帧', 'event: output\ndata: {"response":"你好"}\n\n', 'sse', 1],
  ['标准 OpenAI data 帧（无 event 行）', 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n', 'sse', 1],
  ['event 名变了但字段仍是 TRAE 形状', 'event: message\ndata: {"response":"你好"}\n\n', 'sse', 1],
  ['带 reasoning 的标准帧', 'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n', 'sse', 1],
  ['只有心跳注释帧', ': keepalive\n\n: keepalive\n\n', 'sse', 0]
];

await test('TRAE 解析层：5 种 SSE 形状不再静默丢正文', async () => {
  for (const [name, text, , expected] of SHAPES) {
    let n = 0;
    let err = '';
    try { n = await contentCountOf(text); } catch (e) { err = e.message; }
    ok(name, n === expected && !err, `得到 ${n}，期望 ${expected} ${err}`);
  }
});

await test('TRAE 解析层：同一个 chunk 里的多帧必须逐帧切开（历史总根因）', async () => {
  // 真实上游会把 metadata / output / token_usage / done 一起塞进一个 TCP 包。
  // 旧实现用「对象 >= 0」做循环条件，恒为 false → 整条流只在结束时解析一次，
  // 多个 event 被合并成最后一个事件名 + 全部 data，JSON.parse 失败 → 零正文。
  const chunk =
    'event:metadata\ndata:{"session_id":"s"}\n\n' +
    'event:output\ndata:{"response":"你"}\n\n' +
    'event:output\ndata:{"response":"好"}\n\n' +
    'event:done\ndata:{"finish_reason":"stop"}\n\n';
  let frames = 0;
  let text = '';
  let finish = '';
  for await (const evt of iterateSse(Readable.from([Buffer.from(chunk)]), { idleTimeoutMs: 1000 })) {
    frames += 1;
    const ev = parseTraeEvent(evt.event, evt.data);
    if (ev.response) text += ev.response;
    if (ev.finishReason) finish = ev.finishReason;
  }
  ok('切出 4 帧', frames === 4, `实际 ${frames}`);
  ok('拼接正文为「你好」', text === '你好', `实际 ${JSON.stringify(text)}`);
  ok('读到结束原因', finish === 'stop', `实际 ${JSON.stringify(finish)}`);
});

await test('TRAE 解析层：200 + 整段 JSON 完成体可解析', async () => {
  const full = '{"choices":[{"message":{"content":"你好"},"finish_reason":"stop"}]}';
  ok('非 SSE 形状可识别', looksLikeSse(full) === false);
  const ev = parseTraeEvent('', full);
  ok('产出正文', ev.response === '你好');
  ok('产出结束原因', ev.finishReason === 'stop');
});

await test('TRAE 解析层：200 + 业务错误 JSON 抛明确错误', async () => {
  const full = '{"code":1001,"message":"model not allowed"}';
  let err = null;
  try { parseTraeEvent('', full); } catch (e) { err = e; }
  ok('确实抛错', err !== null);
  ok('错误码是上游业务错误', err?.code === Codes.UPSTREAM);
  ok('错误信息带业务码与原因', /1001/.test(err?.message || '') && /model not allowed/.test(err?.message || ''));
});

/* ───────── 2. 首有效内容帧超时 ───────── */

await test('SSE：只有心跳时首帧超时能掐断（不会无限挂起）', async () => {
  const s = new Readable({ read() {} });
  const timer = setInterval(() => s.push(Buffer.from(': ping\n\n')), 15);
  let err = null;
  const t0 = Date.now();
  try {
    for await (const evt of iterateSse(s, { idleTimeoutMs: 5000, firstEventTimeoutMs: 120 })) {
      void evt;
    }
  } catch (e) { err = e; } finally { clearInterval(timer); }
  const ms = Date.now() - t0;
  ok('确实抛错', err !== null);
  ok('错误码 TIMEOUT', err?.code === Codes.TIMEOUT);
  ok('提示「有效内容帧」', /有效内容帧/.test(err?.message || ''));
  ok('在首帧超时附近返回，而非等空闲超时', ms < 3000, `耗时 ${ms}ms`);
});

await test('SSE：有有效事件时首帧超时不误伤', async () => {
  const s = Readable.from([Buffer.from('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n')]);
  let n = 0;
  let err = null;
  try {
    for await (const evt of iterateSse(s, { idleTimeoutMs: 1000, firstEventTimeoutMs: 500 })) {
      if (parseTraeEvent(evt.event, evt.data).response) n += 1;
    }
  } catch (e) { err = e; }
  ok('无异常', err === null, err?.message);
  ok('正文仍可解析', n === 1);
});

/* ───────── 3. dispatch 零内容保护 ───────── */

function makeRegistry(streamImpl, modelIds = ['m']) {
  const ch = {
    id: 'fake', name: 'fake', displayName: '测试渠道',
    loginMode: 'none', requiresAccount: false, supported: true, note: '',
    async listModels() { return modelIds.map((id) => ({ id, displayName: id })); },
    async *stream(req, opts = {}) { yield* streamImpl(req, opts); }
  };
  return {
    channels: new Map([['fake', ch]]),
    get(id) {
      if (id !== 'fake') throw new Error(`未知渠道 ${id}`);
      return ch;
    },
    list() { return [ch]; }
  };
}

const EMPTY_STREAM = async function* () {
  yield { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } };
  yield { type: 'finish', reason: 'stop' };
};
const GOOD_STREAM = async function* () {
  yield { type: 'text', text: '正常回复' };
  yield { type: 'finish', reason: 'stop' };
};

await test('dispatch：零内容流必须抛 EMPTY_REPLY 而不是静默成功', async () => {
  const registry = makeRegistry(EMPTY_STREAM);
  const store = { settings: { accounts: [], disabledModels: {} }, writeCredential() {} };
  let err = null;
  const seen = [];
  try {
    for await (const d of chatStream({
      registry, store, settings: store.settings,
      req: { model: 'fake/m', messages: [], stream: false }, signal: null
    })) seen.push(d);
  } catch (e) { err = e; }
  ok('确实抛错', err !== null);
  ok('错误码 EMPTY_REPLY', err?.code === Codes.EMPTY_REPLY);
  ok('提示可去跑对话自检', /对话自检/.test(err?.message || ''));
  ok('不重试（retryable=false）', err?.retryable === false);
  ok('已产出的 usage/finish 仍透传', seen.length === 2);
});

await test('dispatch：有正文的流不受影响', async () => {
  const registry = makeRegistry(GOOD_STREAM);
  const store = { settings: { accounts: [], disabledModels: {} }, writeCredential() {} };
  const seen = [];
  for await (const d of chatStream({
    registry, store, settings: store.settings,
    req: { model: 'fake/m', messages: [], stream: false }, signal: null
  })) seen.push(d);
  ok('拿到正文', seen.some((d) => d.type === 'text' && d.text === '正常回复'));
});

/* ───────── 4. server：流式错误可见 + 诊断接口 ───────── */

async function startApp(registry, log = silentLog) {
  const app = createApp({ dataDir: dataDir(), log, registry, networkDiagnose: async () => ({}) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const key = app.store.settings.forward.key;
  const ui = app.uiToken;
  return {
    app, port, key, ui,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => app.server.close(resolve))
  };
}

const authHeaders = (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
const chatBody = (stream) => JSON.stringify({
  model: 'fake/m', stream, messages: [{ role: 'user', content: 'hi' }]
});

let srv = await startApp(makeRegistry(EMPTY_STREAM));
await test('流式：零内容时错误以可见正文下发（不再一片空白）', async () => {
  const r = await fetch(`${srv.base}/v1/chat/completions`, {
    method: 'POST', headers: authHeaders(srv.key), body: chatBody(true)
  });
  const text = await r.text();
  ok('HTTP 200（流已建立）', r.status === 200);
  const frames = text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  const content = frames.map((f) => f.choices?.[0]?.delta?.content || '').join('');
  ok('有可见错误文字', content.includes('[OFM 错误]'));
  ok('错误文字里带根因', /没有任何正文/.test(content));
  ok('仍保留结构化错误帧', text.includes('"code":"EMPTY_REPLY"'));
  ok('仍有 [DONE]', text.includes('data: [DONE]'));
  ok('finish_reason 非空', frames.some((f) => f.choices?.[0]?.finish_reason));
});

await test('非流式：零内容返回 502 + EMPTY_REPLY，而非 200 空 completion', async () => {
  const r = await fetch(`${srv.base}/v1/chat/completions`, {
    method: 'POST', headers: authHeaders(srv.key), body: chatBody(false)
  });
  const j = await r.json();
  ok('HTTP 502', r.status === 502, `实际 ${r.status}`);
  ok('OpenAI 错误形状', j.error?.type === 'api_error');
  ok('错误码 EMPTY_REPLY', j.error?.code === Codes.EMPTY_REPLY);
  ok('错误信息有排障指向', /对话自检/.test(j.error?.message || ''));
});

await test('对话自检：零内容时给出完整分层报告', async () => {
  const r = await fetch(`${srv.base}/api/chat/diagnose`, {
    method: 'POST', headers: { 'x-ofm-ui-token': srv.ui, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  const j = await r.json();
  ok('HTTP 200', r.status === 200);
  ok('ok=false', j.ok === false);
  ok('错误码 EMPTY_REPLY', j.error?.code === Codes.EMPTY_REPLY);
  ok('summary 有结论', /对话无有效回复/.test(j.summary || ''));
  ok('报告含 model', j.model === 'fake/m');
  ok('报告含 note（提示消耗额度）', /hi 测试消息/.test(j.note || ''));
  ok('trace 有 provider/modelId/channel', j.trace?.provider === 'fake' && j.trace?.modelId === 'm' && j.trace?.channel === '测试渠道');
  ok('trace 有帧数统计', typeof j.trace?.frames === 'number' && typeof j.trace?.contentDeltas === 'number');
  ok('trace 有响应样本字段', 'sample' in j.trace);
  ok('totalMs 已记录', typeof j.totalMs === 'number');
});
await srv.close();

/* 正常流 + 脱敏 + 指定模型 + 请求日志 */
const logs = [];
const capturingLog = { info: (m) => logs.push(m), warn() {}, error() {}, log() {} };
const LEAK = 'Bearer SECRET_TOKEN_xyz123 {"access_token":"ABCDEFG"}';
const LEAKER = async function* (req, opts = {}) {
  if (opts.trace) {
    opts.trace.url = 'https://example.test/chat';
    opts.trace.httpStatus = 200;
    opts.trace.contentType = 'text/event-stream';
    opts.trace.shape = 'sse';
    opts.trace.frames = 2;
    opts.trace.validFrames = 1;
    opts.trace.sample = LEAK;
  }
  yield { type: 'text', text: '正常回复内容' };
  yield { type: 'finish', reason: 'stop' };
};

srv = await startApp(makeRegistry(LEAKER, ['m', 'm2']), capturingLog);
await test('对话自检：有正文时 ok=true 且统计正确', async () => {
  const r = await fetch(`${srv.base}/api/chat/diagnose`, {
    method: 'POST', headers: { 'x-ofm-ui-token': srv.ui, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake/m2', prompt: 'hello' })
  });
  const j = await r.json();
  ok('HTTP 200', r.status === 200);
  ok('ok=true', j.ok === true);
  ok('summary 说明链路正常', /对话链路正常/.test(j.summary || ''));
  ok('尊重指定 model', j.model === 'fake/m2' && j.trace?.modelId === 'm2');
  ok('contentDeltas 计数', j.trace?.contentDeltas >= 1);
  ok('上游状态/形状透出', j.trace?.httpStatus === 200 && j.trace?.shape === 'sse');
  ok('帧数透出', j.trace?.frames === 2 && j.trace?.validFrames === 1);
  ok('正文样本透出', /正常回复内容/.test(j.trace?.textSample || ''));
  ok('首片段耗时已记录', typeof j.firstDeltaMs === 'number');
});

await test('对话自检：报告脱敏，不泄漏 token', async () => {
  const r = await fetch(`${srv.base}/api/chat/diagnose`, {
    method: 'POST', headers: { 'x-ofm-ui-token': srv.ui, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  const dump = JSON.stringify(await r.json());
  ok('不含 Bearer 明文', !dump.includes('SECRET_TOKEN_xyz123'));
  ok('不含 access_token 明文值', !dump.includes('ABCDEFG'));
});

await test('请求日志：POST /v1/ 完成后有结构化日志', async () => {
  logs.length = 0;
  const r = await fetch(`${srv.base}/v1/chat/completions`, {
    method: 'POST', headers: authHeaders(srv.key), body: chatBody(false)
  });
  await r.text();
  await new Promise((resolve) => setTimeout(resolve, 60));
  ok('日志已写出', logs.length > 0, JSON.stringify(logs));
  ok('含路径', logs.some((l) => l.includes('/v1/chat/completions')));
  ok('含状态码', logs.some((l) => /status=\d+/.test(l)));
  ok('含耗时', logs.some((l) => /ms=\d+/.test(l)));
});
await srv.close();

await test('对话自检：模型目录为空时给 NO_MODEL 而不是崩溃', async () => {
  const s2 = await startApp(makeRegistry(EMPTY_STREAM, []));
  const r = await fetch(`${s2.base}/api/chat/diagnose`, {
    method: 'POST', headers: { 'x-ofm-ui-token': s2.ui, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  const j = await r.json();
  ok('HTTP 200', r.status === 200);
  ok('ok=false', j.ok === false);
  ok('错误码 NO_MODEL', j.error?.code === 'NO_MODEL');
  ok('提示先连接渠道', /连接渠道/.test(j.error?.message || ''));
  await s2.close();
});

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n通过 ${passed} 项断言`);
if (results.length) {
  console.error(`失败 ${results.length} 项：\n${results.join('\n')}`);
  process.exit(1);
}
console.log('全部通过');
