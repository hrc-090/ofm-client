/**
 * 签到日志验收（M26）。
 *
 * 覆盖四层：脱敏 / 归一化 → 按天分片读写 → 自动签到逐渠道打点 → 管理接口。
 * 全部注入 mock，不依赖真实账号、不访问外网；HTTP 层用随机端口 + uiToken。
 * 运行：node test/checkin-log.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCheckinLog,
  sanitizeMessage,
  normalizeCheckinEntry,
  formatCheckinLogLine
} from '../src/checkin-log.js';
import { dayKey } from '../src/usage-store.js';
import { createAutoCheckin, DEFAULT_AUTO_CHECKIN } from '../src/credits/auto-checkin.js';
import { createApp } from '../src/server.js';

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

const T = Date.parse('2026-11-10T02:00:00Z'); // 本机 UTC+8 = 10:00
const DAY = 24 * 60 * 60 * 1000;
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const silent = { warn() {}, info() {}, error() {} };

const CLAIMED = {
  claimed: 1,
  totalCredit: 100,
  totalByUnit: { credit: 100, token: 0 },
  alreadyClaimed: 0,
  inactive: 0,
  failed: 0,
  coversToday: 1
};

// ─────────────── 1. 脱敏与字段归一化 ───────────────

await test('脱敏：Bearer / token= / 长串 / 截断 / 控制字符', async () => {
  const withBearer = sanitizeMessage('请求失败 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature');
  ok('Bearer 已打码', withBearer.includes('***') && !withBearer.includes('eyJhbGciOiJIUzI1NiJ9'));
  ok('Bearer 关键字保留', withBearer.includes('Bearer'));
  const withToken = sanitizeMessage('登录失败 token=abcdefghijklmnopqrstuvwxyz 请重试');
  ok('token= 已打码', withToken.includes('token=***') && !withToken.includes('abcdefghijklmnopqrstuvwxyz'));
  ok('超长疑似 token 打码', sanitizeMessage(`错误 ${'A'.repeat(80)}`).includes('***'));
  ok('截断到 240', sanitizeMessage('x'.repeat(500)).length <= 240);
  ok('换行与控制字符压平', !sanitizeMessage('第一行\n第二行\t第三行\r').match(/[\r\n\t\x00-\x1f]/));
  ok('空值不抛', sanitizeMessage(undefined) === '' && sanitizeMessage(null) === '');
  ok('非字符串也能收敛', typeof sanitizeMessage({ a: 1 }) === 'string');
});

await test('归一化：非法枚举回落、账号打码、counts 数字化', async () => {
  const e = normalizeCheckinEntry(
    {
      source: 'bogus', type: 'bogus', level: 'bogus',
      provider: 'trae', account: 'acc-secret-9876',
      message: 'Bearer abcdefghijklmnopqrstuvwxyz 失败',
      markedToday: false,
      counts: { claimed: '3', alreadyClaimed: null, failed: NaN, inactive: -5, skipped: 2 }
    },
    () => T
  );
  ok('source 回落', e.source === 'manual');
  ok('type 回落', e.type === 'run');
  ok('level 回落', e.level === 'info');
  ok('ts 用注入时钟', e.ts === T);
  ok('账号只留尾 4 位', e.account === 'trae#9876', e.account);
  ok('凭据不落日志', !e.message.includes('abcdefghijklmnopqrstuvwxyz'));
  ok('markedToday 布尔保留', e.markedToday === false);
  ok('counts 数字', e.counts.claimed === 3 && e.counts.failed === 0);
  ok('counts 负数归零', e.counts.inactive === 0 && e.counts.skipped === 2);
  const plain = normalizeCheckinEntry({ markedToday: 'yes', counts: 'x', account: '' }, () => T);
  ok('非布尔 markedToday 丢弃', !('markedToday' in plain));
  ok('非法 counts 丢弃', !('counts' in plain));
  ok('空账号不出现', !('account' in plain));
});

await test('纯文本行含来源 / 类型 / 结果 / 今日标记', async () => {
  const line = formatCheckinLogLine(
    normalizeCheckinEntry(
      {
        ts: T, source: 'auto', trigger: 'startup', type: 'run', level: 'ok',
        outcome: 'finished', markedToday: true, ms: 1234,
        message: '1 个账号领取成功', provider: 'trae'
      },
      () => T
    )
  );
  ok('含自动/启动', line.includes('[自动/启动]'));
  ok('含本轮', line.includes('[本轮]'));
  ok('含渠道', line.includes('[trae]'));
  ok('含结果', line.includes('结束：1 个账号领取成功'));
  ok('含已记入今日', line.includes('已记入今日'));
  ok('含耗时', line.includes('1234ms'));
  ok('未记入今日有说明', formatCheckinLogLine({ ts: T, source: 'auto', markedToday: false, message: 'x' }).includes('会重试'));
});

// ─────────────── 2. 按天分片存储 ───────────────

await test('存储：按天分片、倒序、limit、summary、text', async () => {
  const dir = tmp('ofm-checkin-log-');
  try {
    const log = createCheckinLog({ dir, log: silent, now: () => T });
    log.record({ ts: T, source: 'auto', type: 'run', level: 'info', outcome: 'started', message: '开始' });
    log.record({
      ts: T + 1000, source: 'auto', type: 'channel', level: 'ok', outcome: 'claimed',
      provider: 'trae', message: '1 个账号领取成功'
    });
    log.record({
      ts: T + 2000, source: 'auto', type: 'run', level: 'ok', outcome: 'finished',
      markedToday: true, counts: { claimed: 1 }, message: '完成'
    });
    // 下一条故意放到昨天，验证分片命名与倒序
    log.record({ ts: T - DAY, source: 'manual', type: 'account', level: 'error', outcome: 'failed', message: '昨天的失败' });
    log.flush();

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    ok('生成两个按天分片', files.length === 2, files.join(','));
    ok('文件名是 YYYY-MM-DD.jsonl', files.every((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)), files.join(','));
    ok('含今天分片', files.includes(`${dayKey(T)}.jsonl`));

    const all = await log.recent({ limit: 100 });
    ok('读到 4 条', all.length === 4, String(all.length));
    ok('倒序（最新在前）', all[0].ts === T + 2000 && all[3].ts === T - DAY);
    ok('limit 生效', (await log.recent({ limit: 2 })).length === 2);
    ok('limit 下限 1', (await log.recent({ limit: -9 })).length === 1);
    ok('level 保留', all[0].level === 'ok');
    ok('counts 保留', all[0].counts.claimed === 1);

    const s = await log.summary({ days: 7 });
    ok('summary 条目数', s.entries === 4, String(s.entries));
    ok('summary 轮次', s.runs === 1, String(s.runs));
    ok('summary 领取成功', s.claimed === 1);
    ok('summary 失败', s.failed === 1);
    ok('summary lastClaimAt', s.lastClaimAt === T + 1000);

    const text = await log.text({ limit: 100 });
    ok('报告标题', text.includes('OFM 签到日志'));
    ok('报告含今日统计', text.includes('领取成功 1'));
    ok('报告含明细行', text.includes('领取成功：1 个账号领取成功'));
    ok('报告倒序', text.indexOf('完成') < text.indexOf('昨天的失败'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('存储：clear / prune / 单日上限 / 写失败不抛', async () => {
  const dir = tmp('ofm-checkin-log-');
  try {
    const log = createCheckinLog({ dir, log: silent, now: () => T });
    log.record({ ts: T - 40 * DAY, source: 'auto', type: 'run', message: '过期' });
    log.record({ ts: T, source: 'auto', type: 'run', message: '今天' });
    log.flush();
    ok('prune 删掉 40 天前的整天分片', log.prune() === 1);
    ok('今天的分片还在', fs.readdirSync(dir).some((f) => f === `${dayKey(T)}.jsonl`));
    ok('clear 返回删除数', log.clear() >= 1);
    ok('clear 后无条目', (await log.recent({ limit: 10 })).length === 0);

    const small = createCheckinLog({ dir: path.join(dir, 'small'), log: silent, now: () => T, maxFileBytes: 50 });
    small.record({ ts: T, message: 'x'.repeat(120) });
    small.flush();
    ok('超上限不写盘', (await small.recent({ limit: 10 })).length === 0);
    ok('超上限计入 dropped', small.stats().dropped >= 1);

    // 父路径是普通文件时 mkdirSync 必失败：写日志不能把签到流程带崩
    const blocker = path.join(dir, 'blocked');
    fs.writeFileSync(blocker, 'not a dir');
    const broken = createCheckinLog({ dir: path.join(blocker, 'nested'), log: silent });
    broken.record({ message: '写入失败也不许抛' });
    broken.flush();
    ok('写失败不抛', broken.stats().dropped >= 1);
    ok('写失败后 recent 仍可调用', (await broken.recent({ limit: 5 })).length === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────── 3. 自动签到逐渠道打点 ───────────────

function fakeAutoStore(initial = {}) {
  let doc = { ...DEFAULT_AUTO_CHECKIN, ...initial };
  return {
    load: () => ({ ...doc, channels: [...doc.channels] }),
    save: (d) => { doc = { ...d }; return doc; },
    doc: () => doc
  };
}
function makeAuto(credits, events, extra = {}) {
  return createAutoCheckin({
    credits,
    store: fakeAutoStore(),
    now: () => T,
    warn: () => {},
    record: (e) => events.push(e),
    ...extra
  });
}

await test('自动签到：成功轮记录启动 / 逐渠道 / 记入今日', async () => {
  const events = [];
  const credits = {
    providersWithAccounts: () => ['trae', 'zcode', 'cline'],
    claim: async (p) => {
      if (p === 'trae') return { ok: true, value: { results: [], summary: CLAIMED } };
      if (p === 'cline') return { ok: false, error: 'cline 不支持每日签到：该渠道没有每日签到' };
      return { ok: false, error: 'unexpected' };
    }
  };
  const auto = makeAuto(credits, events);
  await auto.runIfDue('startup');
  ok('有开始事件', events.some((e) => e.outcome === 'started' && e.trigger === 'startup' && e.source === 'auto'));
  ok('runId 全轮一致', new Set(events.map((e) => e.runId)).size === 1);
  ok('trae 领取成功', events.some((e) => e.type === 'channel' && e.provider === 'trae' && e.outcome === 'claimed'));
  ok('zcode 排除表跳过', events.some((e) => e.provider === 'zcode' && e.outcome === 'excluded' && e.message.includes('需手动')));
  ok('cline 无签到接口', events.some((e) => e.provider === 'cline' && e.outcome === 'skipped'));
  ok('账号池数量入日志', events.some((e) => e.message.includes('3 个渠道')));
  const finish = events.find((e) => e.outcome === 'finished');
  ok('有收尾事件', Boolean(finish));
  ok('记入今日', finish.markedToday === true);
  ok('counts 成功数', finish.counts.claimed === 1);
  ok('counts 跳过数', finish.counts.skipped === 2);
  ok('带耗时', typeof finish.ms === 'number');
  ok('状态已落盘', auto.state().ranToday === true);
});

await test('自动签到：失败轮记 error 且不写 lastDate', async () => {
  const events = [];
  const credits = {
    providersWithAccounts: () => ['trae'],
    claim: async () => { throw new Error('ECONNRESET 连接被重置'); }
  };
  const auto = makeAuto(credits, events);
  await auto.runIfDue('tick');
  ok('渠道 error 行', events.some((e) => e.type === 'channel' && e.level === 'error' && e.message.includes('ECONNRESET')));
  const finish = events.find((e) => e.outcome === 'finished');
  ok('收尾标记未记入今日', finish?.markedToday === false);
  ok('说明稍后重试', finish.message.includes('重试'));
  ok('触发来源是巡检', finish.trigger === 'tick');
  ok('不写 lastDate', auto.state().ranToday === false);
  ok('失败仍算一轮', events.filter((e) => e.outcome === 'finished').length === 1);
});

await test('自动签到：账号池读失败 / 无账号 / 无可领都留痕', async () => {
  const pool = [];
  const credits = {
    providersWithAccounts: () => { throw new Error('settings.json 损坏'); },
    claim: async () => ({ ok: true, value: { results: [], summary: CLAIMED } })
  };
  const auto = makeAuto(credits, pool);
  await auto.runIfDue('startup');
  ok('账号池异常记 error', pool.some((e) => e.level === 'error' && e.message.includes('settings.json 损坏')));
  ok('账号池异常不记今日', pool.some((e) => e.markedToday === false));
  ok('账号池异常不写盘', auto.state().lastDate === '');

  const noAccounts = [];
  const auto2 = makeAuto({ providersWithAccounts: () => [], claim: async () => ({ ok: true }) }, noAccounts);
  await auto2.runIfDue('startup');
  ok('无账号也记一轮', noAccounts.some((e) => e.outcome === 'finished' && e.markedToday === false));
  ok('无账号说明', noAccounts.some((e) => e.message.includes('无账号')));

  const noClaim = [];
  const auto3 = makeAuto(
    { providersWithAccounts: () => ['trae'], claim: async () => ({ ok: true, value: { results: [] } }) },
    noClaim
  );
  await auto3.runIfDue('toggle');
  ok('无可领记 empty', noClaim.some((e) => e.outcome === 'empty' && e.level === 'warn'));
  ok('开关触发来源', noClaim[0].trigger === 'toggle');
});

// ─────────────── 4. 管理接口 ───────────────

await test('管理接口：claim / balances 留痕、text 报告、鉴权、清空', async () => {
  const dir = tmp('ofm-checkin-api-');
  // 注入 registry：credential 恒返回 null，保证所有签到路径都不发真实网络请求
  const registry = {
    list: () => [],
    get: (id) => ({ id, supported: true, loginMode: 'none', credential: async () => null })
  };
  const instance = createApp({ dataDir: dir, log: silent, registry });
  await new Promise((r) => instance.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const ui = { 'x-ofm-ui-token': instance.uiToken, 'content-type': 'application/json' };
  const getLog = async () => {
    const r = await fetch(`${base}/api/checkin/log?limit=100`, { headers: ui });
    return (await r.json()).value;
  };
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: ui, body: JSON.stringify(body) });

  try {
    const empty = await getLog();
    ok('初始日志为空', Array.isArray(empty.entries) && empty.entries.length === 0);
    ok('初始 summary 存在', empty.summary && empty.summary.runs === 0);

    const noCap = await post('/api/checkin/claim', { provider: 'cline' });
    const noCapJson = await noCap.json();
    ok('无签到能力返回 ok:false', noCapJson.ok === false);
    const afterFail = await getLog();
    ok('手动失败记 error 行', afterFail.entries.some((e) => e.level === 'error' && e.message.includes('不支持每日签到')));
    ok('来源标手动/App', afterFail.entries.some((e) => e.source === 'manual' && e.trigger === 'app'));
    ok('不记完整凭据（日志里无 token 字样）', !JSON.stringify(afterFail.entries).includes('access_token'));

    // 加一个凭据解析失败的 TRAE 账号：逐账号 failed + 余额 null，全程不发请求
    instance.store.settings.accounts.push({
      id: 'acc-secret-9876', provider: 'trae', nickname: '我的号',
      credentialRef: 'missing', enabled: true
    });
    const claim = await post('/api/checkin/claim', { provider: 'trae' });
    const claimJson = await claim.json();
    ok('逐账号失败仍返回 ok:true', claimJson.ok === true);
    ok('汇总里失败数是 1', claimJson.value.summary.failed === 1);
    const afterClaim = await getLog();
    ok('逐账号留痕', afterClaim.entries.some((e) => e.type === 'account' && e.level === 'error' && e.outcome === 'failed'));
    ok('账号只留尾 4 位', afterClaim.entries.some((e) => e.account === 'trae#9876'));
    ok('不落完整账号 id', !JSON.stringify(afterClaim.entries).includes('acc-secret-9876'));
    ok('失败原因保留', afterClaim.entries.some((e) => e.message.includes('凭据未配置')));
    ok('本轮收尾 counts', afterClaim.entries.some((e) => e.outcome === 'finished' && e.counts.failed === 1));

    const bal = await post('/api/checkin/balances', { provider: 'trae' });
    const balJson = await bal.json();
    ok('余额接口可用', balJson.ok === true);
    const afterBal = await getLog();
    ok('余额失败记 query 行', afterBal.entries.some((e) => e.type === 'query' && e.message.includes('余额查询失败')));
    ok('今日统计有失败数', afterBal.summary.failed >= 2);

    const textRes = await fetch(`${base}/api/checkin/log?limit=200&format=text`, { headers: ui });
    const text = await textRes.text();
    ok('text 返回 text/plain', textRes.headers.get('content-type').includes('text/plain'));
    ok('text 带报告头', text.includes('OFM 签到日志'));
    ok('text 带今日统计', text.includes('今日：轮次'));
    ok('text 带手动来源', text.includes('[手动/App]'));
    ok('text 带失败原因', text.includes('凭据未配置'));
    ok('text 不含完整账号 id', !text.includes('acc-secret-9876'));

    const noAuth = await fetch(`${base}/api/checkin/log?limit=10`);
    ok('无 uiToken 读日志被拒', noAuth.status === 401);

    const cleared = await fetch(`${base}/api/checkin/log`, { method: 'DELETE', headers: ui });
    const clearedJson = await cleared.json();
    ok('清空返回 removed', clearedJson.ok === true && clearedJson.removed >= 1);
    ok('清空后条目为空', (await getLog()).entries.length === 0);
    ok('清空不影响账号', instance.store.settings.accounts.length === 1);
  } finally {
    await new Promise((r) => instance.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n通过 ${passed} 项断言，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
