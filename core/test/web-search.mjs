/**
 * 网页搜索与读取验收（M33）。全程本地 mock，不联网、不需要账号。
 * 运行：node test/web-search.mjs
 *
 * 覆盖：模板占位符 / 字段路径 / 结果清洗 / 配置归一化 / SSRF /
 *       自定义搜索与读取 / Bing 解析 / MCP 解析 / 回退链 / 冷却 / 缓存 / MCP 协议
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderTemplate, jsonEscape, pickPath, pickList, pickString } from '../src/search/template.js';
import {
  decodeEntities,
  stripBrokenChars,
  cleanText,
  snippet,
  normalizeUrl,
  shapeResults,
  wrapUntrusted
} from '../src/search/sanitize.js';
import { normalizeWebSearch, maskKey } from '../src/search/config.js';
import { assertSafeUrl, assertResolvedSafe } from '../src/search/ssrf.js';
import { classifyFailure } from '../src/search/runner.js';
import { parseMcpFrames, itemsFromContents, readMcpResult } from '../src/search/engines/mcp-keyless.js';
import { extractReadable } from '../src/search/read.js';
import { parseBingHtmlForTest } from '../src/search/engines/bing.js';
import { createRunner } from '../src/search/runner.js';
import { isSelfEndpoint, lanAddresses, SelfLoopError } from '../src/search/self-ref.js';
import { Store } from '../src/store.js';
import { createSearchService } from '../src/search/index.js';
import { createMcpServer, TOOLS } from '../src/mcp/server.js';
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

/* ───────── 1. 模板与字段路径 ───────── */

await test('模板占位符', async () => {
  eq(
    'query_json 转义后不带外层引号',
    renderTemplate('{"query":"{{query_json}}"}', { query_json: jsonEscape('a"b\nc') }),
    '{"query":"a\\"b\\nc"}'
  );
  eq(
    'query 原样替换（URL 场景）',
    renderTemplate('https://x.test/s?q={{query}}&n={{count}}', { query: '台风', count: 5 }),
    'https://x.test/s?q=台风&n=5'
  );
  eq(
    '未知占位符保持原样（写错要能看见）',
    renderTemplate('{"q":"{{queery}}"}', { query: 'x' }),
    '{"q":"{{queery}}"}'
  );
  eq('空模板得空串', renderTemplate('', { query: 'x' }), '');
});

await test('字段路径取值', async () => {
  const data = {
    data: { web: { results: [{ title: 'A', url: 'https://a.test', snippet: 'sa' }, { title: 'B', url: 'https://b.test' }] } }
  };
  eq('多级路径', pickPath(data, 'data.web.results'), data.data.web.results);
  eq('数组下标', pickPath(data, 'data.web.results[1].title'), 'B');
  eq('通配摊平', pickPath(data, 'data.web.results[].title').join(','), 'A,B');
  eq('数组根下标', pickPath([{ x: 1 }], '[0].x'), 1);
  eq('空路径返回自身', pickPath(data, ''), data);
  eq('取不到返回 undefined', pickPath(data, 'data.nope.x'), undefined);

  eq('自动嗅探 results', pickList(data).length, 2);
  eq('指定路径优先', pickList(data, 'data.web.results').length, 2);
  eq('指定路径不是数组时得空', pickList(data, 'data.web').length, 0);
  eq('根数组直接用', pickList([{ a: 1 }]).length, 1);
  eq('空对象得空数组', pickList({}).length, 0);

  eq('字符串字段', pickString({ title: 'T' }, 'title'), 'T');
  eq('数字字段转字符串', pickString({ n: 3 }, 'n'), '3');
  eq('对象字段取 text', pickString({ t: { text: '内层' } }, 't'), '内层');
});

/* ───────── 2. 清洗 ───────── */

await test('HTML 实体与脏字符', async () => {
  eq('命名实体', decodeEntities('a&amp;b&nbsp;c'), 'a&b c');
  eq('十进制实体 &#0183;（Bing 摘要里的 ·）', decodeEntities('x&#0183;y'), 'x·y');
  eq('十六进制实体', decodeEntities('&#x4E0A;&#x6D77;'), '上海');
  eq('非法码点丢掉', decodeEntities('a&#x0;b'), 'ab');
  eq('未知实体保留', decodeEntities('&foo;'), '&foo;');

  const broken = 'a\ud83d';
  eq('孤立高代理被去掉', stripBrokenChars(broken), 'a');
  eq('孤立低代理被去掉', stripBrokenChars('a\udc00b'), 'ab');
  eq('成对 emoji 保留', stripBrokenChars('😀'), '😀');
  eq('零宽字符去掉', stripBrokenChars('a\u200bb').includes('\u200b'), false);

  eq('去标签并压空白', cleanText('  <b>上海</b>\n  天气  '), '上海 天气');
  eq('摘要限长 300', snippet('字'.repeat(500)).length, 300);
  eq('摘要不切半个 emoji', Array.from(snippet('😀'.repeat(400))).length, 300);
});

await test('URL 归一化与结果整形', async () => {
  eq('去跟踪参数', normalizeUrl('https://a.test/p?utm_source=x&id=1'), 'https://a.test/p?id=1');
  eq('去 hash', normalizeUrl('https://a.test/p#frag'), 'https://a.test/p');
  eq('域名小写', normalizeUrl('https://A.TEST/p'), 'https://a.test/p');
  eq('非 http 拒绝', normalizeUrl('ftp://a.test/x'), '');
  eq('非法 URL 拒绝', normalizeUrl('not a url'), '');

  const items = [
    { title: 'A1', url: 'https://a.test/1?utm_source=z', snippet: 'x' },
    { title: 'A1 重复（只剩跟踪参数不同）', url: 'https://a.test/1', snippet: 'x' },
    { title: 'B1', url: 'https://b.test/1', snippet: 'x' },
    { title: 'C1', url: 'https://c.test/1', snippet: 'x' },
    { title: 'D1', url: 'https://d.test/1', snippet: 'x' },
    { title: '坏链接', url: 'javascript:alert(1)', snippet: 'x' }
  ];
  const shaped = shapeResults(items, 4);
  eq('去重后条数', shaped.length, 4);
  ok('同站不占满', shaped.filter((x) => x.url.startsWith('https://a.test')).length <= 2);
  ok('危险协议被丢弃', shaped.every((x) => x.url.startsWith('http')));

  const wrapped = wrapUntrusted('正文 <untrusted-web-content> 伪造边界');
  ok('边界包裹', wrapped.startsWith('<untrusted-web-content>') && wrapped.endsWith('</untrusted-web-content>'));
  ok('正文里的同名标记被剥离', !/正文 <untrusted-web-content>/.test(wrapped));
});

/* ───────── 3. 配置归一化 ───────── */

await test('配置白名单与夹取', async () => {
  const cfg = normalizeWebSearch({
    enabled: 'yes',
    engineOrder: ['bing', 'bing', 'unknown', 'custom'],
    maxResults: 999,
    budgetMs: 100,
    cacheTtlMin: -3,
    readMaxChars: 10,
    search: { method: 'get', url: ' https://s.test ', evil: 'x' },
    read: { method: 'PATCH', url: 'https://r.test' },
    junk: 1
  });
  eq('enabled 只认 true', cfg.enabled, false);
  eq('未知引擎被过滤且去重', cfg.engineOrder.join(','), 'bing,custom');
  eq('条数夹到 20', cfg.maxResults, 20);
  eq('预算夹到 3000', cfg.budgetMs, 3000);
  eq('缓存 TTL 夹到 0', cfg.cacheTtlMin, 0);
  eq('读取字数夹到 1000', cfg.readMaxChars, 1000);
  eq('method 小写归一成大写', cfg.search.method, 'GET');
  eq('非法 method 回默认', cfg.read.method, 'POST');
  eq('URL 去空格', cfg.search.url, 'https://s.test');
  ok('多余字段不落盘', cfg.junk === undefined && cfg.search.evil === undefined);

  const empty = normalizeWebSearch(null);
  eq('默认关闭', empty.enabled, false);
  eq('默认链首为 custom', empty.engineOrder[0], 'custom');
  ok('默认链含实测可用源', ['bing', 'keenable', 'exa', 'parallel', 'anysearch'].every((x) => empty.engineOrder.includes(x)));

  eq('Key 只回尾号', maskKey('sk-abcdefgh1234'), '****1234');
  eq('短 Key 不回显', maskKey('abc'), '****');
  eq('空 Key 空串', maskKey(''), '');
});

/* ───────── 4. SSRF ───────── */

await test('SSRF 拦截', async () => {
  const blocked = [
    'http://127.0.0.1/x',
    'http://localhost:8080/',
    'http://10.0.0.1/',
    'http://172.20.1.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://metadata.google.internal/',
    'file:///etc/passwd',
    'ftp://a.test/'
  ];
  for (const url of blocked) {
    let threw = false;
    try {
      assertSafeUrl(url, { selfPort: 18900 });
    } catch {
      threw = true;
    }
    ok(`拦 ${url}`, threw);
  }
  ok('公网地址放行', Boolean(assertSafeUrl('https://example.com/a', {})));
  ok('配置允许内网（自建 SearXNG）', Boolean(assertSafeUrl('http://192.168.1.9:8080/search', { allowPrivate: true })));
  ok('带账号密码的 URL 拒绝', (() => {
    try {
      assertSafeUrl('https://user:pass@a.test/', {});
      return false;
    } catch {
      return true;
    }
  })());

  let dnsBlocked = false;
  try {
    await assertResolvedSafe('127.0.0.1');
  } catch {
    dnsBlocked = true;
  }
  ok('域名解析到内网也拦', dnsBlocked);
});

/* ───────── 5. 失败分类 ───────── */

await test('失败分类决定冷却', async () => {
  eq('402 归额度', classifyFailure(new Error('HTTP 402 payment required')), 'quota');
  eq('quota 字样优先于 429', classifyFailure(new Error('429 quota exceeded')), 'quota');
  eq('401 归鉴权', classifyFailure(Object.assign(new Error('x'), { status: 401 })), 'auth');
  eq('403 归鉴权', classifyFailure(new Error('HTTP 403 forbidden')), 'auth');
  eq('验证码归反爬', classifyFailure(new Error('unusual traffic captcha')), 'bot-wall');
  eq('超时归临时故障', classifyFailure(new Error('timeout 12000ms')), 'transient');
  eq('5xx 归临时故障', classifyFailure(new Error('bing HTTP 502')), 'transient');
  eq('0 结果归无效响应', classifyFailure(new Error('returned 0 results')), 'invalid-response');
  eq('未知归 unknown', classifyFailure(new Error('whatever')), 'unknown');
});

/* ───────── 5.1 自环（把给第三方用的地址填回自己） ───────── */

await test('自环检测与跳过', async () => {
  // 判定：端口相同 + 主机是本机
  ok('127.0.0.1 同端口判自环', isSelfEndpoint('http://127.0.0.1:18900/v1/search', { selfPort: 18900 }));
  ok('localhost 同端口判自环', isSelfEndpoint('http://localhost:18900/v1/search', { selfPort: 18900 }));
  ok('0.0.0.0 同端口判自环', isSelfEndpoint('http://0.0.0.0:18900/v1/search', { selfPort: 18900 }));
  ok('端口不同且路径不像本机出口 → 不算自环', !isSelfEndpoint('http://127.0.0.1:18901/api/search', { selfPort: 18900 }));
  ok('本机自建 SearXNG（/search）不算自环', !isSelfEndpoint('http://127.0.0.1:8080/search', { selfPort: 18900 }));
  ok('端口漂移但路径是本机出口 → 仍算自环', isSelfEndpoint('http://127.0.0.1:18901/v1/search', { selfPort: 18900 }));
  ok('外网地址不算自环', !isSelfEndpoint('https://api.tavily.com/search', { selfPort: 18900 }));
  ok('非法 URL 不算自环', !isSelfEndpoint('not a url', { selfPort: 18900 }));
  ok('局域网地址同端口算自环', lanAddresses().every((ip) => isSelfEndpoint(`http://${ip}:18900/v1/search`, { selfPort: 18900 })));

  // 错误分类：不能落进 auth（否则会话级冷却，把整个自定义源永久关掉）
  eq('自环单独归类', classifyFailure(new SelfLoopError('http://127.0.0.1:18900/v1/search', 18900)), 'self-loop');

  // runner 层：自环跳过 → 不冷却 → 直接换下一个源，note 说明原因
  const cfg = { enabled: true, engineOrder: ['custom', 'b'], disabledEngines: [], maxResults: 5, budgetMs: 5000, cacheTtlMin: 0 };
  let called = 0;
  const runner = createRunner({
    getConfig: () => cfg,
    engines: {
      custom: async () => {
        called += 1;
        throw new SelfLoopError('http://127.0.0.1:18900/v1/search', 18900);
      },
      b: async () => ({ sources: [{ title: 'B 结果', url: 'https://b.test/1', snippet: '' }] })
    },
    now: () => Date.now()
  });
  const r = await runner.search({ query: 'self-loop', count: 3 });
  eq('自环后换到可用源', r.provider, 'b');
  ok('note 写明地址填成本机', /本机/.test(r.note), r.note);
  eq('只尝试一次', called, 1);

  // 不冷却：第二次还会再试（配置改对了立刻生效，不用等进程重启）
  await runner.search({ query: 'self-loop-2', count: 3 });
  eq('没有被会话级冷却锁死', called, 2);
});

/* ───────── 6. Bing 解析 ───────── */

await test('Bing HTML 解析（含 ck 跳转链与脏实体）', async () => {
  const html = `
  <html><body><ol id="b_results">
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=1&u=a1aHR0cHM6Ly93d3cudGlhbnFpLmNvbS9zaGFuZ2hhaS90b2RheS8&ntb=1">【上海今天<strong>天气</strong>预报】</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">2025年9月16日&ensp;&#0183;&ensp;上海天气网为您提供&#8230;</p></div></li>
  <li class="b_algo"><h2><a href="https://www.weather.com.cn/weather/101020100.shtml">上海天气</a></h2>
    <p>7 小时之前&ensp;&#0183;&ensp;中央气象台</p></li>
  </ol></body></html>`;
  // 只用解析函数，不发网络
  const items = parseBingHtmlForTest(html);
  eq('解析出两条', items.length, 2);
  eq('ck 链接还原真实 URL', items[0].url, 'https://www.tianqi.com/shanghai/today/');
  eq('标题不插空格', items[0].title, '【上海今天天气预报】');
  ok('摘要实体已解码', items[0].snippet.includes('·') && !items[0].snippet.includes('&ensp;'));
  eq('普通链接原样保留', items[1].url, 'https://www.weather.com.cn/weather/101020100.shtml');
});

/* ───────── 7. MCP 响应解析 ───────── */

await test('MCP 响应解析（纯 JSON / SSE / 嵌套 JSON / 文本）', async () => {
  const plainJson = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ title: 'A', url: 'https://a.test', publish_date: '2026-01-01' }] }) }] }
  });
  eq('纯 JSON 帧数', parseMcpFrames(plainJson).length, 1);
  const r1 = readMcpResult(plainJson);
  eq('嵌套 JSON 结果数', itemsFromContents(r1.contents).length, 1);

  const sse = `event: message\ndata: ${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: { content: [{ type: 'text', text: 'Title: 某新闻\nURL: https://n.test/a\nPublished: 2026-02-02\nHighlights: 摘要内容' }] }
  })}\n\n`;
  const r2 = readMcpResult(sse);
  const items2 = itemsFromContents(r2.contents);
  eq('SSE 文本格式解析', items2.length, 1);
  eq('标题正确', items2[0].title, '某新闻');
  eq('发布日期正确', items2[0].published_at, '2026-02-02');

  const keenableSse = `data: ${JSON.stringify({
    result: {
      content: [
        {
          type: 'text',
          text: 'Title: 免费线程\nURL: https://docs.python.org/3.13/howto.html\nAcquired: 2026-10-17\nSnippets:\n从 3.13 起支持可选的 free-threading 构建。'
        }
      ]
    }
  })}\n\n`;
  const kItems = itemsFromContents(readMcpResult(keenableSse).contents);
  eq('keenable 的 Acquired/Snippets 字段也能解析', kItems.length, 1);
  eq('标题不退化成 URL', kItems[0].title, '免费线程');
  eq('Acquired 当发布日期', kItems[0].published_at, '2026-10-17');
  ok('Snippets 进摘要', kItems[0].snippet.includes('free-threading'));

  const unknownTool = JSON.stringify({ result: { content: [{ type: 'text', text: 'Unknown tool: web_search. Available tools: search_web_pages.' }], isError: true } });
  ok('isError 被识别为失败', readMcpResult(unknownTool).error.includes('Unknown tool'));

  const rpcError = JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'Method not found' } });
  ok('JSON-RPC error 被识别', readMcpResult(rpcError).error.includes('Method not found'));

  eq('空响应不炸', itemsFromContents(readMcpResult('').contents).length, 0);
});

/* ───────── 8. 正文提取 ───────── */

await test('正文提取', async () => {
  const html = `<html><head><title>标题 &amp; 站点</title><style>.a{color:red}</style></head><body>
    <nav>导航 菜单</nav><script>alert(1)</script>
    <article><h1>正文标题</h1><p>第一段内容，足够长以便被保留。</p><p>第二段内容。</p></article>
    <footer>版权信息</footer></body></html>`;
  const r = extractReadable(html, { maxChars: 2000 });
  eq('标题实体解码', r.title, '标题 & 站点');
  ok('正文包含段落', r.text.includes('第一段内容'));
  ok('脚本被剔除', !r.text.includes('alert'));
  ok('导航被剔除', !r.text.includes('导航 菜单'));
  ok('页脚被剔除', !r.text.includes('版权信息'));
  const long = extractReadable('<article>' + '<p>' + '字'.repeat(3000) + '</p></article>', { maxChars: 100 });
  ok('超长截断', long.text.length <= 100 && long.truncated);
});

/* ───────── 9. 端到端（本地 mock 服务 + 真实 HTTP） ───────── */

const mockHits = { auth: [], body: [] };
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    mockHits.auth.push(String(req.headers.authorization || ''));
    mockHits.body.push(raw);
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { web: { results: [
        { title: '自定义结果一', url: 'https://one.test/a', snippet: '摘要一' },
        { title: '自定义结果二', url: 'https://two.test/b', snippet: '摘要二' }
      ] } } }));
      return;
    }
    if (url.pathname === '/empty') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [] }));
      return;
    }
    if (url.pathname === '/401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"bad key"}');
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: [{ title: '慢', url: 'https://slow.test/' }] }));
      }, 4000);
      return;
    }
    if (url.pathname === '/read') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ title: '远端读取标题', text: '远端读取的正文内容，长度足够通过校验。'.repeat(5), final_url: 'https://final.test/x' }));
      return;
    }
    if (url.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>本地页</title></head><body><article><p>本地抓取到的正文，这里要写得足够长才能通过四十字符的正文阈值，否则会被当成前端渲染的空壳页面。</p></article></body></html>');
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
});

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${mock.address().port}`;

await test('自定义搜索：模板、鉴权、字段映射', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ws-'));
  const store = new Store(dir);
  const svc = createSearchService({ store, log: { info() {}, warn() {} }, allowPrivate: true });
  svc.saveConfig({
    enabled: true,
    engineOrder: ['custom'],
    maxResults: 5,
    search: { method: 'POST', url: `${mockBase}/search`, body: '', resultsPath: '', titlePath: 'title', urlPath: 'url', snippetPath: 'snippet' }
  });
  svc.setKeys({ search: 'sk-test-1234' });

  const r = await svc.search({ query: '台风 "最新"', count: 5 });
  eq('生效源是自定义', r.provider, 'custom');
  eq('结果条数', r.results.length, 2);
  eq('首条标题', r.results[0].title, '自定义结果一');
  ok('默认模板带 query_json 且转义正确', mockHits.body.at(-1).includes('台风 \\"最新\\"'));
  ok('自动附加 Bearer', mockHits.auth.at(-1) === 'Bearer sk-test-1234');
  eq('无回退说明', r.note, '');

  const again = await svc.search({ query: '台风 "最新"', count: 5 });
  ok('第二次命中缓存', again.cached === true);
  eq('缓存结果一致', again.results.length, 2);

  svc.saveConfig({ search: { ...svc.getConfig().search, url: `${mockBase}/empty` } });
  svc.resetRuntime();
  let emptyFailed = false;
  try {
    await svc.search({ query: '空结果', count: 3 });
  } catch (e) {
    emptyFailed = /所有搜索源都不可用/.test(e.message);
  }
  ok('0 结果不算成功', emptyFailed);
});

await test('自定义读取 + 本地抓取 + SSRF', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ws-'));
  const store = new Store(dir);
  const svc = createSearchService({ store, log: { info() {}, warn() {} }, allowPrivate: true });
  svc.saveConfig({
    enabled: true,
    engineOrder: ['custom'],
    read: { method: 'POST', url: `${mockBase}/read`, body: '', textPath: 'text', titlePath: 'title', finalUrlPath: 'final_url' }
  });
  const r = await svc.read({ url: 'https://target.test/article' });
  eq('自定义读取生效', r.provider, 'custom');
  eq('标题取自字段', r.title, '远端读取标题');
  ok('正文来自 text 字段', r.text.includes('远端读取的正文内容'));
  eq('最终地址取自字段', r.final_url, 'https://final.test/x');

  svc.saveConfig({ read: { ...svc.getConfig().read, url: '' } });
  const local = await svc.read({ url: `${mockBase}/page` });
  eq('未配自定义时走本地抓取', local.provider, 'local');
  ok('本地正文可用', local.text.includes('本地抓取到的正文'));

  const strict = createSearchService({ store, log: { info() {}, warn() {} } });
  let blocked = false;
  try {
    await strict.read({ url: 'http://127.0.0.1:9/x' });
  } catch (e) {
    blocked = /内网|本机/.test(e.message);
  }
  ok('生产模式拦内网读取', blocked);
});

await test('回退链、冷却、预算', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ws-'));
  const store = new Store(dir);
  const svc = createSearchService({ store, log: { info() {}, warn() {} }, allowPrivate: true });
  svc.saveConfig({
    enabled: true,
    engineOrder: ['custom'],
    budgetMs: 8000,
    search: { method: 'POST', url: `${mockBase}/401`, body: '' }
  });
  let msg = '';
  try {
    await svc.search({ query: '鉴权失败用例', count: 3 });
  } catch (e) {
    msg = e.message;
  }
  ok('401 时全链失败并说明原因', /所有搜索源都不可用/.test(msg) && /鉴权失败/.test(msg));
  ok('冷却已记录', svc.state().chain.find((x) => x.id === 'custom').cooling === true);

  // 冷却期内直接跳过，不再打网络
  const before = mockHits.auth.length;
  try {
    await svc.search({ query: '另一个查询', count: 3 });
  } catch {
    /* 预期失败 */
  }
  eq('冷却期内不重复打源', mockHits.auth.length, before);

});

await test('回退链本身（runner 注入假引擎）', async () => {
  const cfg = { enabled: true, engineOrder: ['a', 'b', 'c'], disabledEngines: [], maxResults: 5, budgetMs: 5000, cacheTtlMin: 5 };
  const make = (impls) => createRunner({ getConfig: () => cfg, engines: impls, now: () => Date.now() });

  // 403 → 冷却 auth → 换下一个源
  const r1 = await make({
    a: async () => {
      throw Object.assign(new Error('HTTP 403 forbidden'), { status: 403 });
    },
    b: async () => ({ sources: [{ title: 'B 结果', url: 'https://b.test/1', snippet: 's' }] })
  }).search({ query: 'q1', count: 3 });
  eq('换到下一个可用源', r1.provider, 'b');
  ok('回退说明写清原因', /鉴权失败/.test(r1.note) && /b/i.test(r1.note));

  // 0 结果不冷却，直接换源
  const r2 = await make({
    a: async () => ({ sources: [] }),
    b: async () => ({ sources: [{ title: 'B2', url: 'https://b.test/2', snippet: '' }] })
  }).search({ query: 'q2', count: 3 });
  eq('0 结果换源', r2.provider, 'b');

  // 缓存：同 query 第二次不打源
  let calls = 0;
  const runner3 = make({
    a: async () => {
      calls += 1;
      return { sources: [{ title: 'A', url: 'https://a.test/1', snippet: '' }] };
    }
  });
  await runner3.search({ query: 'same', count: 2 });
  const hit = await runner3.search({ query: 'same', count: 2 });
  eq('第二次走缓存', calls, 1);
  ok('缓存标记为真', hit.cached === true);

  // 预算：慢引擎把预算烧完就报错，不无限等
  const t0 = Date.now();
  let failed = '';
  try {
    await make({
      a: async ({ timeoutMs }) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs + 20)),
      b: async () => ({ sources: [{ title: 'B', url: 'https://b.test/9', snippet: '' }] })
    }).search({ query: 'budget', count: 2 });
  } catch (e) {
    failed = e.message;
  }
  const ms = Date.now() - t0;
  ok(`预算内失败退出（${ms}ms）`, ms < 9000 && /所有搜索源都不可用/.test(failed));

  // 全链失败要给出「每一层为什么挂」
  const allFail = make({
    a: async () => { throw new Error('HTTP 502'); },
    b: async () => { throw new Error('returned 0 results'); }
  });
  let msg = '';
  try {
    await allFail.search({ query: 'allfail', count: 2 });
  } catch (e) {
    msg = e.message;
  }
  ok('失败原因逐条带出', /临时故障/.test(msg) && /无有效结果/.test(msg));
});

/* ───────── 10. MCP 服务 ───────── */

await test('MCP 协议', async () => {
  const fake = {
    async search({ query, count }) {
      return { provider: 'bing', note: '', cached: false, ms: 12, results: [{ title: `结果:${query}`, url: 'https://a.test/1', snippet: '摘要', published_at: null }] };
    },
    async readForModel({ url }) {
      return { url, final_url: url, title: '标题', text: '<untrusted-web-content>\n正文\n</untrusted-web-content>', truncated: false, provider: 'local' };
    }
  };
  const srv = createMcpServer({ searchService: fake });
  const init = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  eq('回显客户端协议版本', init.result.protocolVersion, '2025-03-26');
  ok('声明 tools 能力', Boolean(init.result.capabilities.tools));

  const def = await srv.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  eq('没传版本时用默认', def.result.protocolVersion, '2025-06-18');

  const notif = await srv.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  eq('通知不回应', notif, null);

  const list = await srv.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  eq('工具数', list.result.tools.length, 2);
  eq('工具名', list.result.tools.map((t) => t.name).join(','), 'web_search,web_read');
  ok('schema 必填 query', TOOLS[0].inputSchema.required.includes('query'));

  const call = await srv.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'x' } } });
  ok('搜索结果进 content', call.result.content[0].text.includes('结果:x'));
  ok('结构化结果也带', Array.isArray(call.result.structuredContent.results));

  const read = await srv.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'web_read', arguments: { url: 'https://a.test' } } });
  ok('读取结果带边界', read.result.content[0].text.includes('<untrusted-web-content>'));

  const bad = await srv.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  eq('未知工具是 isError 而非协议错', bad.result.isError, true);

  const unknown = await srv.handle({ jsonrpc: '2.0', id: 7, method: 'nope/nope' });
  eq('未知方法 -32601', unknown.error.code, -32601);

  const ping = await srv.handle({ jsonrpc: '2.0', id: 8, method: 'ping' });
  ok('ping 有结果', ping.result && typeof ping.result === 'object');

  const invalid = await srv.handle(null);
  eq('非对象请求 -32600', invalid.error.code, -32600);
});

/* ───────── 11. HTTP 端点（真起服务） ───────── */

await test('HTTP 端点：鉴权、开关、响应形状、MCP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-app-'));
  const app = createApp({ dataDir: dir, log: { info() {}, warn() {}, error() {} }, allowPrivateSearch: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const key = app.store.settings.forward.key;

  const post = (p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  const auth = { authorization: `Bearer ${key}` };

  try {
    const noKey = await post('/v1/search', { query: 'x' });
    eq('未带 Key 401', noKey.status, 401);

    const off = await post('/v1/search', { query: 'x' }, auth);
    eq('默认关闭时 503', off.status, 503);

    const cfg = await post('/api/search/config', { config: {
      enabled: true,
      engineOrder: ['custom'],
      search: { method: 'POST', url: `${mockBase}/search` }
    }, keys: { search: 'sk-http-9999' } }, { 'x-ofm-ui-token': app.uiToken });
    eq('保存配置成功', cfg.status, 200);
    const cfgJson = await cfg.json();
    ok('配置返回 Key 尾号', cfgJson.value.keys.search === '****9999');
    ok('配置不返回 Key 明文', !JSON.stringify(cfgJson).includes('sk-http-9999'));

    const res = await post('/v1/search', { query: '测试', count: 2 }, auth);
    eq('搜索 200', res.status, 200);
    const body = await res.json();
    eq('object 字段', body.object, 'search.results');
    eq('provider 字段', body.provider, 'custom');
    eq('结果两条', body.results.length, 2);
    ok('结果字段齐全', ['title', 'url', 'snippet'].every((k) => k in body.results[0]));

    const getRes = await fetch(`${base}/v1/search?q=${encodeURIComponent('测试')}&count=2`, { headers: auth });
    eq('GET 形态可用', getRes.status, 200);

    const mcpInit = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, auth);
    const mcpJson = await mcpInit.json();
    ok('MCP initialize 正常', Boolean(mcpJson.result && mcpJson.result.serverInfo));

    const mcpTools = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
    ok('MCP tools/list 两个工具', (await mcpTools.json()).result.tools.length === 2);

    const mcpCall = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'web_search', arguments: { query: '测试' } } }, auth);
    const callJson = await mcpCall.json();
    ok('MCP 调用能出结果', callJson.result.content[0].text.includes('自定义结果'));

    const sse = await post('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { ...auth, accept: 'text/event-stream' });
    ok('SSE 客户端也支持', (await sse.text()).startsWith('event: message'));

    const logRes = await fetch(`${base}/api/search/log?limit=10`, { headers: { 'x-ofm-ui-token': app.uiToken } });
    const logJson = await logRes.json();
    ok('搜索日志有记录', logJson.value.entries.length > 0);
    ok('日志不含 Key', !JSON.stringify(logJson).includes('sk-http-9999'));

    const readBlocked = await post('/v1/read', { url: 'http://169.254.169.254/latest/meta-data' }, auth);
    eq('读取内网被拦', readBlocked.status, 502);
    const readBody = await readBlocked.json();
    ok('拦截原因是内网/元数据', /内网|本机|元数据/.test(readBody.error.message), readBody.error.message);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

mock.close();

/* ───────── 汇总 ───────── */

console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/web-search.mjs 通过 ${passed} 项断言`);
