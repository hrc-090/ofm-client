/**
 * 出站网络 / CA 根证书 / 失败原因可见性验收。
 * 纯 mock，不访问外网、不需要真实账号。
 * 运行：node test/network.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitPem, loadExtraCa, caInfo, httpsOptions, describeCa, resetCaCache } from '../src/ca-bundle.js';
import { describeNetError } from '../src/http-client.js';
import { normalizeHost, summarize, runNetworkDiagnose, DEFAULT_TARGETS } from '../src/net-diagnose.js';
import { createApp } from '../src/server.js';
import { createCreditsService } from '../src/credits/index.js';

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

const A = '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----';
const B = '-----BEGIN CERTIFICATE-----\nREVG\n-----END CERTIFICATE-----';

const allOk = (over = {}) => ({
  dns: async () => ({ ok: true, ms: 1, addresses: ['1.2.3.4'] }),
  tcp: async () => ({ ok: true, ms: 2 }),
  tls: async () => ({ ok: true, ms: 3, authorized: true, certIssuer: 'Test CA' }),
  https: async () => ({ ok: true, ms: 4, status: 200 }),
  ...over
});

// ── A. CA bundle ────────────────────────────────────────────────────────────
await test('CA：splitPem 拆分多证书', async () => {
  ok('拆出 2 张', splitPem(`${A}\n${B}`).length === 2);
});
await test('CA：splitPem 忽略非证书文本', async () => {
  ok('头部注释不算', splitPem('## Bundle of CA Root Certificates ##\n' + A).length === 1);
  ok('空文本返回空数组', splitPem('').length === 0);
  ok('null 不炸', splitPem(null).length === 0);
});
await test('CA：loadExtraCa 从指定路径加载', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ca-'));
  const p = path.join(dir, 'ca.pem');
  fs.writeFileSync(p, `${A}\n${B}`);
  try {
    const r = loadExtraCa([path.join(dir, 'missing.pem'), p]);
    ok('跳过不存在路径', r.certs.length === 2);
    ok('记录来源', r.source === p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ok('全不存在时返回空', loadExtraCa(['/definitely/not/here.pem']).certs.length === 0);
});
await test('CA：工程里真的带了 cacert.pem', async () => {
  const p = path.resolve('cacert.pem');
  ok('文件存在', fs.existsSync(p));
  ok('根证书数量合理（>100）', fs.existsSync(p) && splitPem(fs.readFileSync(p, 'utf8')).length > 100);
});
await test('CA：httpsOptions 显式提供 ca 并开启双栈择优', async () => {
  const o = httpsOptions();
  ok('ca 是数组', Array.isArray(o.ca));
  ok('ca 非空', o.ca.length > 0);
  ok('autoSelectFamily 打开', o.autoSelectFamily === true);
  ok('不关校验证书', o.rejectUnauthorized === undefined);
});
await test('CA：describeCa 只报数量不泄漏证书内容', async () => {
  const d = describeCa();
  ok('有 total', typeof d.total === 'number' && d.total > 0);
  ok('有 builtinRootCerts', typeof d.builtinRootCerts === 'number');
  ok('有 bundledRootCerts', typeof d.bundledRootCerts === 'number');
  ok('不含 PEM 文本', !JSON.stringify(d).includes('BEGIN CERTIFICATE'));
});
await test('CA：caInfo 缓存 + OFM_CA_FILE 覆盖可重置', async () => {
  ok('重复调用同一对象', caInfo() === caInfo());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ca2-'));
  const p = path.join(dir, 'extra.pem');
  fs.writeFileSync(p, A);
  const prev = process.env.OFM_CA_FILE;
  try {
    process.env.OFM_CA_FILE = p;
    resetCaCache();
    ok('环境变量生效', caInfo().extraCount === 1);
    ok('来源是环境变量路径', caInfo().source === p);
  } finally {
    if (prev === undefined) delete process.env.OFM_CA_FILE;
    else process.env.OFM_CA_FILE = prev;
    resetCaCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ok('恢复后仍可用', describeCa().total > 0);
});

// ── B. 错误码翻译 ──────────────────────────────────────────────────────────
await test('诊断：TLS / DNS / 网络错误码翻成人话', async () => {
  ok('证书链', describeNetError({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }).includes('证书链校验失败'));
  ok('找不到签发者', describeNetError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }).includes('根证书'));
  ok('自签链', describeNetError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }).includes('自签'));
  ok('证书过期', describeNetError({ code: 'CERT_HAS_EXPIRED' }).includes('系统时间'));
  ok('域名不匹配', describeNetError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }).includes('DNS 劫持'));
  ok('DNS 失败', describeNetError({ code: 'ENOTFOUND' }).includes('域名解析失败'));
  ok('网络不可达', describeNetError({ code: 'ENETUNREACH' }).includes('网络不可达'));
  ok('连接被拒', describeNetError({ code: 'ECONNREFUSED' }).includes('连接被拒绝'));
  ok('权限', describeNetError({ code: 'EPERM' }).includes('联网'));
  ok('未知码返回空', describeNetError({ code: 'SOMETHING_ELSE' }) === '');
  ok('小写也能匹配', describeNetError({ code: 'enotfound' }).includes('域名解析失败'));
  ok('无 code 不炸', describeNetError(new Error('x')) === '');
});

// ── C. 目标归一化 ──────────────────────────────────────────────────────────
await test('诊断：normalizeHost', async () => {
  ok('裸域名', normalizeHost('api.trae.cn') === 'api.trae.cn');
  ok('完整 URL', normalizeHost('https://api.trae.cn/a/b?c=1') === 'api.trae.cn');
  ok('带端口', normalizeHost('http://example.com:8080/x') === 'example.com');
  ok('空白', normalizeHost('   ') === '');
  ok('null', normalizeHost(null) === '');
  ok('默认目标 4 个（含 OAuth host）', DEFAULT_TARGETS.length === 4);
  ok('三个 TRAE 域名齐全', ['api.trae.cn', 'trae-api-cn.mchost.guru', 'api.trae.com.cn']
    .every((h) => DEFAULT_TARGETS.some((t) => t.host === h)));
});

// ── D. 分层结论 ────────────────────────────────────────────────────────────
await test('诊断：summarize 按卡住的层给结论', async () => {
  ok('全通过', summarize([{ ok: true, failedAt: null }]).includes('全部通过'));
  ok('DNS 层', summarize([{ ok: false, failedAt: 'dns', steps: {} }]).includes('域名解析失败'));
  ok('TCP 层', summarize([{ ok: false, failedAt: 'tcp', steps: {} }]).includes('连不上 443'));
  ok('TLS 层带错误码', summarize([{ ok: false, failedAt: 'tls', steps: { tls: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } } }]).includes('SELF_SIGNED_CERT_IN_CHAIN'));
  ok('HTTPS 层', summarize([{ ok: false, failedAt: 'https', host: 'a.cn', reason: 'HTTP 502', steps: {} }]).includes('HTTP 502'));
});

// ── E. 分步探测（注入 steps，不联网）────────────────────────────────────────
await test('诊断：全通过 → 每个目标四层都跑完', async () => {
  const r = await runNetworkDiagnose({ steps: allOk() });
  ok('总体 ok', r.ok === true);
  ok('目标数与 DEFAULT_TARGETS 一致', r.targets.length === DEFAULT_TARGETS.length);
  ok('四层齐全', Object.keys(r.targets[0].steps).join(',') === 'dns,tcp,tls,https');
  ok('都有 ca 信息', typeof r.ca.total === 'number');
  ok('summary 说全通过', r.summary.includes('全部通过'));
});
await test('诊断：DNS 挂了就不再往下跑', async () => {
  const r = await runNetworkDiagnose({ steps: allOk({
    dns: async () => ({ ok: false, code: 'ENOTFOUND', message: '域名解析失败：DNS 被污染或没有外网' })
  }) });
  ok('总体失败', r.ok === false);
  ok('卡在 dns', r.targets[0].failedAt === 'dns');
  ok('没跑 tcp', r.targets[0].steps.tcp === undefined);
  ok('原因带中文', r.targets[0].reason.includes('DNS'));
  ok('结论是 DNS', r.summary.includes('域名解析失败'));
});
await test('诊断：TLS 证书不受信任 → 明确报证书', async () => {
  const r = await runNetworkDiagnose({ steps: allOk({
    tls: async () => ({ ok: false, code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: '证书链校验失败', authorized: false })
  }) });
  ok('卡在 tls', r.targets[0].failedAt === 'tls');
  ok('原因含证书链', r.targets[0].reason.includes('证书链校验失败'));
  ok('结论含 TLS', r.summary.includes('TLS 证书校验失败'));
  ok('没跑 https', r.targets[0].steps.https === undefined);
});
await test('诊断：TLS 通但 HTTPS 失败', async () => {
  const r = await runNetworkDiagnose({ steps: allOk({
    https: async () => ({ ok: false, code: 'ECONNRESET', message: '连接被重置', status: 0 })
  }) });
  ok('卡在 https', r.targets[0].failedAt === 'https');
  ok('原因带连接被重置', r.targets[0].reason.includes('连接被重置'));
});
await test('诊断：自定义目标覆盖默认列表', async () => {
  let seen = [];
  const r = await runNetworkDiagnose({
    hosts: ['https://example.org/path', 'a.cn'],
    steps: allOk({ dns: async (h) => { seen.push(h); return { ok: true, addresses: ['1.1.1.1'] }; } })
  });
  ok('只有 2 个目标', r.targets.length === 2);
  ok('URL 提取出主机名', seen.includes('example.org'));
  ok('label 是自定义', r.targets[0].label === '自定义目标');
  ok('报告不含凭据字段', !JSON.stringify(r).includes('Bearer'));
});

// ── F. 端点 + 鉴权 ─────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-net-test-'));
let capturedHosts = null;
const fakeDiagnose = async ({ hosts }) => {
  capturedHosts = hosts;
  return { ok: true, at: Date.now(), ca: describeCa(), targets: [], summary: 'mock 全通过' };
};
const log = { log() {}, warn() {}, error() {}, info() {} };
const { server, uiToken, store } = createApp({ dataDir: dir, log, networkDiagnose: fakeDiagnose });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const uiHeaders = { 'x-ofm-ui-token': uiToken };

await test('端点：GET /api/network/diagnose', async () => {
  const r = await fetch(`${base}/api/network/diagnose`, { headers: uiHeaders });
  ok('200', r.status === 200);
  const j = await r.json();
  ok('返回 ok', j.ok === true);
  ok('带 summary', j.summary === 'mock 全通过');
  ok('带 ca', typeof j.ca.total === 'number');
});
await test('端点：没有 uiToken 就 401', async () => {
  const r = await fetch(`${base}/api/network/diagnose`);
  ok('401', r.status === 401);
});
await test('端点：?host= 透传', async () => {
  await fetch(`${base}/api/network/diagnose?host=a.cn&host=b.cn`, { headers: uiHeaders });
  ok('两个 host 都收到', Array.isArray(capturedHosts) && capturedHosts.join(',') === 'a.cn,b.cn');
});
await test('端点：/api/status 带 CA 概况', async () => {
  const r = await fetch(`${base}/api/status`, { headers: uiHeaders });
  const j = await r.json();
  ok('network.ca 存在', typeof j.network?.ca?.total === 'number');
  ok('不泄漏证书内容', !JSON.stringify(j.network).includes('BEGIN CERTIFICATE'));
});
await test('端点：兜底目录的 hint 带出真实原因且脱敏', async () => {
  const channel = {
    id: 'trae',
    requiresAccount: true,
    supported: true,
    lastModelWarning: '上游连接失败: unable to verify the first certificate（证书链校验失败）；Bearer SECRET_TOKEN_123',
    credential: async () => ({}),
    listModels: async () => [{ id: 'm1', fallback: true }],
    login: {}
  };
  const { server: s2, uiToken: t2, store: st2 } = createApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-net-hint-')),
    log,
    networkDiagnose: fakeDiagnose,
    registry: { list: () => [channel], get: () => channel }
  });
  st2.update((s) => { s.accounts = [{ id: 'a1', provider: 'trae', enabled: true, credentialRef: 'r1' }]; });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    const r = await fetch(`${b2}/api/models`, { headers: { 'x-ofm-ui-token': t2 } });
    const j = await r.json();
    ok('hint 含具体原因', j.hint.includes('证书链校验失败'));
    ok('hint 指向网络自检', j.hint.includes('网络自检'));
    ok('hint 不含 Bearer 明文', !j.hint.includes('SECRET_TOKEN_123'));
    ok('数据仍是兜底列表', j.data.length === 1 && j.data[0].fallback === true);
  } finally {
    await new Promise((r) => s2.close(r));
  }
});

await new Promise((r) => server.close(r));
fs.rmSync(dir, { recursive: true, force: true });

// ── G. 余额失败原因透传 ────────────────────────────────────────────────────
await test('余额：网络失败时把真实原因带出来', async () => {
  const credStore = {
    settings: { accounts: [{ id: 'a1', provider: 'trae', nickname: 'T', credentialRef: 'r1', enabled: true }], credits: {} },
    readCredential: () => ({ uid: 'u', machine_id: 'm', device_id: 'd' }),
    writeCredential() {},
    update() {}
  };
  const reg = { get: () => ({ credential: async () => credStore.readCredential() }) };
  const netErr = Object.assign(new Error('unable to verify the first certificate'), {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  });
  const fetcher = async () => { throw netErr; };
  const svc = createCreditsService({ store: credStore, registry: reg, fetcher, log });
  const r = await svc.balances('trae');
  const row = r.value.accounts[0];
  ok('balance 仍是 null（不假装 0）', row.balance === null);
  ok('error 带网络原因', String(row.error).includes('网络原因'));
  ok('error 带证书链提示', String(row.error).includes('证书链校验失败'));
});
await test('余额：成功时不追加网络原因', async () => {
  const credStore = {
    settings: { accounts: [{ id: 'a1', provider: 'trae', credentialRef: 'r1', enabled: true }], credits: {} },
    readCredential: () => ({}), writeCredential() {}, update() {}
  };
  const reg = { get: () => ({ credential: async () => ({}) }) };
  // 直接让 provider 之外短路：用一个会返回合法余额形状的假 fetcher 太重，
  // 这里只验证「没有网络异常时不会凭空加上网络原因」。
  const fetcher = async () => { throw new Error('业务形状不符'); };
  const svc = createCreditsService({ store: credStore, registry: reg, fetcher, log });
  const r = await svc.balances('trae');
  ok('没有凭空加网络原因', !String(r.value.accounts[0].error).includes('网络原因：证书'));
});

console.log(`\n通过 ${passed} 项断言`);
if (failures.length) {
  console.error(`失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
