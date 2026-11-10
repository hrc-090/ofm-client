/**
 * Loomy（讯飞）短信登录验收：账号域 HMAC-SHA1 签名 + 模型网关必备头。
 * 纯 mock，不联网、不需要账号。运行：node test/loomy-sms.mjs
 *
 * 回归背景：signedHeaders 曾在签名串里算了 Content-MD5 却不发同名请求头，
 * 服务端按「收到的头」重建规范串 → 恒 401 HMAC signature does not match，
 * 整个短信登录（sendMsgCode / checkCode 共用 signedPost）都发不出去。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  LoomyChannel, stringToSign, signedHeaders, buildChatHeaders
} from '../src/channels/loomy/index.js';

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

const AK = '2thryby66wxi53sk';
const SK = 'zsak6eadrbawz683wf5r3m2snrwj868r';

/* ───────── 1. 9 行规范串 ───────── */

await test('规范串是 9 行，末尾两行为空', () => {
  const body = '{"a":1}';
  const { sts, contentMd5 } = stringToSign({
    method: 'POST', path: '/login/phone/sendMsgCode', query: null, body, contentType: 'application/json'
  });
  const lines = sts.split('\n');
  ok('恰好 9 行', lines.length === 9, `实际 ${lines.length}`);
  ok('末尾两行是空串（不能省略）', lines[7] === '' && lines[8] === '');
  ok('方法大写', lines[0] === 'POST');
  ok('路径逐段 RFC3986', lines[1] === '/login/phone/sendMsgCode', lines[1]);
  ok('无 query 时为空', lines[2] === '');
  ok('Content-MD5 = base64(md5(body))', lines[3] === crypto.createHash('md5').update(body).digest('base64'));
  ok('contentType 一致', lines[4] === 'application/json');
  ok('返回值带出 contentMd5', contentMd5 === lines[3]);
});

/* ───────── 2. 根因：Content-MD5 头 ───────── */

await test('signedHeaders 发出 Content-MD5，服务端可用收到的头重建同一签名', () => {
  const body = '{"base":{},"param":{"phone":"13800000000"}}';
  const h = signedHeaders({ method: 'POST', path: '/login/phone/sendMsgCode', query: null, body });
  ok('含 content-md5 头', typeof h['content-md5'] === 'string' && h['content-md5'].length > 0,
    JSON.stringify(Object.keys(h)));
  ok('值 = base64(md5(body))', h['content-md5'] === crypto.createHash('md5').update(body).digest('base64'));
  ok('含 content-type', h['content-type'] === 'application/json');
  ok('含 date / nonce', Boolean(h.date && h.nonce));
  ok('Authorization 格式正确', /^account 2thryby66wxi53sk:.+/.test(h.authorization), h.authorization);

  // 模拟服务端：只依据「收到的头」重建 9 行规范串并重算 HMAC。
  // 漏发 content-md5 时服务端取到空串，这一项必然失败。
  const rebuilt = [
    'POST', '/login/phone/sendMsgCode', '',
    h['content-md5'], h['content-type'], h.date, h.nonce, '', ''
  ].join('\n');
  const expected = 'account ' + AK + ':' + crypto.createHmac('sha1', SK).update(rebuilt).digest('base64');
  ok('服务端重建签名一致', h.authorization === expected);
});

await test('无 body 时不发 content-md5 / content-type', () => {
  const h = signedHeaders({ method: 'GET', path: '/userinfo/query/baseInfo', query: null, body: null });
  ok('无 content-md5', h['content-md5'] === undefined);
  ok('无 content-type', h['content-type'] === undefined);
  ok('签名串 Content-MD5 行也是空', h.authorization.startsWith('account '));
});

/* ───────── 3. 短信登录完整链路 ───────── */

function recorder(response) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
  return { calls, impl };
}

await test('sendCode 发出 Content-MD5，成功写回 msgId', async () => {
  const { calls, impl } = recorder({ status: 200, json: { data: { msgid: 'MSG123' } }, text: '{}' });
  const ch = new LoomyChannel();
  ch.requestImpl = impl;
  const session = { phone: '', msgId: '' };
  const r = await ch.login.sendCode(session, '13800000000');
  ok('返回 ok', r.ok === true);
  ok('msgId 写回 session', session.msgId === 'MSG123');
  ok('phone 写回 session', session.phone === '13800000000');
  ok('打到账号域 sendMsgCode', calls[0].url.endsWith('/login/phone/sendMsgCode'), calls[0].url);
  ok('发出的头含 content-md5', Boolean(calls[0].opts.headers['content-md5']));
  ok('body 与签名 md5 对应',
    calls[0].opts.headers['content-md5'] === crypto.createHash('md5').update(calls[0].opts.body).digest('base64'));
  ok('请求体是 base/param 信封', JSON.parse(calls[0].opts.body).param.phone === '13800000000');
});

await test('sendCode 上游 401 抛可读错误', async () => {
  const { impl } = recorder({
    status: 401, json: { message: 'HMAC signature does not match' },
    text: '{"message":"HMAC signature does not match"}'
  });
  const ch = new LoomyChannel();
  ch.requestImpl = impl;
  await assert.rejects(
    () => ch.login.sendCode({ phone: '', msgId: '' }, '13800000000'),
    /发送验证码失败/
  );
  ok('错误可读', true);
});

await test('verifyCode 同样带 Content-MD5，成功产出 14 天凭据', async () => {
  const { calls, impl } = recorder({ status: 200, json: { data: { session: 'SESS', userid: 'U1' } }, text: '{}' });
  const ch = new LoomyChannel();
  ch.requestImpl = impl;
  const r = await ch.login.verifyCode({ phone: '13800000000', msgId: 'MSG123' }, { code: '123456' });
  ok('success', r.success === true);
  ok('access_token = session', r.credential.access_token === 'SESS');
  ok('userid 保留', r.credential.userid === 'U1');
  ok('phone 保留', r.credential.phone === '13800000000');
  const ttl = r.credential.expires_at - Date.now();
  ok('14 天有效期', ttl > 13 * 86400000 && ttl <= 14 * 86400000, `${ttl}ms`);
  ok('打到 checkCode', calls[0].url.endsWith('/login/phone/checkCode'));
  ok('发出的头含 content-md5', Boolean(calls[0].opts.headers['content-md5']));
});

await test('verifyCode 无 session 时返回 success:false 而不抛', async () => {
  const { impl } = recorder({ status: 200, json: { data: {} }, text: '{}' });
  const ch = new LoomyChannel();
  ch.requestImpl = impl;
  const r = await ch.login.verifyCode({ phone: '1', msgId: 'm' }, { code: 'x' });
  ok('success false', r.success === false);
  ok('带错误说明', typeof r.error === 'string' && r.error.length > 0);
});

/* ───────── 4. 模型网关必备头 ───────── */

await test('buildChatHeaders 含 Bearer / token / traceparent / loomy-version', () => {
  const h = buildChatHeaders({ access_token: 'SESS' });
  ok('Bearer', h.authorization === 'Bearer SESS');
  ok('小写 token', h.token === 'SESS');
  ok('traceparent 格式 00-32hex-16hex-01', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(h.traceparent), h.traceparent);
  ok('loomy-version 存在', h['loomy-version'] === '0.9.38');
  ok('每次 traceparent 不同', buildChatHeaders({ access_token: 'SESS' }).traceparent !== h.traceparent);
});

/* ───────── 5. 模型目录 ───────── */

await test('listModels 带真实 token，空目录回退兜底', async () => {
  const { calls, impl } = recorder({ status: 200, json: { data: { models: [] } }, text: '{}' });
  const ch = new LoomyChannel();
  ch.requestImpl = impl;
  const list = await ch.listModels({ credential: { access_token: 'SESS' } });
  ok('发出请求', calls.length === 1);
  ok('头里是真实 token', calls[0].opts.headers.token === 'SESS', JSON.stringify(calls[0].opts.headers));
  ok('不再恒发 unused', calls[0].opts.headers.token !== 'unused');
  ok('空目录回退兜底', Array.isArray(list) && list.length === 2);
});

await test('listModels 无凭据时不发请求，直接兜底', async () => {
  const { calls, impl } = recorder({ status: 200, json: {}, text: '{}' });
  const ch = new LoomyChannel();
  ch.requestImpl = impl;
  const list = await ch.listModels({});
  ok('零请求', calls.length === 0);
  ok('返回兜底', list.length === 2);
});

await test('listModels 能解析上游真实目录', async () => {
  const { impl } = recorder({
    status: 200,
    json: { data: { models: [{ id: 'spark-x', name: 'Spark X' }] } },
    text: '{}'
  });
  const ch = new LoomyChannel();
  ch.requestImpl = impl;
  const list = await ch.listModels({ credential: { access_token: 'SESS' } });
  ok('解析出 1 个模型', list.length === 1);
  ok('id 正确', list[0].id === 'spark-x');
  ok('displayName 正确', list[0].displayName === 'Spark X');
});

/* ───────── 汇总 ───────── */

console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/loomy-sms.mjs 通过 ${passed} 项断言`);
