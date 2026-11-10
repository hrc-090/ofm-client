/**
 * 响应解压 + 错误可诊断（第 11 套）。
 *
 * 背景：真机上 TRAE 余额报「非 JSON 响应」，同一渠道签到却正常。
 * 根因是签到头带 `Accept-Encoding: gzip, deflate`，而 `node:http` 不解压 ——
 * 小响应不压缩、大响应（余额明细）压缩，于是 `JSON.parse` 拿到二进制。
 *
 * 这里用**真实 http server** 返回压缩体，验证 openUpstream → request 全链路，
 * 不 mock 解压过程。运行：node test/http-encoding.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { decodeBody, readAll, openUpstream } from '../src/http-client.js';
import { request } from '../src/upstream.js';
import { createTraeProvider } from '../src/credits/providers/trae.js';
import { mockFetcher } from '../src/credits/fetcher.js';

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
};
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

const PAYLOAD = JSON.stringify({
  user_entitlement_pack_list: [
    {
      entitlement_base_info: { quota: { credits_limit: 1000 }, display_desc: '基础包' },
      usage: { credits_amount: 300 }
    }
  ],
  note: '这是一段足够长的中文，用来验证多字节被压缩后仍能正确解码'
});

const server = http.createServer((req, res) => {
  const send = (encoding, buf, type = 'application/json') => {
    res.writeHead(200, { 'content-type': type, 'content-encoding': encoding });
    res.end(buf);
  };
  if (req.url === '/gzip') return send('gzip', zlib.gzipSync(Buffer.from(PAYLOAD)));
  if (req.url === '/deflate') return send('deflate', zlib.deflateSync(Buffer.from(PAYLOAD)));
  if (req.url === '/deflate-raw') return send('deflate', zlib.deflateRawSync(Buffer.from(PAYLOAD)));
  if (req.url === '/br') return send('br', zlib.brotliCompressSync(Buffer.from(PAYLOAD)));
  // 网关漏发 content-encoding 但实际压缩
  if (req.url === '/gzip-no-header') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(zlib.gzipSync(Buffer.from(PAYLOAD)));
  }
  if (req.url === '/html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<html><body>access denied</body></html>');
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  await test('decodeBody：gzip / deflate / 裸 deflate / br 都能还原', async () => {
    const raw = Buffer.from(PAYLOAD);
    ok('gzip', decodeBody(zlib.gzipSync(raw), 'gzip').toString('utf8') === PAYLOAD);
    ok('x-gzip', decodeBody(zlib.gzipSync(raw), 'x-gzip').toString('utf8') === PAYLOAD);
    ok('deflate', decodeBody(zlib.deflateSync(raw), 'deflate').toString('utf8') === PAYLOAD);
    ok('裸 deflate', decodeBody(zlib.deflateRawSync(raw), 'deflate').toString('utf8') === PAYLOAD);
    ok('br', decodeBody(zlib.brotliCompressSync(raw), 'br').toString('utf8') === PAYLOAD);
    ok('大小写/空白', decodeBody(zlib.gzipSync(raw), ' GZIP ').toString('utf8') === PAYLOAD);
  });

  await test('decodeBody：无编码但带 gzip 魔数时按 gzip 嗅探', async () => {
    const gz = zlib.gzipSync(Buffer.from(PAYLOAD));
    ok('魔数命中', decodeBody(gz, '').toString('utf8') === PAYLOAD);
    ok('普通文本不动', decodeBody(Buffer.from(PAYLOAD), '').toString('utf8') === PAYLOAD);
  });

  await test('decodeBody：坏数据/空体不抛错，原样返回', async () => {
    const junk = Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]);
    ok('坏 gzip 回退', decodeBody(junk, 'gzip').length === junk.length);
    ok('空体', decodeBody(Buffer.alloc(0), 'gzip').length === 0);
    ok('未知编码', decodeBody(Buffer.from('abc'), 'zstd').toString('utf8') === 'abc');
  });

  await test('readAll 按 encoding 解压（真实流）', async () => {
    const gz = zlib.gzipSync(Buffer.from(PAYLOAD));
    ok('gzip 流', (await readAll(Readable.from([gz]), 'gzip')) === PAYLOAD);
    ok('不传 encoding', (await readAll(Readable.from([Buffer.from('plain')]))) === 'plain');
  });

  await test('openUpstream + request：gzip 响应能解析成 JSON', async () => {
    const res = await request(`${base}/gzip`, { method: 'POST' });
    ok('状态 200', res.status === 200);
    ok('json 解析成功', Array.isArray(res.json?.user_entitlement_pack_list), String(res.text).slice(0, 60));
    ok('中文未被破坏', res.json?.note?.includes('多字节'));
  });

  await test('openUpstream + request：deflate / 裸 deflate / br', async () => {
    for (const p of ['/deflate', '/deflate-raw', '/br']) {
      const res = await request(`${base}${p}`);
      ok(`${p} 可解析`, Array.isArray(res.json?.user_entitlement_pack_list), `${res.status}`);
    }
  });

  await test('openUpstream：漏发 content-encoding 的 gzip 也能读', async () => {
    const res = await openUpstream(`${base}/gzip-no-header`);
    const text = await res.text();
    ok('嗅探解压', text === PAYLOAD, text.slice(0, 40));
  });

  await test('TRAE 余额：gzip 响应可解析出剩余 / 共 / 已用', async () => {
    // fetcher 走真实 http server，验证「压缩 → 解压 → JSON → 资源包」全链路
    const provider = createTraeProvider({
      fetcher: async () => {
        const r = await request(`${base}/gzip`);
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => r.headers[String(k).toLowerCase()] ?? null },
          text: async () => r.text
        };
      },
      log: { warn() {} }
    });
    const r = await provider.fetchBalance({ access_token: 'AT', uid: '123' });
    ok('balance 非空', r.balance !== null, String(r.error || ''));
    ok('剩余 700', r.balance.total === 700, String(r.balance?.total));
    ok('包数 1', r.balance.packages.length === 1);
    ok('包剩余 700', r.balance.packages[0].remaining === 700);
    ok('包总量 1000', r.balance.packages[0].total === 1000);
    ok('包已用 300', r.balance.packages[0].used === 300);
  });

  await test('TRAE 余额：返回 HTML 时错误带状态与 content-type', async () => {
    const provider = createTraeProvider({
      fetcher: mockFetcher(async () => ({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        text: '<html><body>access denied</body></html>'
      })),
      log: { warn() {} }
    });
    const r = await provider.fetchBalance({ access_token: 'AT', uid: '123' });
    ok('balance null', r.balance === null);
    ok('含 HTTP 200', String(r.error).includes('HTTP 200'), r.error);
    ok('含 content-type', String(r.error).includes('text/html'), r.error);
    ok('含样本', String(r.error).includes('access denied'), r.error);
  });

  await test('TRAE 余额：空体给出「空响应」而不是空白错误', async () => {
    const provider = createTraeProvider({
      fetcher: mockFetcher(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, text: '' })),
      log: { warn() {} }
    });
    const r = await provider.fetchBalance({ access_token: 'AT', uid: '123' });
    ok('balance null', r.balance === null);
    ok('提示空响应', String(r.error).includes('空响应'), r.error);
  });
} finally {
  server.close();
}

console.log(`\n通过 ${passed} 项断言，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
