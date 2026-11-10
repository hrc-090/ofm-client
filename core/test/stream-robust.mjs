/**
 * 流式稳定性验收：专治「用着用着就断了」这一类偶发问题。
 *
 * 覆盖三处根因：
 *  1. 回显渠道按 UTF-16 单元切帧 → emoji 被切成孤立代理，严格客户端解析失败；
 *  2. 请求入口解析模型名时裸等 listAll() → 任一渠道上游卡住就把对话拖到客户端超时；
 *  3. 中断判据用 req.complete（POST 读完请求体即恒真）→ 客户端断开后上游不被取消。
 *
 * 运行：node test/stream-robust.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { MockChannel } from '../src/channels/mock.js';
import { createModelService } from '../src/dispatch.js';
import { createApp } from '../src/server.js';
import { DEFAULT_API_KEY } from '../src/store.js';
import { withTimeout } from '../src/util.js';

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

/** 孤立代理检测（分不清高位/低位单独出现都算坏） */
const hasLoneSurrogate = (s) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/** 跑一遍 mock 渠道，收集所有 text 帧 */
async function collectMock(req) {
  const ch = new MockChannel();
  const frames = [];
  let reasoning = null;
  for await (const d of ch.stream(req, {})) {
    if (d.type === 'reasoning') reasoning = d.text;
    if (d.type === 'text') frames.push(d.text);
  }
  return { frames, reasoning, joined: frames.join('') };
}

/* ───────── 1. 回显渠道切帧：不能切坏 Unicode ───────── */

await test('纯中文回显完整', async () => {
  const text = '你好世界';
  const { joined, frames } = await collectMock({ modelId: 'echo', messages: [{ role: 'user', content: text }] });
  ok('回显包含原文', joined.includes(`「${text}」`));
  ok('多帧（确实在模拟流式）', frames.length > 1);
});

await test('单个 emoji 不产生孤立代理', async () => {
  const text = '你好 😀';
  const { frames, joined } = await collectMock({ modelId: 'echo', messages: [{ role: 'user', content: text }] });
  ok('回显完整', joined.includes(`「${text}」`));
  const bad = frames.filter(hasLoneSurrogate);
  ok('没有孤立代理帧', bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  ok('每帧 JSON 往返不丢字符', frames.every((f) => JSON.parse(JSON.stringify(f)) === f));
});

await test('ZWJ 组合 emoji 不被拆到两个帧', async () => {
  const family = '👨‍👩‍👧‍👦';
  const text = `试试 ${family} 这个`;
  const { frames, joined } = await collectMock({ modelId: 'echo', messages: [{ role: 'user', content: text }] });
  ok('回显完整', joined.includes(`「${text}」`));
  ok('家庭 emoji 未被拆散', frames.some((f) => f.includes(family)), JSON.stringify(frames));
  ok('无孤立代理', frames.every((f) => !hasLoneSurrogate(f)));
});

await test('国旗 / 罕见字符（增补平面）', async () => {
  for (const text of ['🇨🇳🇯🇵', '𠮷野家 𝄞', '🎉🚀🔥']) {
    const { frames, joined } = await collectMock({ modelId: 'echo', messages: [{ role: 'user', content: text }] });
    ok(`回显完整: ${text}`, joined.includes(`「${text}」`));
    ok(`无孤立代理: ${text}`, frames.every((f) => !hasLoneSurrogate(f)));
  }
});

await test('慢速流（slow）同样安全', async () => {
  const text = '😀 慢速也要完整';
  const { frames, joined } = await collectMock({ modelId: 'slow', messages: [{ role: 'user', content: text }] });
  ok('回显完整', joined.includes(`「${text}」`));
  ok('无孤立代理', frames.every((f) => !hasLoneSurrogate(f)));
});

await test('工具调用参数分片不切坏 emoji', async () => {
  const ch = new MockChannel();
  const text = '用工具查一下 😀🎉';
  const deltas = [];
  let name = null;
  let finish = null;
  for await (const d of ch.stream({
    modelId: 'echo',
    messages: [{ role: 'user', content: text }],
    tools: [{ name: 'search', description: '搜索', parameters: { type: 'object', properties: {} } }]
  }, {})) {
    if (d.type === 'tool_call') {
      if (d.name) name = d.name;
      if (d.argumentsDelta) deltas.push(d.argumentsDelta);
    }
    if (d.type === 'finish') finish = d.reason;
  }
  ok('触发了工具调用', name === 'search' && finish === 'tool_calls');
  ok('参数分片无孤立代理', deltas.every((s) => !hasLoneSurrogate(s)), JSON.stringify(deltas));
  const args = JSON.parse(deltas.join(''));
  ok('参数能还原成合法 JSON', args.query === text, JSON.stringify(args));
});

/* ───────── 2. withTimeout ───────── */

await test('withTimeout 正常透传', async () => {
  ok('真值返回', (await withTimeout(Promise.resolve(42), 1000)) === 42);
});

await test('withTimeout 超时抛错并带时限说明', async () => {
  const started = Date.now();
  let msg = '';
  try {
    await withTimeout(new Promise((r) => setTimeout(() => r('late'), 5000)), 80, '解析模型名');
  } catch (e) {
    msg = e.message;
  }
  ok('抛错', msg.includes('超时') && msg.includes('解析模型名'), msg);
  ok('及时返回（未等到底）', Date.now() - started < 1500, `${Date.now() - started}ms`);
});

/* ───────── 3. peek：只读缓存，不发网络 ───────── */

const countingRegistry = (models = [{ id: 'e1', displayName: 'Echo 回显' }]) => {
  const counter = { calls: 0 };
  const ch = {
    id: 'mem', displayName: '内存渠道', requiresAccount: false, supported: true, loginMode: 'none',
    listModels: async () => { counter.calls += 1; return models; },
    async *stream() { yield { type: 'finish', reason: 'stop' }; }
  };
  return { registry: { list: () => [ch], get: () => ch }, counter };
};

await test('peek 未预热时为空，且不触发任何拉取', async () => {
  const { registry, counter } = countingRegistry();
  const svc = createModelService({ registry, store: { settings: { accounts: [], disabledModels: {}, modelEffort: {} } }, log });
  ok('冷启动空', svc.peek().length === 0);
  ok('没有发起 listModels', counter.calls === 0, `calls=${counter.calls}`);
});

await test('peek 命中缓存且不新增请求', async () => {
  const { registry, counter } = countingRegistry();
  const store = { settings: { accounts: [], disabledModels: {}, modelEffort: {} } };
  const svc = createModelService({ registry, store, log });
  await svc.listAll({ force: true });
  const callsAfterList = counter.calls;
  const snap = svc.peek();
  ok('peek 拿到模型', snap.length === 1 && snap[0].id === 'mem/e1', JSON.stringify(snap));
  ok('带真实 id 与显示名', snap[0].model === 'e1' && snap[0].display_name === 'Echo 回显');
  ok('peek 没有再拉一次', counter.calls === callsAfterList, `${callsAfterList} → ${counter.calls}`);
});

await test('peek 过滤被禁用模型', async () => {
  const { registry } = countingRegistry();
  const store = { settings: { accounts: [], disabledModels: { mem: { e1: true } }, modelEffort: {} } };
  const svc = createModelService({ registry, store, log });
  await svc.listAll({ force: true });
  ok('禁用模型不出现在快照里', svc.peek().length === 0);
});

await test('免账号渠道的目录也进缓存（否则 peek 永远查不到它）', async () => {
  const { registry, counter } = countingRegistry();
  const store = { settings: { accounts: [], disabledModels: {}, modelEffort: {} } };
  const svc = createModelService({ registry, store, log });
  await svc.listAll();
  const first = counter.calls;
  await svc.listAll(); // 5 分钟内应命中缓存
  ok('第二次不再拉取', counter.calls === first, `${first} → ${counter.calls}`);
  ok('强制刷新仍会拉', (await svc.listAll({ force: true })) && counter.calls === first + 1);
});

/* ───────── 4. HTTP：慢渠道不能拖死对话请求 ───────── */

function stallChannel() {
  return {
    id: 'stall', displayName: '卡住的渠道', requiresAccount: false, supported: true, loginMode: 'none',
    // 模拟上游一直不回：60s 后才 resolve（远超人能忍受的等待）
    listModels: () => new Promise((r) => setTimeout(() => r([]), 60000)),
    async *stream() { yield { type: 'finish', reason: 'stop' }; }
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-stream-robust-'));
const chOk = {
  id: 'ok', displayName: '正常渠道', requiresAccount: false, supported: true, loginMode: 'none',
  listModels: async () => [{ id: 'm1', displayName: '模型一' }],
  async *stream() { yield { type: 'text', text: 'hi' }; yield { type: 'finish', reason: 'stop' }; }
};
const both = [chOk, stallChannel()];
const { server, uiToken } = createApp({
  dataDir: dir,
  log,
  registry: { list: () => both, get: (id) => both.find((c) => c.id === id) }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const v1Post = (body) => fetch(base + '/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${DEFAULT_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

try {
  await test('冷启动 + 有渠道卡住：入口解析不被拖死', async () => {
    const t0 = Date.now();
    const r = await v1Post({ model: '不存在的名字', stream: false, messages: [{ role: 'user', content: 'hi' }] });
    const ms = Date.now() - t0;
    ok('快速返回（< 6s，不会等 60s）', ms < 6000, `${ms}ms`);
    ok('给出清晰的 400', r.status === 400, `status=${r.status}`);
    const j = await r.json();
    ok('错误信息提到模型 id 格式', /provider\/|模型/.test(JSON.stringify(j)), JSON.stringify(j).slice(0, 200));
  });

  await test('目录预热后，用显示名也能瞬间命中', async () => {
    await fetch(base + '/api/models', { headers: { 'x-ofm-ui-token': uiToken } });
    const t0 = Date.now();
    const r = await v1Post({ model: '模型一', stream: false, messages: [{ role: 'user', content: 'hi' }] });
    const ms = Date.now() - t0;
    ok('HTTP 200', r.status === 200, `status=${r.status}`);
    ok('走了快照（< 1s，没有再去拉目录）', ms < 1000, `${ms}ms`);
  });

  await test('真实 id 直接可用，不受慢渠道影响', async () => {
    const t0 = Date.now();
    const r = await v1Post({ model: 'ok/m1', stream: false, messages: [{ role: 'user', content: 'hi' }] });
    ok('HTTP 200', r.status === 200);
    ok('很快', Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
  });
} catch (e) {
  results.push(`HTTP 段异常: ${e.message}`);
  console.error(e);
}

/* ───────── 5. 客户端中途断开：上游必须被取消 ───────── */

await test('客户端断开后 signal 被 abort', async () => {
  let aborted = false;
  let ticks = 0;
  const chDrip = {
    id: 'drip', displayName: '滴流', requiresAccount: false, supported: true, loginMode: 'none',
    listModels: async () => [{ id: 'd1' }],
    async *stream(req, { signal } = {}) {
      for (let i = 0; i < 500; i += 1) {
        if (signal?.aborted) { aborted = true; throw new Error('aborted'); }
        yield { type: 'text', text: `${i},` };
        ticks += 1;
        await new Promise((r) => setTimeout(r, 15));
      }
      yield { type: 'finish', reason: 'stop' };
    }
  };
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-abort-'));
  const app2 = createApp({
    dataDir: dir2,
    log,
    registry: { list: () => [chDrip], get: () => chDrip }
  });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const port = app2.server.address().port;

  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { authorization: `Bearer ${DEFAULT_API_KEY}`, 'content-type': 'application/json' }
    }, (res) => {
      res.once('data', () => {
        // 收到第一帧就模拟「用户关掉对话框」
        req.destroy();
        setTimeout(resolve, 400);
      });
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ model: 'drip/d1', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  });

  const ticksAtClose = ticks;
  await new Promise((r) => setTimeout(r, 300));
  ok('确实产生了若干帧后被掐断', ticksAtClose >= 1, `ticks=${ticksAtClose}`);
  ok('上游收到 abort', aborted === true, `aborted=${aborted}`);
  ok('断开后不再持续产出', ticks <= ticksAtClose + 2, `${ticksAtClose} → ${ticks}`);

  app2.server.close();
  fs.rmSync(dir2, { recursive: true, force: true });
});

/* ───────── 收尾 ───────── */
server.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (results.length) {
  console.error(`${results.length} 项失败：`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`通过 ${passed} 项`);
process.exit(0);
