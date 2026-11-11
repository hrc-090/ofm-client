/**
 * 用量记录验收：只存统计、不存正文、写失败不影响请求。
 * 纯本地，不联网、不需要账号。运行：node test/usage.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createUsageStore, dayKey, classifyUa, maskAccount } from '../src/usage-store.js';

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-usage-test-'));
const silent = { warn() {} };
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime(); // 本地时区正午，避开日界
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const newDir = () => path.join(TMP, `d${seq += 1}`);
const readAll = (dir) => {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
};

/* ───────── 1. 基础工具 ───────── */

await test('dayKey / UA 归类 / 账号脱敏', async () => {
  ok('dayKey 形如 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dayKey(NOW)), dayKey(NOW));
  ok('同一天内稳定', dayKey(NOW) === dayKey(NOW + 3600_000));
  ok('跨天不同', dayKey(NOW) !== dayKey(NOW + DAY));

  ok('claude-code', classifyUa('claude-cli/2.0.1') === 'claude-code');
  ok('codex', classifyUa('codex_cli_rs/0.9') === 'codex');
  ok('anthropic-sdk', classifyUa('Anthropic/Python 0.40') === 'anthropic-sdk');
  ok('openai-sdk', classifyUa('OpenAI/Python 1.55') === 'openai-sdk');
  ok('curl', classifyUa('curl/8.5.0') === 'curl');
  ok('ofm-app', classifyUa('okhttp/4.12.0 ofm') === 'ofm-app');
  ok('空 UA 归 other', classifyUa('') === 'other');
  ok('未知归 other', classifyUa('Mozilla/5.0') === 'other');

  ok('账号只留尾 4 位', maskAccount('trae', 'trae-57cdd3dd') === 'trae#d3dd');
  ok('不落完整账号', !maskAccount('trae', 'trae-57cdd3dd').includes('57cdd3'));
  ok('空账号返回空串', maskAccount('trae', '') === '');
});

/* ───────── 2. 落盘格式 ───────── */

await test('按天分片、一行一条、权限 0600、不存正文', async () => {
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({
    ts: NOW,
    path: '/v1/chat/completions',
    ok: true,
    status: 200,
    provider: 'trae',
    model: 'Doubao-Seed-Code',
    account: 'trae-57cdd3dd',
    ms: 300,
    firstMs: 120,
    deltas: 12,
    stream: true,
    inTok: 100,
    outTok: 40,
    cachedTok: 60,
    ua: 'claude-cli/2.0',
    // 故意塞正文：必须被丢弃
    text: '这是不该落盘的正文',
    prompt: '也不该落盘'
  });
  s.flush();

  const files = fs.readdirSync(dir);
  ok('只生成当天分片', files.length === 1 && files[0] === `${dayKey(NOW)}.jsonl`, files.join(','));
  ok('文件权限 0600', (fs.statSync(path.join(dir, files[0])).mode & 0o777) === 0o600);

  const rows = readAll(dir);
  ok('一行一条', rows.length === 1, String(rows.length));
  ok('账号已脱敏', rows[0].account === 'trae#d3dd', rows[0].account);
  ok('正文不落盘', !JSON.stringify(rows[0]).includes('不该落盘'));
  ok('首片段耗时保留', rows[0].firstMs === 120);
  ok('UA 已枚举化', rows[0].ua === 'claude-code');
});

/* ───────── 3. 聚合口径 ───────── */

await test('summary：成功率 / 缓存命中 / 按天 / 模型 / 渠道 / UA', async () => {
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({ ts: NOW - DAY, ok: true, provider: 'trae', model: 'A', inTok: 100, outTok: 10, cachedTok: 50, ms: 100, firstMs: 50, ua: 'claude-cli' });
  s.record({ ts: NOW, ok: true, provider: 'trae', model: 'A', inTok: 200, outTok: 20, cachedTok: 100, ms: 300, firstMs: 150, ua: 'curl/8' });
  s.record({ ts: NOW, ok: false, status: 502, code: 'EMPTY_REPLY', provider: 'qoder', model: 'B', inTok: 0, outTok: 0, ua: 'codex_cli' });
  s.flush();

  const sum = await s.summary({ days: 7 });
  ok('请求数 3', sum.totals.requests === 3, String(sum.totals.requests));
  ok('成功 2 / 失败 1', sum.totals.ok === 2 && sum.totals.failed === 1);
  ok('成功率 66.7%', sum.totals.successRate === 66.7, String(sum.totals.successRate));
  ok('输入 token 汇总 300', sum.totals.inTok === 300);
  ok('缓存命中率 50%', sum.totals.cacheHitRate === 50, String(sum.totals.cacheHitRate));
  ok('平均首片段 100ms', sum.totals.avgFirstMs === 100, String(sum.totals.avgFirstMs));
  ok('按天固定 7 个桶', sum.byDay.length === 7);
  ok('有数据的天 2 个', sum.byDay.filter((d) => d.requests > 0).length === 2);
  ok('模型排行按请求数', sum.byModel[0].model === 'trae/A' && sum.byModel[0].requests === 2);
  ok('模型平均首字', sum.byModel[0].avgFirstMs === 100);
  ok('渠道分布', sum.byProvider.find((p) => p.provider === 'qoder')?.requests === 1);
  ok('UA 分布', sum.byUa.find((u) => u.ua === 'codex')?.count === 1);

  const oneDay = await s.summary({ days: 1 });
  ok('窗口外不计入（1 天 = 2 条）', oneDay.totals.requests === 2, String(oneDay.totals.requests));
});

await test('半行容错：进程被杀留下的残行不影响聚合', async () => {
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({ ts: NOW, ok: true, provider: 'trae', model: 'A', inTok: 1 });
  s.flush();
  fs.appendFileSync(path.join(dir, `${dayKey(NOW)}.jsonl`), '{"broken":\n');
  const sum = await s.summary({ days: 7 });
  ok('残行被跳过', sum.totals.requests === 1, String(sum.totals.requests));
});

/* ───────── 4. 容量与保留 ───────── */

await test('单日超限停写，不把存储写满', async () => {
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW, maxFileBytes: 260 });
  s.record({ ts: NOW, ok: true, provider: 'trae', model: 'A', ua: 'curl' });
  s.flush();
  for (let i = 0; i < 5; i += 1) {
    s.record({ ts: NOW, ok: true, provider: 'trae', model: 'A', ua: 'curl' });
    s.flush();
  }
  ok('已丢弃后续写入', s.stats().dropped >= 1, String(s.stats().dropped));
  ok('文件没有继续膨胀', readAll(dir).length === 1, String(readAll(dir).length));
});

await test('prune 只删过期整天分片', async () => {
  const dir = newDir();
  fs.mkdirSync(dir, { recursive: true });
  // 显式给 30 天保留期，测的是 prune 逻辑本身；
  // 生产默认已提到 120 天（17 周热力图需要），另由 summary.days=119 验收。
  const old = new Date(NOW);
  old.setDate(old.getDate() - 40);
  const fresh = new Date(NOW);
  fresh.setDate(fresh.getDate() - 3);
  fs.writeFileSync(path.join(dir, `${dayKey(old.getTime())}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dir, `${dayKey(fresh.getTime())}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');

  const s = createUsageStore({ dir, log: silent, now: () => NOW, retentionDays: 30 });
  ok('删掉 1 个过期分片', s.prune() === 1);
  ok('保留最近分片', fs.existsSync(path.join(dir, `${dayKey(fresh.getTime())}.jsonl`)));
  ok('不碰非分片文件', fs.existsSync(path.join(dir, 'notes.txt')));
});

await test('clear 清空记录并返回删除数', async () => {
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });
  s.record({ ts: NOW, ok: true, provider: 'trae', model: 'A' });
  s.flush();
  ok('删除 1 个文件', s.clear() === 1);
  ok('清空后请求数为 0', (await s.summary({ days: 7 })).totals.requests === 0);
});

/* ───────── 5. 请求挂钩 ───────── */

await test('attach：只记录对话 POST，finish 时补状态与首字耗时', async () => {
  const dir = newDir();
  const s = createUsageStore({ dir, log: silent, now: () => NOW });

  ok('GET 不记录', s.attach({ method: 'GET', headers: {} }, new EventEmitter(), '/v1/chat/completions') === null);
  ok('管理接口不记录', s.attach({ method: 'POST', headers: {} }, new EventEmitter(), '/api/models') === null);

  const res = new EventEmitter();
  res.statusCode = 200;
  const rec = s.attach({ method: 'POST', headers: { 'user-agent': 'curl/8.5' } }, res, '/v1/chat/completions');
  ok('对话 POST 返回 rec', Boolean(rec));
  ok('rec 挂到 res 上供 handler 填写', res.ofmUsage === rec);

  rec.provider = 'trae';
  rec.model = 'trae/Doubao-Seed-Code';
  rec.account = 'trae-57cdd3dd';
  rec.inTok = 10;
  rec.firstAt = NOW + 120;
  res.emit('finish');
  s.flush();

  const [row] = await s.recent({ limit: 5 });
  ok('finish 后落盘', Boolean(row));
  ok('状态码正确', row.status === 200 && row.ok === true);
  ok('首片段耗时 = firstAt - ts', row.firstMs === 120, String(row.firstMs));
  ok('账号脱敏', row.account === 'trae#d3dd');
  ok('UA 归类', row.ua === 'curl');
});

await test('写盘失败只记 warn，不抛异常', async () => {
  // 拿一个「已存在的普通文件」当父目录：mkdir 必然 ENOTDIR，立即失败。
  // 不要用 /proc 之类路径 —— 某些内核上 recursive mkdir 会长时间阻塞。
  const blocker = path.join(TMP, 'blocker-file');
  fs.writeFileSync(blocker, 'x');
  const s = createUsageStore({ dir: path.join(blocker, 'usage'), log: silent, now: () => NOW });
  s.record({ ts: NOW, ok: true, provider: 'trae', model: 'A' });
  s.flush();
  ok('写失败不抛', true);
  ok('计入 dropped', s.stats().dropped >= 1, String(s.stats().dropped));
});

/* ───────── 汇总 ───────── */

fs.rmSync(TMP, { recursive: true, force: true });
console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/usage.mjs 通过 ${passed} 项断言`);
