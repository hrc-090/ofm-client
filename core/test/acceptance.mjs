/**
 * 验收脚本（§8）。不依赖真实账号：用 mock 渠道跑通全部协议路径。
 * 运行：node test/acceptance.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 18999;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-test-'));

const child = spawn(process.execPath, ['main.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, OFM_DATA_DIR: DATA_DIR, OFM_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (d) => process.stdout.write(`  [srv] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`  [srv!] ${d}`));

const waitFor = async () => {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未能启动');
};

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

try {
  await waitFor();
  const runtime = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runtime.json'), 'utf8'));
  const KEY = runtime.key;
  const UI = runtime.uiToken;
  const base = `http://127.0.0.1:${PORT}`;
  const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

  await test('health 无需鉴权', async () => {
    const r = await fetch(`${base}/health`);
    const j = await r.json();
    ok('health 200', r.status === 200);
    ok('health 形状', j.ok === true && j.service === 'our-free-model');
  });

  await test('未带 Key 必须 401', async () => {
    const r = await fetch(`${base}/v1/models`);
    ok('models 401', r.status === 401);
    const j = await r.json();
    ok('401 是 OpenAI 形状', j.error?.type === 'invalid_request_error');
  });

  await test('模型清单', async () => {
    const r = await fetch(`${base}/v1/models`, { headers: auth });
    const j = await r.json();
    // /v1/models 的 id 保持原始 provider/model（第三方第二行会直接显示它），
    // 渠道名只放在 display_name；真实 id 同时留在 real_id
    ok('包含 mock/echo', j.data.some((m) => m.real_id === 'mock/echo' || m.id === 'mock/echo'));
    ok('id 未被装饰', j.data.every((m) => m.id === m.real_id && !m.id.includes('::')));
    ok('id 带 provider 前缀', j.data.every((m) => m.id.includes('/')));
  });

  await test('流式对话：不丢末帧', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'mock/echo', stream: true, messages: [{ role: 'user', content: '说一句你好' }] })
    });
    const text = await r.text();
    ok('有 [DONE]', text.includes('data: [DONE]'));
    ok('有 finish_reason', text.includes('"finish_reason":"stop"'));
    ok('有 usage', text.includes('"total_tokens"'));
    const deltas = text
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)));
    const content = deltas.map((d) => d.choices?.[0]?.delta?.content || '').join('');
    ok('正文可拼接', content.includes('你好'));
  });

  await test('非流式对话', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'mock/echo', messages: [{ role: 'user', content: '1+1=?' }] })
    });
    const j = await r.json();
    ok('object 正确', j.object === 'chat.completion');
    ok('content 非空', j.choices[0].message.content.length > 0);
    ok('usage 完整', j.usage.total_tokens > 0);
  });

  await test('工具调用分片', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'mock/echo',
        stream: true,
        messages: [{ role: 'user', content: 'use tool 工具' }],
        tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object', properties: {} } } }]
      })
    });
    const text = await r.text();
    const chunks = text
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)));
    const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
    ok('首片带 id 与 name', Boolean(calls[0]?.id && calls[0]?.function?.name));
    ok('index 从 0 连续', calls.every((c) => c.index === 0));
    const args = calls.map((c) => c.function?.arguments || '').join('');
    ok('arguments 可解析', (() => {
      try {
        JSON.parse(args);
        return true;
      } catch {
        return false;
      }
    })(), args);
  });

  await test('Anthropic Messages', async () => {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock/echo', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    const text = await r.text();
    ok('message_start', text.includes('event: message_start'));
    ok('content_block_delta', text.includes('"text_delta"'));
    ok('message_stop', text.includes('event: message_stop'));
    ok('未请求 thinking 时不发 thinking 块', !text.includes('thinking_delta'));
  });

  await test('Anthropic 非流式 + count_tokens', async () => {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock/echo', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })
    });
    const j = await r.json();
    ok('type=message', j.type === 'message' && j.role === 'assistant');
    ok('stop_reason 合法', ['end_turn', 'max_tokens', 'tool_use'].includes(j.stop_reason));

    const c = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock/echo', messages: [{ role: 'user', content: 'hello 世界' }] })
    });
    const cj = await c.json();
    ok('input_tokens > 0', cj.input_tokens > 0);
  });

  await test('Responses API', async () => {
    const r = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'mock/echo', stream: true, input: 'hi' })
    });
    const text = await r.text();
    ok('response.created', text.includes('event: response.created'));
    ok('output_text.delta', text.includes('response.output_text.delta'));
    ok('response.completed', text.includes('event: response.completed'));
  });

  await test('CORS 预检', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
    ok('204', r.status === 204);
    ok('allow-origin *', r.headers.get('access-control-allow-origin') === '*');
    // 第三方 SDK 会带 x-stainless-* 等自定义头，列白名单容易漏，改为放行任意头
    ok('allow-headers 放行自定义头', r.headers.get('access-control-allow-headers') === '*');
    ok('expose x-request-id', String(r.headers.get('access-control-expose-headers') || '').includes('x-request-id'));
  });

  await test('错误可读', async () => {
    const a = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'nope/x', messages: [{ role: 'user', content: 'hi' }] })
    });
    ok('未知渠道 400', a.status === 400);

    const b = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'trae/glm-5.2', messages: [{ role: 'user', content: 'hi' }] })
    });
    const bj = await b.json();
    ok('无账号提示明确', /尚未连接账号/.test(bj.error.message));
    ok('不是 200', b.status === 400);

    const c = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'mock/echo', messages: 'oops' })
    });
    ok('非法 messages 不 500', c.status >= 400 && c.status < 500);
  });

  await test('管理接口：发起登录', async () => {
    const ui = { 'x-ofm-ui-token': UI, 'content-type': 'application/json' };
    const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: ui, body: JSON.stringify({ provider: 'trae' }) });
    const j = await r.json();
    ok('返回 loginUrl', typeof j.loginUrl === 'string' && j.loginUrl.includes('/authorization?'));
    const q = new URL(j.loginUrl).searchParams;
    ok('参数齐全（18 项）', q.size === 18, `got ${q.size}`);
    ok('auth_callback_url 正确', q.get('auth_callback_url') === 'http://127.0.0.1:18080/authorize');
    ok('带 machine_id/device_id', Boolean(q.get('machine_id')) && Boolean(q.get('device_id')));

    const poll = await fetch(`${base}/api/login/poll?accountId=${j.accountId}`, { headers: ui });
    const pj = await poll.json();
    ok('轮询返回未完成', pj.done === false);

    const del = await fetch(`${base}/api/accounts/${j.accountId}`, { method: 'DELETE', headers: ui });
    ok('可删除占位账号', del.ok);

    const noUi = await fetch(`${base}/api/status`);
    ok('管理接口需要 uiToken', noUi.status === 401);
  });

  console.log(`\n通过 ${passed} 项断言`);
  if (results.length) {
    console.error(`失败 ${results.length} 项：\n${results.join('\n')}`);
    process.exitCode = 1;
  }
} finally {
  child.kill('SIGTERM');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
