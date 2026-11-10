/**
 * 签到 / 积分服务门面。
 *
 * 把「能力表 → 账号池 → 渠道 provider → 逐账号收集」串起来，
 * 对 server.js 只暴露 status / claim / balances / capabilities 四个方法，
 * 并保证：
 *  - **顺序执行**（collect 层），单账号凭据损坏 / 网络失败只影响该账号；
 *  - 无签到能力的渠道在**调用之前**返回 ok:false（自动签到据此判 skipped），
 *    绝不发上游请求；
 *  - 状态查询不臆造（没有独立状态端点的渠道恒 status:null，也不发请求）；
 *  - 日志只打 provider / accountId / 错误码 / 短文案，绝不打印 token。
 */
import { makeFetcher } from './fetcher.js';
import { describeNetError } from '../http-client.js';
import { capabilityOf, listCapabilities, isAutoCheckinExcluded } from './capability.js';
import { collectCreditsStatus, collectClaimResults, collectCreditBalances } from './collect.js';
import { computeClaimSummary } from './model.js';
import { creditExpiringWindowDays } from './constants.js';
import { createTraeProvider } from './providers/trae.js';
import { createQoderProvider } from './providers/qoder.js';
import { createLobsteraiProvider } from './providers/lobsterai.js';
import { createLoomyProvider } from './providers/loomy.js';
import { createMinimaxProvider } from './providers/minimax.js';
import { createZcodeProvider } from './providers/zcode.js';
import { createRaccoonProvider } from './providers/raccoon.js';
import { createClineProvider } from './providers/cline.js';
import { createGeminiProvider } from './providers/gemini.js';

const FACTORIES = {
  trae: createTraeProvider,
  qoder: createQoderProvider,
  qodercn: createQoderProvider,
  lobsterai: createLobsteraiProvider,
  loomy: createLoomyProvider,
  minimax: createMinimaxProvider,
  zcode: createZcodeProvider,
  raccoon: createRaccoonProvider,
  cline: createClineProvider,
  gemini: createGeminiProvider
};

export function createCreditsService({
  store,
  registry,
  log = console,
  env = process.env,
  fetcher,
  now,
  machineHeaders,
  mintCaptcha,
  timezoneId
} = {}) {
  // 最近一次出站网络异常（脱敏）。provider 常把网络失败收敛成「余额查询失败」，
  // 这里留一份线索，供 balances/claim 在全员失败时补上真实原因。
  // 包一层是必要的：验收注入的 mock fetcher 也要能记录错误。
  let lastNetError = null;
  const baseFetcher = fetcher || makeFetcher();
  const net = async (url, init = {}) => {
    try {
      return await baseFetcher(url, init);
    } catch (e) {
      lastNetError = e;
      throw e;
    }
  };
  const cache = new Map();

  function netErrorHint() {
    if (!lastNetError) return '';
    const hint = describeNetError(lastNetError) || lastNetError.message || '';
    return String(hint).slice(0, 160);
  }

  /** 只打安全字段：provider / 账号 id / 短文案。绝不打印凭据内容。 */
  function warn(provider, message) {
    const safe = String(message || '')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
      .slice(0, 200);
    log?.warn?.(`[credits:${provider}] ${safe}`);
  }

  function providerOf(provider) {
    if (cache.has(provider)) return cache.get(provider);
    const factory = FACTORIES[provider];
    if (!factory) return undefined;
    const instance = factory({
      fetcher: net,
      log,
      now,
      settings: store.settings,
      getSettings: () => store.settings, // store.update() 会换掉 settings 对象
      env,
      productId: provider,
      machineHeaders,
      mintCaptcha,
      timezoneId
    });
    cache.set(provider, instance);
    return instance;
  }

  /** ⚠️ 包含已停用账号：停用只影响选号，不改变「今天领没领」。 */
  function accountsOf(provider) {
    return (store.settings.accounts || []).filter((a) => a.provider === provider);
  }

  async function resolve(account) {
    const channel = registry.get(account.provider);
    return channel.credential(store, account);
  }

  function noCheckinError(provider, cap) {
    const name = provider || '(未指定)';
    const note = cap?.note || '该渠道没有每日签到';
    return { ok: false, error: `${name} 不支持每日签到：${note}` };
  }

  /** POST /api/checkin/status —— 逐账号查签到状态。 */
  async function status(provider) {
    const cap = capabilityOf(provider);
    if (cap === null) return { ok: false, error: `未知渠道 ${provider || '(未指定)'}` };
    const accounts = accountsOf(provider);
    const value = { accounts: [] };

    // 没有独立状态端点的渠道：如实返回 null，且**不发请求**（避免白多一次 GET）
    if (cap.checkinStatus !== true) {
      const p = providerOf(provider);
      for (const a of accounts) {
        const row = { accountId: a.id, nickname: a.nickname || a.id, status: null };
        // Raccoon 的新手任务状态由账单提供，供 UI 显示「已领取」
        if (cap.onboardingTasks === true && typeof p?.fetchOnboardingStatus === 'function') {
          try {
            row.onboarding = await p.fetchOnboardingStatus(await resolve(a));
          } catch {
            row.onboarding = { claimed: false };
          }
        }
        value.accounts.push(row);
      }
      return { ok: true, value };
    }

    const p = providerOf(provider);
    if (!p) return { ok: false, error: `渠道 ${provider} 未实现签到状态查询` };
    value.accounts = await collectCreditsStatus(accounts, {
      resolve,
      fetchStatus: (cred) => p.fetchStatus(cred),
      warn: (m) => warn(provider, m)
    });
    return { ok: true, value };
  }

  /** POST /api/checkin/claim —— 逐账号领取（一键签到）。 */
  async function claim(provider) {
    const cap = capabilityOf(provider);
    if (cap === null) return { ok: false, error: `未知渠道 ${provider || '(未指定)'}` };
    // ⚠️ 先于任何上游请求：没有签到能力就直接返回 ok:false，
    //    自动签到据此把它计为 skipped（§4.4）。
    if (cap.dailyCheckin !== true && cap.onboardingTasks !== true) {
      return noCheckinError(provider, cap);
    }
    const p = providerOf(provider);
    if (!p) return { ok: false, error: `渠道 ${provider} 未实现领取` };
    const accounts = accountsOf(provider);
    if (accounts.length === 0) {
      return { ok: true, value: { results: [], summary: computeClaimSummary([]) } };
    }
    lastNetError = null;
    const value = await collectClaimResults(accounts, {
      resolve,
      fetchStatus: (cred) => p.fetchStatus(cred),
      claim: (cred) => p.claim(cred),
      precheckStatus: p.precheckStatus !== false,
      warn: (m) => warn(provider, m)
    });
    // 全员失败且期间出现过网络异常 → 把真实原因补进提示，别只留「签到失败」
    const hint = netErrorHint();
    if (hint && value.results.length && value.results.every((r) => r.outcome?.kind === 'failed')) {
      for (const r of value.results) {
        if (r.outcome) r.outcome.message = `${r.outcome.message || '领取失败'}（网络原因：${hint}）`;
      }
    }
    return { ok: true, value };
  }

  /**
   * 给余额补上「总量 / 已用」汇总，供界面显示「剩余 X / 共 Y · 已用 Z」。
   *
   * 口径：total = 各包 remaining 之和（provider 已算），limitTotal = 各包 total 之和，
   * usedTotal = 各包 used 之和；个别 provider 只给 remaining/total，用差值兜。
   * ⚠️ 同一账号下的资源包单位一致（TRAE 是 credits、ZCode 是 token），
   *    跨单位相加只发生在同一账号内，跨账号仍由调用方按 unit 分桶。
   */
  function withUsageSummary(balance) {
    if (!balance || !Array.isArray(balance.packages) || balance.packages.length === 0) return balance;
    let limitTotal = 0;
    let usedTotal = 0;
    for (const p of balance.packages) {
      limitTotal += Number(p?.total) || 0;
      usedTotal += Number(p?.used) || 0;
    }
    const remaining = Number(balance.total) || 0;
    if (usedTotal <= 0 && limitTotal > remaining) usedTotal = limitTotal - remaining;
    return {
      ...balance,
      limitTotal: Math.round(limitTotal * 100) / 100,
      usedTotal: Math.round(Math.max(0, usedTotal) * 100) / 100
    };
  }

  /** POST /api/checkin/balances —— 逐账号查余额。 */
  async function balances(provider, { force } = {}) {
    const cap = capabilityOf(provider);
    if (cap === null) return { ok: false, error: `未知渠道 ${provider || '(未指定)'}` };
    const accounts = accountsOf(provider);
    const windowDays = creditExpiringWindowDays(env);
    if (cap.balance !== true || accounts.length === 0) {
      return { ok: true, value: { accounts: [], windowDays } };
    }
    const p = providerOf(provider);
    if (!p) return { ok: true, value: { accounts: [], windowDays } };
    // 所有 provider 的 fetchBalance 返回 { balance, error }，正好是 Detailed 契约
    const detailed =
      p.fetchBalanceDetailed || p.fetchBalance
        ? (cred, a) => (p.fetchBalanceDetailed || p.fetchBalance)(cred, a, { force })
        : undefined;
    lastNetError = null;
    const rows = await collectCreditBalances(accounts, {
      resolve,
      fetchBalanceDetailed: detailed,
      warn: (m) => warn(provider, m)
    });
    // 每个账号都查不到余额时，把底层网络原因透出来。
    // 否则真机上只会显示一句「余额查询失败」，无法区分没网 / 证书 / 凭据失效。
    const hint = netErrorHint();
    if (hint && rows.length && rows.every((r) => r.balance === null)) {
      for (const r of rows) r.error = [r.error, `网络原因：${hint}`].filter(Boolean).join('；');
    }
    for (const r of rows) if (r.balance) r.balance = withUsageSummary(r.balance);
    return { ok: true, value: { accounts: rows, windowDays } };
  }

  /** 账号池里有账号的渠道（去重 + 排序）—— 自动签到只遍历这些。 */
  function providersWithAccounts() {
    const set = new Set((store.settings.accounts || []).map((a) => a.provider));
    return [...set].filter((p) => capabilityOf(p) !== null).sort();
  }

  return {
    status,
    claim,
    balances,
    capabilities: listCapabilities,
    isAutoExcluded: isAutoCheckinExcluded,
    providersWithAccounts,
    providerOf
  };
}
