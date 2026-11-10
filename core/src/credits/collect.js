/**
 * 三个「逐账号顺序收集」helper —— 对应上游 collectCreditResults 系列。
 *
 * 共同纪律（说明书 §2）：
 *  - **顺序执行**，不并发（并发易触发风控）；
 *  - 包含已停用账号（停用只影响选号，不改变「今天领没领」）；
 *  - 单个账号的凭据缺失 / JSON 损坏 / 网络失败**只让该账号记 failed / null**，
 *    不能中断整批；凭据解析本身也在 try 内。
 *  - 余额查询失败**保留原因**（null 与 0 严格区分）。
 *
 * deps.resolve(account) -> credential 对象（或抛错 / 返回 undefined）。
 */
import { computeClaimSummary } from './model.js';
import { claimUnitOf, roundCredits } from './format.js';

function accountId(a) {
  return a.id || a.accountId;
}
function nickname(a) {
  return a.nickname || accountId(a);
}

async function resolveOne(account, resolve, warn) {
  try {
    const cred = await resolve(account);
    if (cred === undefined || cred === null) return { ok: false, error: '凭据未配置' };
    return { ok: true, cred };
  } catch (e) {
    warn?.(`账号 ${accountId(account)} 凭据解析失败: ${e?.message || String(e)}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 逐账号查签到状态。status 为 null 表示查不到（不臆造）。 */
export async function collectCreditsStatus(accounts, deps) {
  const { resolve, fetchStatus = async () => null, warn } = deps;
  const out = [];
  for (const a of accounts) {
    let status = null;
    const r = await resolveOne(a, resolve, warn);
    if (r.ok) {
      try {
        status = (await fetchStatus(r.cred, a)) ?? null;
      } catch (e) {
        warn?.(`credits.status 账号 ${accountId(a)} 失败: ${e?.message || String(e)}`);
        status = null;
      }
    }
    out.push({ accountId: accountId(a), nickname: nickname(a), status });
  }
  return out;
}

/**
 * 逐账号领取（顺序、单账号失败不中断）。
 * precheckStatus（默认 true）：先查状态，活动未开启 / 今日已领则跳过领取请求。
 * 状态查询失败（null）时仍尝试领取 —— 无法确认不代表不能领。
 * LobsterAI 的 claim 自带状态判断，传 precheckStatus:false 跳过预检。
 */
export async function collectClaimResults(accounts, deps) {
  const {
    resolve,
    fetchStatus = async () => null,
    claim,
    precheckStatus = true,
    warn
  } = deps;
  const results = [];
  const outcomes = [];
  for (const a of accounts) {
    let outcome;
    const r = await resolveOne(a, resolve, warn);
    if (!r.ok) {
      outcome = { kind: 'failed', code: -1, message: r.error };
    } else {
      try {
        if (!precheckStatus) {
          outcome = await claim(r.cred, a);
        } else {
          let status = null;
          try {
            status = (await fetchStatus(r.cred, a)) ?? null;
          } catch {
            status = null; // 状态查询失败仍尝试领取
          }
          if (status !== null && status.active === false) {
            outcome = { kind: 'inactive', message: '签到活动未开启' };
          } else if (status !== null && status.todayCheckedIn === true) {
            outcome = { kind: 'already-claimed', message: '今天已签到' };
          } else {
            outcome = await claim(r.cred, a);
          }
        }
      } catch (e) {
        warn?.(`credits.claimAll 账号 ${accountId(a)} 失败: ${e?.message || String(e)}`);
        outcome = { kind: 'failed', code: -1, message: e?.message || String(e) };
      }
    }
    // ZCode 一个账号可能领多个 plan，provider 返回 { kind:'_multi', outcomes }。
    // summary 要按展开后的每条算（每个 plan 算一次领取），
    // results[].outcome 则合并成单条供 UI 展示。
    const expanded = expandClaimOutcome(outcome);
    for (const o of expanded.all) outcomes.push(o);
    results.push({ accountId: accountId(a), nickname: nickname(a), outcome: expanded.display });
  }
  return { results, summary: computeClaimSummary(outcomes) };
}

/**
 * 把 provider 的领取结果拆成「逐条（供汇总）」与「单条（供展示）」。
 * 普通 provider 原样透传；ZCode 的 _multi 在这里展开，避免 computeClaimSummary
 * 把整个包裹对象当成一条 failed。
 */
export function expandClaimOutcome(raw) {
  if (raw && raw.kind === '_multi' && Array.isArray(raw.outcomes)) {
    const all = raw.outcomes.length > 0 ? raw.outcomes : [{ kind: 'inactive', message: '没有可领取的 plan' }];
    return { display: mergeClaimOutcomes(all), all };
  }
  return { display: raw, all: [raw] };
}

/** 同账号多 plan 的结果合并成一条 ClaimOutcome（保留风控提示与 coversToday）。 */
export function mergeClaimOutcomes(list) {
  const claimed = list.filter((o) => o?.kind === 'claimed');
  if (claimed.length > 0) {
    const byUnit = { token: 0, credit: 0 };
    for (const o of claimed) byUnit[claimUnitOf(o.unit)] += o.credit || 0;
    const unit = byUnit.token > 0 ? 'token' : 'credit';
    const risk = list.find((o) => o?.kind === 'failed' && o.code === 3012);
    return {
      kind: 'claimed',
      credit: roundCredits(byUnit[unit]),
      unit,
      streakDays: claimed[0].streakDays || 0,
      isStreakDay: Boolean(claimed[0].isStreakDay),
      ...(risk ? { riskControlled: true } : {}),
      ...(list.some((o) => o?.coversToday === false) ? { coversToday: false } : {})
    };
  }
  // 没有成功：优先暴露风控 / 失败原文（3012 的「请勿连续重试」不能丢）
  const failed = list.find((o) => o?.kind === 'failed');
  if (failed) return failed;
  const already = list.find((o) => o?.kind === 'already-claimed');
  if (already) return already;
  const inactive = list.find((o) => o?.kind === 'inactive');
  if (inactive) return inactive;
  return { kind: 'inactive', message: '没有可领取的内容' };
}

/** 逐账号查余额（顺序、保留失败原因）。 */
export async function collectCreditBalances(accounts, deps) {
  const { resolve, fetchBalance, fetchBalanceDetailed, warn } = deps;
  const out = [];
  for (const a of accounts) {
    let balance = null;
    let error;
    let extra;
    const r = await resolveOne(a, resolve, warn);
    if (!r.ok) {
      error = r.error;
    } else {
      try {
        if (fetchBalanceDetailed) {
          const d = (await fetchBalanceDetailed(r.cred, a)) || {};
          balance = d.balance ?? null;
          error = d.error;
          extra = d.extra;
          if (balance === null && error === undefined) error = '余额查询失败';
        } else {
          balance = (await fetchBalance(r.cred, a)) ?? null;
          if (balance === null) error = '余额查询失败';
        }
      } catch (e) {
        warn?.(`credits.balances 账号 ${accountId(a)} 失败: ${e?.message || String(e)}`);
        error = e?.message || String(e);
        balance = null;
      }
    }
    const row = { accountId: accountId(a), nickname: nickname(a), balance };
    if (error !== undefined) row.error = error;
    if (extra !== undefined) row.extra = extra;
    out.push(row);
  }
  return out;
}
