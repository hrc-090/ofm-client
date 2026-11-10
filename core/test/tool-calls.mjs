/**
 * 工具调用（function calling）端到端验收。
 * 纯本地 mock，不联网、不需要真实账号。运行：node test/tool-calls.mjs
 *
 * 背景：「AI 无法正常使用工具」有三种典型断点，全部覆盖：
 *  1. TRAE 的分片帧首片带 id、后续片只有 index —— 旧逻辑按 id 编号，
 *     后续片每次都被当成新调用，一个工具被拆成 N 个空参数调用；
 *  2. 上游发累计参数（每帧全量）或 `partial_arguments` —— 旧逻辑原样转发，
 *     客户端拼出 `{"a":1}{"a":1}` 或空参数，JSON 解析失败；
 *  3. openai-compat 的 SSE 分帧把 `{start,end}` 与 0 比较，循环不退出，
 *     整条流挂死（多帧的工具调用必现）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';

import { TraeChannel } from '../src/channels/trae/index.js';
import { openAiCompatStream } from '../src/openai-compat.js';
import { AnthropicStreamWriter } from '../src/convert/anthropic.js';

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

function makeChannel(sseText, { catalog = [] } = {}) {
  const bodies = [];
  const ch = new TraeChannel({
    fetchModelsImpl: async () => catalog,
    openImpl: async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return mockRes(sseText);
    }
  });
  return { ch, bodies };
}

async function collect(ch, req = {}) {
  const out = [];
  for await (const d of ch.stream(
    { modelId: 'Doubao-Seed-Code', model: 'trae/Doubao-Seed-Code', messages: [{ role: 'user', content: 'hi' }], ...req },
    { account: ACCOUNT, credential: CRED, signal: null, trace: {} }
  )) {
    out.push(d);
  }
  return out;
}

const argsOf = (deltas) => deltas.filter((d) => d.type === 'tool_call').map((d) => d.argumentsDelta).join('');
const callsOf = (deltas) => deltas.filter((d) => d.type === 'tool_call');

/* ───────── 1. 首片带 id、后续片只有 index ───────── */

await test('TRAE 分片：后续帧只有 index，仍归到同一个调用', async () => {
  const sse = [
    'event:output',
    'data:{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}',
    '',
    'event:output',
    'data:{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}',
    '',
    'event:output',
    'data:{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}',
    '',
    'event:done',
    'data:{"finish_reason":"tool_calls"}',
    '',
    ''
  ].join('\n');
  const { ch } = makeChannel(sse);
  const deltas = await collect(ch);
  const calls = callsOf(deltas);
  ok('只产生一个工具调用', calls.length >= 1);
  ok('index 全部为 0', calls.every((c) => c.index === 0), JSON.stringify(calls.map((c) => c.index)));
  ok('名字只在首片出现', calls[0].name === 'read_file');
  ok('参数拼接完整', argsOf(deltas) === '{"path":"a.txt"}', argsOf(deltas));
  ok('finish 是 tool_calls', deltas.at(-1)?.reason === 'tool_calls', JSON.stringify(deltas.at(-1)));
});

/* ───────── 2. 累计参数帧不重复 ───────── */

await test('累计参数：每帧发全量时只下发增量', async () => {
  const sse = [
    'event:output',
    'data:{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\\"a\\""}}]}',
    '',
    'event:output',
    'data:{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}',
    '',
    'event:done',
    'data:{"finish_reason":"tool_calls"}',
    '',
    ''
  ].join('\n');
  const { ch } = makeChannel(sse);
  const deltas = await collect(ch);
  ok('不重复拼接', argsOf(deltas) === '{"a":1}', argsOf(deltas));
});

/* ───────── 3. partial_arguments ───────── */

await test('partial_arguments 被当作参数而不是丢弃', async () => {
  const sse = [
    'event:output',
    'data:{"tool_calls":[{"index":0,"id":"c2","function":{"name":"f","partial_arguments":"{\\"x\\":2}"}}]}',
    '',
    'event:done',
    'data:{"finish_reason":"tool_calls"}',
    '',
    ''
  ].join('\n');
  const { ch } = makeChannel(sse);
  const deltas = await collect(ch);
  ok('参数没被扔掉', argsOf(deltas) === '{"x":2}', argsOf(deltas));
});

/* ───────── 4. 单数 tool_call / function_call ───────── */

await test('单数 tool_call + function_call 形状也能识别', async () => {
  const sse = [
    'event:output',
    'data:{"tool_call":{"id":"c3","function_call":{"name":"g","arguments":"{\\"ok\\":true}"}}}',
    '',
    'event:done',
    'data:{"finish_reason":"tool_calls"}',
    '',
    ''
  ].join('\n');
  const { ch } = makeChannel(sse);
  const deltas = await collect(ch);
  const calls = callsOf(deltas);
  ok('识别出一个调用', calls.length === 1, JSON.stringify(calls));
  ok('name 正确', calls[0]?.name === 'g');
  ok('参数正确', argsOf(deltas) === '{"ok":true}', argsOf(deltas));
});

/* ───────── 5. 并行工具（index 交错） ───────── */

await test('并行工具：两个 index 各自独立累计', async () => {
  const sse = [
    'event:output',
    'data:{"tool_calls":[{"index":0,"id":"a","function":{"name":"f1","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"f2","arguments":"{}"}}]}',
    '',
    'event:done',
    'data:{"finish_reason":"tool_calls"}',
    '',
    ''
  ].join('\n');
  const { ch } = makeChannel(sse);
  const deltas = await collect(ch);
  const calls = callsOf(deltas);
  ok('两个调用', calls.length === 2, JSON.stringify(calls));
  ok('index 0/1', calls[0].index === 0 && calls[1].index === 1);
  ok('名字各自正确', calls[0].name === 'f1' && calls[1].name === 'f2');
});

/* ───────── 6. 请求体：tools 序列化 ───────── */

await test('请求体：tools.parameters 序列化成字符串', async () => {
  const sse = 'event:output\ndata:{"response":"ok"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n';
  const { ch, bodies } = makeChannel(sse);
  await collect(ch, {
    tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    toolChoice: 'auto'
  });
  const t = bodies[0]?.tools?.[0];
  ok('带 tools', Boolean(t));
  ok('type=function', t.type === 'function');
  ok('parameters 是字符串', typeof t.function?.parameters === 'string', typeof t.function?.parameters);
  ok('parameters 可解析', JSON.parse(t.function.parameters).properties.path.type === 'string');
  ok('tool_choice 透传', bodies[0]?.tool_choice === 'auto');
});

/* ───────── 7. 多轮：assistant tool_calls + tool 结果 ───────── */

await test('多轮请求体：所有 content 都是数组，assistant 调用带 function 与 function_call', async () => {
  const sse = 'event:output\ndata:{"response":"ok"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n';
  const { ch, bodies } = makeChannel(sse);
  await collect(ch, {
    tools: [{ name: 'read_file', parameters: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: '读一下 a.txt' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
      { role: 'tool', tool_call_id: 'call_1', content: '文件内容：hello' }
    ]
  });
  const msgs = bodies[0]?.messages || [];
  const asst = msgs.find((m) => m.role === 'assistant');
  const tool = msgs.find((m) => m.role === 'tool');
  // 实测 400：cannot unmarshal string into LLMRawMessage.messages.content
  // → TRAE 的 content 只能是对象/数组，任何一条消息发字符串都会整单失败。
  ok('没有一条 content 是字符串', msgs.every((m) => typeof m.content !== 'string'), JSON.stringify(msgs.map((m) => typeof m.content)));
  ok('tool 结果被包成 text 块', tool?.content?.[0]?.type === 'text' && tool.content[0].text === '文件内容：hello', JSON.stringify(tool?.content));
  ok('assistant 正文为空数组', Array.isArray(asst?.content) && asst.content.length === 0, JSON.stringify(asst?.content));
  ok('assistant 带 function', asst?.tool_calls?.[0]?.function?.name === 'read_file');
  ok('assistant 同时带 function_call', asst?.tool_calls?.[0]?.function_call?.arguments === '{"path":"a.txt"}');
  ok('tool 消息保留 tool_call_id', tool?.tool_call_id === 'call_1');
});

/* ───────── 8. Anthropic 渲染 ───────── */

await test('Anthropic 流：tool_use 块 + input_json_delta + stop_reason', async () => {
  const w = new AnthropicStreamWriter({ id: 'msg_t', model: 'trae/x', usage: {} });
  let text = w.start();
  text += w.delta({ type: 'tool_call', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '{"path"' });
  text += w.delta({ type: 'tool_call', index: 0, argumentsDelta: ':"a.txt"}' });
  text += w.finish({ finishReason: 'tool_calls', usage: { completion_tokens: 10 } });
  ok('有一个 tool_use 块', (text.match(/"type":"tool_use"/g) || []).length === 1, text);
  ok('块只开一次', (text.match(/event: content_block_start/g) || []).length === 1);
  ok('有 input_json_delta', text.includes('"input_json_delta"'));
  ok('stop_reason=tool_use', text.includes('"stop_reason":"tool_use"'));

  const partial = [...text.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse(`"${m[1]}"`))
    .join('');
  ok('partial_json 拼成合法 JSON', (() => {
    try { return JSON.parse(partial).path === 'a.txt'; } catch { return false; }
  })(), partial);
});

/* ───────── 8. openai-compat 分帧不再空转 ───────── */

await test('openai-compat：多帧 SSE 能正常读完（回归：boundary 比较 0）', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"f","arguments":"{}"}}]}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const out = [];
  try {
    for await (const d of openAiCompatStream({
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      headers: {},
      body: { messages: [] },
      firstTokenTimeoutMs: 5000,
      idleTimeoutMs: 5000
    })) {
      out.push(d);
    }
  } finally {
    server.close();
  }
  ok('拿到两段正文', out.filter((d) => d.type === 'text').map((d) => d.text).join('') === '你好');
  ok('拿到工具调用', out.some((d) => d.type === 'tool_call' && d.name === 'f'));
});

/* ───────── 汇总 ───────── */

console.log(`\n${passed} 项断言通过`);
if (results.length) {
  console.error(`\n${results.length} 个用例失败：`);
  for (const r of results) console.error(` - ${r}`);
  process.exit(1);
}
