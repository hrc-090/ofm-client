/**
 * DSH（DeepSeek Harness）web-deepseek-api 插件协议兼容验收。全程本地 mock。
 * 运行：node test/dsh-web-api.mjs
 *
 * 背景：用户把 dshgo 的 web-deepseek-api.baseURL 设成本机 OFM（http://127.0.0.1:18900/v1），
 * 插件按 DeepSeek 官方协议请求 /v1/search、/v1/fetch 并严格校验响应体。之前 OFM 的搜索
 * 结果用 published_at 字段（没有 date），被判 "DeepSeek returned an invalid response body"。
 *
 * 本测试把真实插件 lib/index.js 的 mapSearchResponse / fetch decode 逐行照搬进来，
 * 用「插件视角」验证 OFM 的 HTTP 响应能被接受，避免两边口径再次漂移。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/server.js';

let passed = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const eq = (name, actual, expected) => {
  assert.equal(actual, expected, `${name}（实际 ${JSON.stringify(actual)}）`);
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

/* ───────── 照搬 DSH 插件的校验逻辑（来源：@deepseek-ai/dsh-web-deepseek-api lib/index.js） ───────── */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalidResponse() {
  return new Error('DeepSeek returned an invalid response body');
}
/** 插件对 Search API 响应的真实校验：date 必须是 null 或字符串，undefined 会抛错。 */
function pluginMapSearchResponse(response) {
  if (!isRecord(response) || !Array.isArray(response.results)) throw invalidResponse();
  return {
    sources: response.results.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.url !== 'string' || item.url.length === 0 ||
        typeof item.title !== 'string' ||
        typeof item.snippet !== 'string' ||
        (item.date !== null && typeof item.date !== 'string')
      ) throw invalidResponse();
      return {
        url: item.url,
        ...(item.title.length > 0 ? { title: item.title } : {}),
        ...(item.snippet.length > 0 ? { snippet: item.snippet } : {}),
        ...(item.date !== null && item.date.length > 0 ? { publishedAt: item.date } : {})
      };
    }),
    truncated: false
  };
}
/** 插件对 Fetch API 响应的真实校验：content 必须是字符串。 */
function pluginMapFetchResponse(payload) {
  if (!isRecord(payload) || typeof payload.content !== 'string') throw invalidResponse();
  return { content: payload.content };
}

/* ───────── 本地 mock 上游 ───────── */

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/search') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      organic_results: [
        { link: 'https://example.com/a', title: '结果 A', snippet: '摘要 A', date: '2026-01-02' },
        { link: 'https://example.com/b', title: '结果 B', snippet: '摘要 B' }
      ]
    }));
    return;
  }
  if (u.pathname === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>测试页</title></head><body><p>正文内容在这里，足够长以通过读取校验。</p></body></html>');
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}`;

/* ───────── 起 OFM 服务，配自定义搜索 + 读取 ───────── */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-dsh-'));
const app = createApp({ dataDir: dir, log: { info() {}, warn() {}, error() {} }, allowPrivateSearch: true });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;
const key = app.store.settings.forward.key;
const auth = { authorization: `Bearer ${key}` };
const post = (p, body, headers = {}) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

try {
  await test('配好自定义搜索与读取后，/v1/search 结果能被 DSH 插件接受', async () => {
    const cfg = await post('/api/search/config', {
      config: {
        enabled: true,
        engineOrder: ['custom'],
        search: {
          method: 'POST', url: `${mockBase}/search`, resultsPath: 'organic_results',
          titlePath: 'title', urlPath: 'link', snippetPath: 'snippet', publishedPath: 'date'
        },
        read: { method: 'GET', url: `${mockBase}/page`, textPath: '' }
      }
    }, { 'x-ofm-ui-token': app.uiToken });
    eq('配置保存成功', cfg.status, 200);

    // 模拟插件请求体（含 need_content / ori_question）
    const res = await post('/v1/search', {
      query: '测试', count: 8, need_content: false, ori_question: '今天天气'
    }, auth);
    eq('搜索 200', res.status, 200);
    const body = await res.json();

    // 关键断言：每条结果都有 date（null 或字符串），不能再是 published_at-only
    ok('结果集非空', Array.isArray(body.results) && body.results.length >= 1);
    for (const item of body.results) {
      ok(`结果 ${item.url} 的 date 是 null 或字符串`,
        item.date === null || typeof item.date === 'string', JSON.stringify(item.date));
      ok(`结果 ${item.url} 保留 published_at 兼容旧 App`,
        'published_at' in item);
    }

    // 用插件真实校验函数过一遍——这是验收的核心
    const mapped = pluginMapSearchResponse(body);
    ok('DSH mapSearchResponse 通过', mapped.sources.length >= 1);
    ok('映射出 snippet', mapped.sources.every((s) => typeof s.snippet === 'string'));
  });

  await test('无日期的结果 date 必须是 null（不是 undefined）', async () => {
    // mock 的第二条没有 date，shapeResults 产出 published_at=null → OFM 补 date=null
    const res = await post('/v1/search', { query: '测试2', count: 8 }, auth);
    const body = await res.json();
    const noDate = body.results.find((r) => r.title === '结果 B') || body.results[0];
    eq('无日期项 date 为 null', noDate.date, null);
    pluginMapSearchResponse(body); // 不抛即通过
    ok('整批仍能被插件接受', true);
  });

  await test('/v1/fetch 返回 {content:string}，能被 DSH Fetch 插件接受', async () => {
    const res = await post('/v1/fetch', { url: `${mockBase}/page` }, auth);
    eq('fetch 200', res.status, 200);
    const body = await res.json();
    ok('返回 content 字段', typeof body.content === 'string', typeof body.content);
    ok('content 非空', body.content.length > 0);
    const mapped = pluginMapFetchResponse(body);
    ok('DSH Fetch decode 通过', mapped.content.length > 0);
  });

  await test('/v1/fetch 未带 Key 返回 401', async () => {
    const res = await post('/v1/fetch', { url: `${mockBase}/page` });
    eq('fetch 无 Key 401', res.status, 401);
  });

  await test('旧出口 /v1/read 未被破坏', async () => {
    const res = await post('/v1/read', { url: `${mockBase}/page` }, auth);
    eq('read 200', res.status, 200);
    const body = await res.json();
    eq('object 字段仍是 web.page', body.object, 'web.page');
    ok('text 仍在', typeof body.text === 'string');
  });

  await test('带 <style> 的 HTML 不会被当成正文喂给模型（百度 CSS 踩坑）', async () => {
    const { stripNonTextBlocks } = await import('../src/search/sanitize.js');
    const { extractReadable } = await import('../src/search/read.js');
    const css =
      '.bdsug li.bdsug-pcDirect-is-s{background-color:#f0f0f0}' +
      '.bdsug .bdsug-newicon{color:#929292;opacity:.7;font-size:12px}' +
      '#content_left .c-container .result{margin-bottom:14px}';
    const html = `<!doctype html><html><head><title>百度搜索</title><style>${css}</style></head><body><div id="wrapper"><style>${css}</style><div id="content_left"><h3>真正的标题</h3><p>这是应该保留的正文内容。</p></div></div></body></html>`;

    // 明文 HTML 走 cleanText 的路径（自定义读取非 JSON 分支）
    ok('stripNonTextBlocks 剔除 style', !stripNonTextBlocks(html).includes('bdsug'));
    // 标准读取路径
    const r = extractReadable(html);
    ok('extractReadable 不含 CSS', !r.text.includes('bdsug') && !r.text.includes('background-color'));
    ok('extractReadable 保留真正文', r.text.includes('应该保留的正文'));
    // 只有开标签的截断残块也要剔除
    ok('未闭合 style 残块剔除', !stripNonTextBlocks(`<style>${css}<p>正文`).includes('bdsug'));
  });
} finally {
  await new Promise((r) => app.server.close(r));
  await new Promise((r) => mock.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/dsh-web-api.mjs 通过 ${passed} 项断言`);
