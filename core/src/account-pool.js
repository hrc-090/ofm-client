/**
 * 账号池：选号、限流标记、黑名单（§6.4）。
 *
 * 规则：
 *  - 只挑 enabled 且 provider 匹配的账号；
 *  - modelRateLimits[modelId] > now 的跳过；
 *  - 全部被限流时，报「最早 X 解禁」，而不是「请重新登录」（方向错了会误导用户）；
 *  - 按「最久没被用过」排序，避免总打同一个账号。
 */
import { OfmError, Codes } from './errors.js';
import { now } from './util.js';

export function isModelLimited(account, modelId, at = now()) {
  const until = account?.modelRateLimits?.[modelId];
  return typeof until === 'number' && until > at;
}

export function candidates(settings, provider, modelId) {
  const at = now();
  return settings.accounts
    .filter((a) => a.provider === provider && a.enabled !== false)
    .filter((a) => !isModelLimited(a, modelId, at))
    // 被 CPU 层面标记「需重新登录」的账号不参与（enabled 由 UI 控制，这里用独立标记）
    .filter((a) => a.needsLogin !== true)
    // 登录尚未完成的占位账号不参与
    .filter((a) => a.pending !== true)
    .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
}

/**
 * @returns {Array} 候选账号（至少一个）；否则抛出可读错误
 */
export function pickAccounts(settings, provider, modelId, { providerName } = {}) {
  const label = providerName || provider;
  const all = settings.accounts.filter((a) => a.provider === provider && a.enabled !== false);
  const usable = candidates(settings, provider, modelId);
  if (usable.length) return usable;

  if (!all.length) {
    const needsLogin = settings.accounts.filter((a) => a.provider === provider);
    if (needsLogin.length) {
      throw new OfmError(Codes.AUTH, `${label} 的账号需要重新登录`, { provider, status: 401 });
    }
    throw new OfmError(Codes.NO_ACCOUNT, `${label} 尚未连接账号，请先在 App 内登录`, { provider, status: 400 });
  }

  const untils = all
    .map((a) => a.modelRateLimits?.[modelId])
    .filter((t) => typeof t === 'number' && t > now());
  if (untils.length) {
    const earliest = Math.min(...untils);
    const secs = Math.max(1, Math.round((earliest - now()) / 1000));
    throw new OfmError(Codes.RATE_LIMITED, `模型 ${modelId} 的所有 ${label} 账号均在限流期，最早 ${secs} 秒后解禁`, {
      provider,
      retryAfterMs: secs * 1000
    });
  }
  throw new OfmError(Codes.NO_ACCOUNT, `${label} 无可用的已启用账号`, { provider });
}

export function markRateLimited(store, accountId, modelId, untilMs) {
  store.update((s) => {
    const acc = s.accounts.find((a) => a.id === accountId);
    if (!acc) return;
    acc.modelRateLimits = acc.modelRateLimits || {};
    acc.modelRateLimits[modelId] = untilMs;
  });
}

export function markUsed(store, accountId) {
  store.update((s) => {
    const acc = s.accounts.find((a) => a.id === accountId);
    if (acc) acc.lastUsedAt = now();
  });
}

export function markNeedsLogin(store, accountId, value = true) {
  store.update((s) => {
    const acc = s.accounts.find((a) => a.id === accountId);
    if (acc) acc.needsLogin = value;
  });
}
