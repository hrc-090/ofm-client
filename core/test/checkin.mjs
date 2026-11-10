/**
 * 签到 / 领取积分验收（说明书 §6 的 14 条）。
 *
 * 全部用 mockFetcher 注入，不依赖真实账号、不访问外网；
 * 时钟、网络、状态文档均可注入，便于精确构造 Qoder 09:30 / 跨天 / 断网 / 3012 等场景。
 * 运行：node test/checkin.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockFetcher } from '../src/credits/fetcher.js';
import { createCreditsService } from '../src/credits/index.js';
import {
  createAutoCheckin,
  createAutoCheckinStore,
  sanitizeAutoCheckin
} from '../src/credits/auto-checkin.js';
import { capabilityOf, listCapabilities, isAutoCheckinExcluded } from '../src/credits/capability.js';
import { formatClaimGains, formatUnitAmount, formatTokenAmount } from '../src/credits/format.js';
import { computeClaimSummary, shouldMarkToday, describeChannel } from '../src/credits/model.js';
import { expandClaimOutcome } from '../src/credits/collect.js';
import { parseMinimaxSigninPanel, panelToCheckinStatus } from '../src/credits/providers/minimax.js';
import { parseZcodeBusinessCode, mentionsUnusualActivity } from '../src/credits/providers/zcode.js';
import { parseClineBalanceResponse } from '../src/credits/providers/cline.js';
import { parseGeminiQuotaWindows } from '../src/credits/providers/gemini.js';

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

/** 造一个最小 store/registry，让 service 能按 credentialRef 读到假凭据。 */
function makeService(accounts, creds, fetcher, now, extra = {}) {
  const store = {
    settings: { accounts, credits: {} },
    readCredential: (ref) => creds[ref] ?? null,
    writeCredential: () => {},
    update: () => {}
  };
  const registry = {
    get: () => ({ credential: async (s, a) => s.readCredential(a.credentialRef) })
  };
  return createCreditsService({ store, registry, fetcher, now, log: { warn() {} }, ...extra });
}
function acc(provider, id = 'a1', ref = 'r1') {
  return { id, provider, nickname: `${provider}-账号`, credentialRef: ref, enabled: true };
}
const CRED = { access_token: 'test-token', uid: 'uid-1' };

/** 记录所有请求 URL 的 mockFetcher。 */
function recorder(handler) {
  const calls = [];
  const fetcher = mockFetcher(async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fetcher, calls };
}

const UTC8_0930 = Date.parse('2026-11-08T01:30:00Z'); // = 09:30 UTC+8
const UTC8_1200 = Date.parse('2026-11-08T04:00:00Z'); // = 12:00 UTC+8

// ─────────────── 单元：模型 / 格式化 / 能力表 ───────────────

await test('14) 单位隔离：ZCode token + 积分不得跨单位相加', async () => {
  const gains = formatClaimGains({ token: 100_000_000, credit: 100 });
  ok('汇总文案', gains === '+100.00MToken, +100积分', gains);
  ok('不含 100000100 积分', !String(gains).includes('100000100'));
  const s = computeClaimSummary([
    { kind: 'claimed', credit: 100_000_000, unit: 'token' },
    { kind: 'claimed', credit: 100 }
  ]);
  ok('totalByUnit.token', s.totalByUnit.token === 100_000_000);
  ok('totalByUnit.credit', s.totalByUnit.credit === 100);
  ok('两个键恒存在', 'token' in s.totalByUnit && 'credit' in s.totalByUnit);
  ok('两个键恒存在（空）', JSON.stringify(computeClaimSummary([]).totalByUnit) === '{"token":0,"credit":0}');
  ok('token 压缩', formatTokenAmount(100_000_000) === '100.00M');
  ok('积分不压缩', formatUnitAmount(123456.78, 'credit') === '123456.78积分');
});

await test('模型：coversToday / shouldMarkToday / describeChannel', async () => {
  ok('coversToday:false 不计入', computeClaimSummary([{ kind: 'claimed', credit: 100, coversToday: false }]).coversToday === 0);
  ok('shouldMarkToday 只认 coversToday', shouldMarkToday({ coversToday: 0, claimed: 5, alreadyClaimed: 5 }) === false);
  ok('shouldMarkToday 正数', shouldMarkToday({ coversToday: 1 }) === true);
  const text = describeChannel({ claimed: 1, totalCredit: 100, totalByUnit: { credit: 100, token: 0 }, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0 });
  ok('刷新前标注非今日轮次', text.includes('非今日轮次'), text);
  ok('刷新前不写死「今天已领」', !text.includes('今天已领'));
});

await test('能力表：raccoon 是新手任务，cline/gemini 无每日签到，zcode 排除自动', async () => {
  ok('raccoon 无每日签到', capabilityOf('raccoon').dailyCheckin === false);
  ok('raccoon 有新手任务', capabilityOf('raccoon').onboardingTasks === true);
  ok('cline 无签到', capabilityOf('cline').dailyCheckin === false);
  ok('gemini quotaOnly', capabilityOf('gemini').quotaOnly === true);
  ok('zcode 自动排除', isAutoCheckinExcluded('zcode') === true);
  ok('trae 不排除', isAutoCheckinExcluded('trae') === false);
  ok('能力表含全部渠道', listCapabilities().length >= 10);
});

await test('Qoder Pluggable：手工配置后带 machine 头，未配置时不带（且读最新 settings）', async () => {
  const store = {
    settings: { accounts: [acc('qoder')], credits: {} },
    readCredential: () => CRED,
    writeCredential() {},
    update() {}
  };
  const { fetcher, calls } = recorder((url) =>
    url.includes('/campaigns') ? { json: { campaigns: [] } } : { json: { qoderUsage: {} } }
  );
  const svc = createCreditsService({
    store,
    registry: { get: () => ({ credential: async () => CRED }) },
    fetcher,
    now: () => UTC8_1200,
    log: { warn() {} }
  });
  await svc.status('qoder');
  const first = calls.find((c) => c.url.includes('/campaigns'));
  ok('未配置时不带 MachineToken', first?.init.headers['Cosy-MachineToken'] === undefined);
  ok('Cosy-ClientType 恒为 10', first?.init.headers['Cosy-ClientType'] === '10');

  // 模拟 store.update() 换掉整个 settings 对象：provider 必须读到新值
  store.settings = { ...store.settings, credits: { qoderMachine: { token: 'mt', type: 'ty' } } };
  await svc.status('qoder');
  const second = calls.filter((c) => c.url.includes('/campaigns')).pop();
  ok('配置后带 MachineToken', second?.init.headers['Cosy-MachineToken'] === 'mt');
  ok('配置后带 MachineType', second?.init.headers['Cosy-MachineType'] === 'ty');
});

await test('状态文档：enabled !== false、dismissedRunAt、脏数据回落', async () => {
  ok('默认打开', sanitizeAutoCheckin({}).enabled === true);
  ok('显式 false 才关闭', sanitizeAutoCheckin({ enabled: false }).enabled === false);
  ok('字符串 "false" 按打开', sanitizeAutoCheckin({ enabled: 'false' }).enabled === true);
  ok('0 按打开', sanitizeAutoCheckin({ enabled: 0 }).enabled === true);
  ok('非法日期清空', sanitizeAutoCheckin({ lastDate: 'xxx' }).lastDate === '');
  ok('非对象回落', sanitizeAutoCheckin(null).enabled === true);
});

// ─────────────── 1) 状态查询 ───────────────

await test('1) TRAE / Qoder / MiniMax 状态查询的 todayCheckedIn 与实际一致', async () => {
  // TRAE：checked_in:true
  {
    const { fetcher } = recorder(() => ({ json: { code: 0, checked_in: true, enable: true, credits: 150 } }));
    const svc = makeService([acc('trae')], { r1: CRED }, fetcher);
    const r = await svc.status('trae');
    ok('TRAE ok', r.ok === true);
    ok('TRAE todayCheckedIn', r.value.accounts[0].status.todayCheckedIn === true);
    ok('TRAE dailyCredit', r.value.accounts[0].status.dailyCredit === 150);
  }
  // Qoder：刷新后（12:00 UTC+8）存在 CLAIMED 且无可领 → 今天已领
  {
    const { fetcher } = recorder((url) =>
      url.includes('/campaigns')
        ? { json: { campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { amount: 100 } }] } }
        : { json: { qoderUsage: { addOnQuota: { remaining: 100 } } } }
    );
    const svc = makeService([acc('qoder')], { r1: CRED }, fetcher, () => UTC8_1200);
    const r = await svc.status('qoder');
    ok('Qoder 刷新后 todayCheckedIn', r.value.accounts[0].status.todayCheckedIn === true);
  }
  // MiniMax：is_today && status===3
  {
    const days = Array.from({ length: 7 }, (_, i) => ({
      day_no: i + 1, points: 800, bonus_points: 400, is_today: i === 0, status: i === 0 ? 3 : 1
    }));
    const { fetcher } = recorder(() => ({ json: { base_resp: { status_code: 0 }, data: { scene: 1, days } } }));
    const svc = makeService([acc('minimax')], { r1: CRED }, fetcher);
    const r = await svc.status('minimax');
    ok('MiniMax todayCheckedIn', r.value.accounts[0].status.todayCheckedIn === true);
  }
});

// ─────────────── 2) 连续两次一键签到 ───────────────

await test('2) 连续两次签到，第二次必须是 already-claimed（TRAE/Loomy/MiniMax/Qoder/LobsterAI/ZCode/Raccoon）', async () => {
  // TRAE：第一次真领，第二次靠状态预检拦下
  {
    let claimed = false;
    let claimCalls = 0;
    const { fetcher, calls } = recorder((url) => {
      if (url.includes('/claim')) {
        claimCalls += 1;
        claimed = true;
        return { json: { code: 0, message: 'success' } };
      }
      return { json: { code: 0, checked_in: claimed, enable: true, credits: 150 } };
    });
    const svc = makeService([acc('trae')], { r1: CRED }, fetcher);
    const first = await svc.claim('trae');
    const second = await svc.claim('trae');
    ok('TRAE 首次 claimed', first.value.results[0].outcome.kind === 'claimed');
    ok('TRAE 二次 already-claimed', second.value.results[0].outcome.kind === 'already-claimed');
    ok('TRAE 二次不发 claim 请求', claimCalls === 1, `claimCalls=${claimCalls}`);
  }
  // Loomy：alreadyProcessed
  {
    let n = 0;
    const { fetcher } = recorder(() => {
      n += 1;
      return n === 1
        ? { json: { code: '000000', data: { dailyQuota: 5000, dailyConsumed: 0 } } }
        : { json: { code: '000000', data: { alreadyProcessed: true, dailyQuota: 5000, dailyBalance: 4992 } } };
    });
    const svc = makeService([acc('loomy')], { r1: CRED }, fetcher);
    ok('Loomy 首次 claimed', (await svc.claim('loomy')).value.results[0].outcome.kind === 'claimed');
    ok('Loomy 二次 already-claimed', (await svc.claim('loomy')).value.results[0].outcome.kind === 'already-claimed');
  }
  // MiniMax：claim_result 1 → 2（⚠️ 按端点计数：状态预检也会发一次请求）
  {
    let claimCalls = 0;
    const { fetcher } = recorder((url) => {
      if (url.includes('/signin/claim')) {
        claimCalls += 1;
        return { json: { base_resp: { status_code: 0 }, data: { claim_result: claimCalls === 1 ? 1 : 2, points: 800 } } };
      }
      // status 端点返回不含合法面板的响应 → 预检落到 null，继续领取
      return { json: { base_resp: { status_code: 0 }, data: {} } };
    });
    const svc = makeService([acc('minimax')], { r1: CRED }, fetcher);
    ok('MiniMax 首次 claimed', (await svc.claim('minimax')).value.results[0].outcome.kind === 'claimed');
    ok('MiniMax 二次 already-claimed', (await svc.claim('minimax')).value.results[0].outcome.kind === 'already-claimed');
  }
  // Qoder：replayed:true（幂等判据是响应体，不是 HTTP 状态）
  {
    const { fetcher } = recorder((url) =>
      url.includes('/campaigns') && !url.endsWith('/claim')
        ? { json: { campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } }] } }
        : { json: { replayed: true } }
    );
    const svc = makeService([acc('qoder')], { r1: CRED }, fetcher, () => UTC8_1200);
    ok('Qoder replayed → already-claimed', (await svc.claim('qoder')).value.results[0].outcome.kind === 'already-claimed');
  }
  // LobsterAI：claimedToday
  {
    const { fetcher } = recorder((url) => {
      if (url.includes('/slot')) return { json: { code: 0, data: { slotState: 'available', activity: { activityCode: 'act', configRevision: 3 } } } };
      if (url.includes('/context')) return { json: { code: 0, data: { state: { claimedToday: true }, actions: ['check_in'] } } };
      return { json: { code: 0, data: {} } };
    });
    const svc = makeService([acc('lobsterai')], { r1: CRED }, fetcher);
    ok('LobsterAI 已领', (await svc.claim('lobsterai')).value.results[0].outcome.kind === 'already-claimed');
  }
  // ZCode：1003 幂等
  {
    const { fetcher } = recorder((url) => {
      if (url.includes('/preview')) return { json: { code: 0, data: { plans: [{ plan_id: 'p1', priority: 1, entitlements: [{ grant_units: 100000000, unit_type: 'token' }] }] } } };
      if (url.includes('/claim')) return { json: { code: '1003' } };
      return { json: { code: 0, data: {} } };
    });
    const svc = makeService(
      [acc('zcode')],
      { r1: { ...CRED, zcode_jwt: 'j', device_mid: 'd' } },
      fetcher,
      undefined,
      { mintCaptcha: async () => ({ param: 'one-time', region: 'cn' }) }
    );
    const r = await svc.claim('zcode');
    ok('ZCode 1003 → already-claimed', r.value.results[0].outcome.kind === 'already-claimed');
  }
  // Raccoon：granted:false
  {
    const { fetcher } = recorder(() => ({ json: { code: 0, data: { granted: false } } }));
    const svc = makeService([acc('raccoon')], { r1: { ...CRED, office_identity: 'org' } }, fetcher);
    ok('Raccoon granted:false → already-claimed', (await svc.claim('raccoon')).value.results[0].outcome.kind === 'already-claimed');
  }
});

// ─────────────── 3) Qoder 09:30 ───────────────

let qoder0930Summary;
await test('3) Qoder UTC+8 09:30 返回「尚未刷新」而不是「今天已领取」，且不记 lastDate', async () => {
  const { fetcher } = recorder((url) =>
    url.includes('/campaigns')
      ? { json: { campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { amount: 100 } }] } }
      : { json: { qoderUsage: { addOnQuota: { remaining: 100 } } } }
  );
  const svc = makeService([acc('qoder')], { r1: CRED }, fetcher, () => UTC8_0930);
  const st = await svc.status('qoder');
  ok('刷新前 todayCheckedIn:false', st.value.accounts[0].status.todayCheckedIn === false);
  const r = await svc.claim('qoder');
  const o = r.value.results[0].outcome;
  ok('不是 already-claimed', o.kind !== 'already-claimed', o.kind);
  ok('文案是「尚未刷新」', String(o.message).includes('尚未刷新'), o.message);
  ok('coversToday:false', o.coversToday === false);
  qoder0930Summary = r.value.summary;

  // 该轮不得记 lastDate
  const mem = { doc: sanitizeAutoCheckin({}) };
  const store = { load: () => ({ ...mem.doc }), save: (d) => { mem.doc = { ...d }; } };
  const auto = createAutoCheckin({
    credits: { providersWithAccounts: () => ['qoder'], claim: async () => r },
    store,
    now: () => UTC8_0930,
    delayMs: 0,
    tickMs: 0,
    warn() {}
  });
  await auto.runIfDue();
  ok('未记 lastDate', mem.doc.lastDate === '');
  ok('state.ranToday false', auto.state().ranToday === false);
});

// ─────────────── 4) 5) TRAE 补查与预检 ───────────────

await test('4) TRAE 领取成功后 credit 不是 0（来自补查 status.credits）', async () => {
  let claimed = false;
  const { fetcher } = recorder((url) => {
    if (url.includes('/claim')) { claimed = true; return { json: { code: 0, message: 'success' } }; }
    return { json: { code: 0, checked_in: claimed, enable: true, credits: 150 } };
  });
  const svc = makeService([acc('trae')], { r1: CRED }, fetcher);
  const r = await svc.claim('trae');
  ok('credit === 150', r.value.results[0].outcome.credit === 150, JSON.stringify(r.value.results[0].outcome));
  ok('summary.totalByUnit.credit === 150', r.value.summary.totalByUnit.credit === 150);
});

await test('5) TRAE 已签到账号不发出 claim 请求（状态预检生效）', async () => {
  const { fetcher, calls } = recorder(() => ({ json: { code: 0, checked_in: true, enable: true, credits: 150 } }));
  const svc = makeService([acc('trae')], { r1: CRED }, fetcher);
  await svc.claim('trae');
  ok('没有 /claim 请求', calls.every((c) => !c.url.includes('/checkin_credits/claim')), JSON.stringify(calls.map((c) => c.url)));
  ok('只发了 status', calls.length === 1);
});

// ─────────────── 6) Loomy 只读 ───────────────

await test('6) Loomy 打开面板只发 points/records，不发 first-login', async () => {
  const { fetcher, calls } = recorder(() => ({ json: { code: '000000', data: { balance: 15000, dailyBalance: 4992, availableBalance: 19992 } } }));
  const svc = makeService([acc('loomy')], { r1: CRED }, fetcher);
  const st = await svc.status('loomy');
  ok('status 恒 null', st.value.accounts[0].status === null);
  ok('status 不发请求', calls.length === 0);
  const bal = await svc.balances('loomy');
  ok('余额两个池', bal.value.accounts[0].balance.packages.length === 2);
  ok('total = availableBalance', bal.value.accounts[0].balance.total === 19992);
  ok('只读路径', calls.every((c) => c.url.includes('/points/records')));
  ok('绝不碰 first-login', calls.every((c) => !c.url.includes('first-login')));
});

// ─────────────── 7) 8) MiniMax ───────────────

await test('7) MiniMax dailyCredit = points(800)，不是 points + bonus_points(1200)', async () => {
  const days = Array.from({ length: 7 }, (_, i) => ({
    day_no: i + 1, points: 800, bonus_points: 400, is_today: i === 0, status: i === 0 ? 2 : 1
  }));
  const panel = parseMinimaxSigninPanel({ scene: 1, days });
  ok('面板合法', panel !== undefined);
  ok('dailyCredit === 800', panelToCheckinStatus(panel).dailyCredit === 800);
  const { fetcher } = recorder(() => ({ json: { base_resp: { status_code: 0 }, data: { claim_result: 1, points: 800, bonus_points: 400 } } }));
  const svc = makeService([acc('minimax')], { r1: CRED }, fetcher);
  const r = await svc.claim('minimax');
  ok('领取 credit === 800', r.value.results[0].outcome.credit === 800);
});

await test('8) MiniMax 非法 timezone_id：HTTP 200 + base_resp 非 0 识别为错误', async () => {
  const { fetcher, calls } = recorder(() => ({ status: 200, json: { base_resp: { status_code: 1, status_msg: 'invalid timezone_id' } } }));
  const svc = makeService([acc('minimax')], { r1: CRED }, fetcher, undefined);
  const st = await svc.status('minimax');
  ok('status 为 null（不误判成功）', st.value.accounts[0].status === null);
  const r = await svc.claim('minimax');
  ok('claim failed', r.value.results[0].outcome.kind === 'failed');
  ok('错误码 1', r.value.results[0].outcome.code === 1);
  ok('timezone_id 在 query', calls.every((c) => c.url.includes('timezone_id=')));
});

// 面板硬约束：非法 days 不编造
await test('MiniMax 面板硬约束（days 恰好 7 条 / 最多 1 条 is_today）', async () => {
  const base = { scene: 1, days: Array.from({ length: 7 }, (_, i) => ({ day_no: i + 1, points: 100, is_today: i === 0, status: 1 })) };
  ok('合法面板', parseMinimaxSigninPanel(base) !== undefined);
  ok('6 条拒绝', parseMinimaxSigninPanel({ ...base, days: base.days.slice(0, 6) }) === undefined);
  const twoToday = base.days.map((d, i) => ({ ...d, is_today: i < 2 }));
  ok('两条 is_today 拒绝', parseMinimaxSigninPanel({ ...base, days: twoToday }) === undefined);
});

// ─────────────── 9) ZCode ───────────────

await test('9) ZCode 自动跳过；手动需 captcha；3012 给「请勿连续重试」并短路后续 plan', async () => {
  ok('自动签到排除 zcode', isAutoCheckinExcluded('zcode') === true);
  // 未注入 captcha → 明确降级（不假装成功、不自造 token）
  {
    const { fetcher } = recorder((url) =>
      url.includes('/preview')
        ? { json: { code: 0, data: { plans: [{ plan_id: 'p1', entitlements: [{ grant_units: 100000000, unit_type: 'token' }] }] } } }
        : { json: { code: 0, data: {} } }
    );
    const svc = makeService([acc('zcode')], { r1: { ...CRED, zcode_jwt: 'j', device_mid: 'd' } }, fetcher);
    const r = await svc.claim('zcode');
    const o = r.value.results[0].outcome;
    ok('无 captcha 时 inactive', o.kind === 'inactive');
    ok('actionRequired:true', o.actionRequired === true);
  }
  // 注入 captcha：3 个 plan，第 2 个 3012 → 第 3 个不得被调用
  {
    let claimCalls = 0;
    const { fetcher, calls } = recorder((url) => {
      if (url.includes('/preview')) {
        return { json: { code: 0, data: { plans: [3, 2, 1].map((priority) => ({ plan_id: `p${priority}`, priority, entitlements: [{ grant_units: 100000000, unit_type: 'token' }] })) } } };
      }
      if (url.includes('/claim')) {
        claimCalls += 1;
        return claimCalls === 1 ? { json: { code: 0 } } : { json: { code: '3012', msg: 'unusual activity' } };
      }
      return { json: { code: 0, data: {} } };
    });
    // 注入 captcha（Android 上由设置页提供；这里是测试用的 mock）
    const svc2 = makeService(
      [acc('zcode')],
      { r1: { ...CRED, zcode_jwt: 'j', device_mid: 'd' } },
      fetcher,
      undefined,
      { mintCaptcha: async () => ({ param: 'one-time', region: 'cn' }) }
    );
    const r = await svc2.claim('zcode');
    ok('短路：只发 2 次 claim', claimCalls === 2, `claimCalls=${claimCalls}`);
    ok('每次现产 captcha', calls.filter((c) => c.url.includes('/claim')).every((c) => c.init.headers['x-aliyun-captcha-verify-param'] === 'one-time'));
    const summary = r.value.summary;
    ok('汇总含 1 成功 1 失败', summary.claimed === 1 && summary.failed === 1, JSON.stringify(summary));
    ok('token 单位独立', summary.totalByUnit.token === 100000000 && summary.totalByUnit.credit === 0);
    ok('风控文案可追溯', String(r.value.results[0].outcome.message || JSON.stringify(r.value.results[0].outcome)).length > 0);
  }
  ok('业务码认纯数字字符串', parseZcodeBusinessCode('3012') === 3012);
  ok('语义短语判风控', mentionsUnusualActivity('unusual activity') === true);
  ok('限流正文不误判', mentionsUnusualActivity('retry after 3012 ms') === false);

  // _multi 展开：computeClaimSummary 不能把包裹对象算成 failed
  const expanded = expandClaimOutcome({ kind: '_multi', outcomes: [{ kind: 'claimed', credit: 100000000, unit: 'token' }, { kind: 'failed', code: 3012, message: 'x' }] });
  ok('展开成 2 条', expanded.all.length === 2);
  ok('展示合并成 claimed', expanded.display.kind === 'claimed');
  ok('保留风控标记', expanded.display.riskControlled === true);
});

// ─────────────── 10) Raccoon ───────────────

await test('10) Raccoon「新手任务」体现已领；不给「每日签到」按钮', async () => {
  const cap = capabilityOf('raccoon');
  ok('不给每日签到按钮', cap.dailyCheckin === false);
  ok('有新手任务', cap.onboardingTasks === true);
  const { fetcher, calls } = recorder((url) =>
    url.includes('/bills')
      ? { json: { code: 0, data: { items: [{ biz_type: 'reward_grant', event_name: '桌面端登录奖励', points: 3000 }] } } }
      : { json: { code: 0, data: { granted: false } } }
  );
  const svc = makeService([acc('raccoon')], { r1: { ...CRED, office_identity: 'org' } }, fetcher);
  const st = await svc.status('raccoon');
  ok('账单查出已领', st.value.accounts[0].onboarding.claimed === true);
  ok('status 恒 null', st.value.accounts[0].status === null);
  const r = await svc.claim('raccoon');
  ok('新手任务已领 → already-claimed', r.value.results[0].outcome.kind === 'already-claimed');
  // cline/gemini 不给按钮：service 在调用前返回 ok:false
  const { fetcher: f2, calls: c2 } = recorder(() => ({ json: {} }));
  const svc2 = makeService([acc('cline')], { r1: CRED }, f2);
  const noCheckin = await svc2.claim('cline');
  ok('cline ok:false', noCheckin.ok === false);
  ok('错误文案含「不支持每日签到」', String(noCheckin.error).includes('不支持每日签到'));
  ok('未发任何上游请求', c2.length === 0);
});

// ─────────────── 11) 查不到余额显示原因 ───────────────

await test('11) 任何渠道查不到余额时显示原因，不显示 0', async () => {
  for (const provider of ['trae', 'qoder', 'lobsterai', 'loomy', 'minimax', 'raccoon', 'cline', 'gemini', 'zcode']) {
    const { fetcher } = recorder(() => ({ status: 500, text: 'upstream down' }));
    const svc = makeService([acc(provider)], { r1: { ...CRED, zcode_jwt: 'j', device_mid: 'd', office_identity: 'org', account_id: 'usr-1' } }, fetcher);
    const r = await svc.balances(provider);
    const row = r.value.accounts[0];
    ok(`${provider} balance===null`, row.balance === null);
    ok(`${provider} 有 error`, typeof row.error === 'string' && row.error.length > 0);
  }
  ok('windowDays 默认 15', (await makeService([acc('trae')], { r1: CRED }, recorder(() => ({})).fetcher).balances('trae')).value.windowDays === 15);
  ok('Cline 业务层失败形态', parseClineBalanceResponse({ success: false, error: 'boom' }).error === 'boom');
  ok('Cline 网关层失败形态（无 success）', parseClineBalanceResponse({ error: 'Unauthorized' }).error === 'Unauthorized');
  ok('Gemini 两桶都没认出返回空', Object.keys(parseGeminiQuotaWindows({ groups: [] })).length === 0);
});

// ─────────────── 11.1) 剩余 / 共 / 已用 三件套 ───────────────

await test('11.1) 余额补上 limitTotal / usedTotal，剩余仍是各包 remaining 之和', async () => {
  const body = {
    user_entitlement_pack_list: [
      {
        entitlement_base_info: { quota: { credits_limit: 1000 }, display_desc: '基础包' },
        usage: { credits_amount: 300 }
      },
      {
        entitlement_base_info: { quota: { credits_limit: 500 }, display_desc: '赠送包' },
        usage: { credits_amount: 200 },
        expire_time: Math.floor(Date.UTC(2026, 11, 1) / 1000)
      }
    ]
  };
  const { fetcher } = recorder((url) => (url.includes('ide_user_ent_usage') ? { json: body } : { json: { code: 0 } }));
  const svc = makeService([acc('trae')], { r1: CRED }, fetcher);
  const b = (await svc.balances('trae')).value.accounts[0].balance;
  ok('total 是剩余 1000', b.total === 1000, JSON.stringify(b));
  ok('limitTotal 1500', b.limitTotal === 1500, String(b.limitTotal));
  ok('usedTotal 500', b.usedTotal === 500, String(b.usedTotal));
  ok('每包保留 remaining / used', b.packages[0].remaining === 700 && b.packages[0].used === 300);
});

await test('11.2) 只有 remaining 的渠道：used 由总量差兜底，不出 NaN', async () => {
  const { fetcher } = recorder(() => ({
    json: { code: '000000', data: { balance: 15000, dailyBalance: 4992, availableBalance: 19992 } }
  }));
  const svc = makeService([acc('loomy')], { r1: CRED }, fetcher);
  const b = (await svc.balances('loomy')).value.accounts[0].balance;
  ok('limitTotal = total', b.limitTotal === b.total, JSON.stringify(b));
  ok('usedTotal = 0', b.usedTotal === 0);
  ok('没有 NaN', Number.isFinite(b.limitTotal) && Number.isFinite(b.usedTotal));
});

await test('11.3) 查不到余额时不编造 limitTotal / usedTotal', async () => {
  const { fetcher } = recorder(() => ({ status: 500, text: 'down' }));
  const svc = makeService([acc('trae')], { r1: CRED }, fetcher);
  const row = (await svc.balances('trae')).value.accounts[0];
  ok('balance === null', row.balance === null);
  ok('没有 limitTotal', row.balance?.limitTotal === undefined);
});

// ─────────────── 12) 13) 自动签到记账 ───────────────

function memAutoStore(initial) {
  const mem = { doc: sanitizeAutoCheckin(initial) };
  return {
    load: () => ({ ...mem.doc, channels: [...(mem.doc.channels || [])] }),
    save: (d) => { mem.doc = { ...d }; return d; },
    peek: () => mem.doc
  };
}

await test('12) 断网跑一轮 → 不记 lastDate，重启后能重试', async () => {
  const store = memAutoStore({});
  const credits = { providersWithAccounts: () => ['trae'], claim: async () => { throw new Error('ENOTFOUND'); } };
  const a1 = createAutoCheckin({ credits, store, now: () => UTC8_1200, delayMs: 0, tickMs: 0, warn() {} });
  await a1.runIfDue();
  ok('未记 lastDate', store.peek().lastDate === '');
  ok('ranToday false', a1.state().ranToday === false);
  // 「重启」：同一个 store 重新构造调度器，仍应允许再跑
  const a2 = createAutoCheckin({ credits: { providersWithAccounts: () => ['trae'], claim: async () => ({ ok: true, value: { summary: { claimed: 1, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 1, totalCredit: 100, totalByUnit: { token: 0, credit: 100 } } } }) }, store, now: () => UTC8_1200, delayMs: 0, tickMs: 0, warn() {} });
  await a2.runIfDue();
  ok('重启后重试成功并记日期', store.peek().lastDate === '2026-11-08');
});

await test('13) 跨天：lastDate 是昨天，巡检触发一轮（不必重启）', async () => {
  const yesterdayAt = UTC8_1200 - 86400000;
  const store = memAutoStore({ lastDate: '2026-11-07', lastAt: yesterdayAt, lastResult: '旧结果' });
  let tickFn;
  const credits = {
    providersWithAccounts: () => ['trae'],
    claim: async () => ({ ok: true, value: { summary: { claimed: 1, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 1, totalCredit: 100, totalByUnit: { token: 0, credit: 100 } } } })
  };
  const auto = createAutoCheckin({
    credits, store, now: () => UTC8_1200, delayMs: 999999, tickMs: 1000,
    schedule: () => ({ cancel() {} }),
    scheduleTick: (fn) => { tickFn = fn; return { cancel() {} }; },
    warn() {}
  });
  auto.start();
  ok('巡检已注册', typeof tickFn === 'function');
  tickFn();
  await new Promise((r) => setImmediate(r));
  await auto.runIfDue();
  ok('跨天跑完记今天', store.peek().lastDate === '2026-11-08');
  ok('lastResult 已更新', store.peek().lastResult.includes('领取成功'));
  ok('逐渠道状态已记录', store.peek().channels.some((c) => c.provider === 'trae'));
  auto.stop();
});

await test('自动签到：zcode 在调用前排除、无签到渠道计 skipped、dismiss 存 lastAt', async () => {
  const store = memAutoStore({});
  const claimed = [];
  const credits = {
    providersWithAccounts: () => ['zcode', 'cline', 'trae'],
    claim: async (p) => {
      claimed.push(p);
      if (p === 'cline') return { ok: false, error: 'cline 不支持每日签到（其后端没有签到接口）' };
      return { ok: true, value: { summary: { claimed: 1, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 1, totalCredit: 300, totalByUnit: { token: 0, credit: 300 } } } };
    }
  };
  const auto = createAutoCheckin({ credits, store, now: () => UTC8_1200, delayMs: 0, tickMs: 0, warn() {} });
  await auto.runIfDue();
  ok('zcode 未被调用', !claimed.includes('zcode'));
  ok('trae 被调用', claimed.includes('trae'));
  ok('文案含跳过渠道', store.peek().lastResult.includes('不支持签到'));
  ok('逐渠道含「需手动签到」', store.peek().channels.some((c) => c.provider === 'zcode' && c.text === '需手动签到'));
  const before = auto.state().lastAt;
  await auto.dismiss();
  ok('dismiss 后 dismissed=true', auto.state().dismissed === true);
  ok('dismissedRunAt === lastAt', store.peek().dismissedRunAt === before);
  // 新一轮跑完 dismissedRunAt 归零 → 状态文字自动回来
  await auto.runIfDue(); // 同一天已跑过，被拦住；模拟跨天
  const auto2 = createAutoCheckin({ credits, store, now: () => UTC8_1200 + 86400000, delayMs: 0, tickMs: 0, warn() {} });
  await auto2.runIfDue();
  ok('新一轮清掉 dismissed 标记', store.peek().dismissedRunAt === 0);
});

// ─────────────── §2 本机 API 形状（端到端，不发外网） ───────────────

const PORT = 18998;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-checkin-test-'));
const child = spawn(process.execPath, ['main.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, OFM_DATA_DIR: DATA_DIR, OFM_PORT: String(PORT), OFM_CALLBACK_PORT: '18099', OFM_AUTO_CHECKIN_DELAY_MS: '3600000' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stderr.on('data', (d) => process.stderr.write(`  [srv!] ${d}`));
const waitFor = async () => {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未能启动');
};

try {
  await waitFor();
  const runtime = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runtime.json'), 'utf8'));
  const base = `http://127.0.0.1:${PORT}`;
  const ui = { 'x-ofm-ui-token': runtime.uiToken, 'content-type': 'application/json' };
  const post = async (p, body = {}) => (await fetch(`${base}${p}`, { method: 'POST', headers: ui, body: JSON.stringify(body) })).json();

  await test('§2 /api/checkin/* 四个端点形状与鉴权', async () => {
    const unauth = await fetch(`${base}/api/checkin/auto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    ok('无 uiToken 401', unauth.status === 401);

    const caps = await (await fetch(`${base}/api/checkin/capabilities`, { headers: ui })).json();
    ok('capabilities ok', caps.ok === true && Array.isArray(caps.value.capabilities));
    ok('trae 可自动签到', caps.value.capabilities.find((c) => c.provider === 'trae').dailyCheckin === true);

    const auto = await post('/api/checkin/auto');
    ok('auto 只读形状', auto.ok === true && typeof auto.value.autoCheckin === 'object');
    ok('auto 默认开启', auto.value.autoCheckin.enabled === true);
    ok('auto ranToday', auto.value.autoCheckin.ranToday === false);
    ok('auto channels 数组', Array.isArray(auto.value.autoCheckin.channels));

    const off = await post('/api/checkin/auto', { enabled: false });
    ok('auto 可关闭', off.value.autoCheckin.enabled === false);
    const on = await post('/api/checkin/auto', { enabled: true });
    ok('auto 可开启', on.value.autoCheckin.enabled === true);

    const noCheckin = await post('/api/checkin/claim', { provider: 'cline' });
    ok('无签到渠道 ok:false', noCheckin.ok === false);
    ok('错误可读', String(noCheckin.error).includes('不支持每日签到'));

    const st = await post('/api/checkin/status', { provider: 'loomy' });
    ok('status 形状', st.ok === true && Array.isArray(st.value.accounts));

    const bal = await post('/api/checkin/balances', { provider: 'opencode' });
    ok('balances 形状', bal.ok === true && Array.isArray(bal.value.accounts));
    ok('windowDays', bal.value.windowDays === 15);

    const unknown = await post('/api/checkin/status', { provider: 'nope' });
    ok('未知渠道不 500', unknown.ok === false);

    // Qoder machine 头可写、可查、可清除（Android 上的 Pluggable 入口）
    const setQm = await post('/api/settings', { credits: { qoderMachine: { token: 'mt', type: 'ty' } } });
    ok('保存后 configured=true', setQm.qoderMachineConfigured === true);
    const statusAfter = await (await fetch(`${base}/api/status`, { headers: ui })).json();
    ok('/api/status 反映已配置', statusAfter.qoderMachineConfigured === true);
    const clearQm = await post('/api/settings', { credits: { qoderMachine: { token: '', type: '' } } });
    ok('清除后 configured=false', clearQm.qoderMachineConfigured === false);
  });
} finally {
  child.kill('SIGTERM');
}

console.log(`\n通过 ${passed} 项断言，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
