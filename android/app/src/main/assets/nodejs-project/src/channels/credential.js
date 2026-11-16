/**
 * 凭据生命周期：读、按需续期、回写。
 *
 * 续期时机的三条规则（§5.0，对齐上游 channel pack）：
 *  - 距过期 < 60s 才续，且是在**发请求前**做；后台定时主动续期见 auto-renew.js；
 *  - 传输层失败不判终态（网络抖动不该让用户重登），沿用旧凭据；
 *  - 只有明确的 401/403 + auth 错误码才标记需重新登录。
 *
 * 两处对齐上游的修正：
 *  1. 过期时间用 credential-expiry.js 统一解析（数字秒/毫秒、ISO、JWT exp 兜底），
 *     旧实现只认数字毫秒，秒级/ISO/JWT 凭据会被判成「永不需续」；
 *  2. 单账号刷新锁（对应 Go 端 refreshLocked）：并发请求/定时巡检同时想刷同一个
 *     账号时只发一次上游请求，避免 refresh_token 轮换竞争（后写回的旧值覆盖新值）。
 */
import { OfmError, Codes } from '../errors.js';
import { expiresWithin, credentialExpiresAtMs } from '../credential-expiry.js';

const REFRESH_MARGIN_MS = 60000;

/** 在飞的刷新任务，按账号 id 去重。模块级即可：一个进程里只有一份 store。 */
const inflightRefreshes = new Map();

/**
 * 同一账号只保留一个在飞的刷新任务；后来的调用者复用同一个 Promise。
 * 刷新结束（成功或失败）后清理，避免内存随账号数增长。
 */
export function withRefreshLock(key, fn) {
  const k = String(key);
  const existing = inflightRefreshes.get(k);
  if (existing) return existing;
  let task;
  task = Promise.resolve()
    .then(fn)
    .finally(() => {
      if (inflightRefreshes.get(k) === task) inflightRefreshes.delete(k);
    });
  inflightRefreshes.set(k, task);
  return task;
}

/** 仅供测试：清空在飞锁。 */
export function clearRefreshLocks() {
  inflightRefreshes.clear();
}

export function shouldRefresh(credential, marginMs = REFRESH_MARGIN_MS, nowMs = Date.now()) {
  if (!credential) return false;
  // 没有过期时间（例如永久 token）就不主动续 —— 与上游 isTraeExpired 一致
  return expiresWithin(credential, marginMs, nowMs);
}

async function doRefresh(store, account, refresh, cred) {
  try {
    const next = await refresh(cred);
    const merged = { ...cred, ...next };
    store.writeCredential(account.credentialRef, merged);
    const exp = credentialExpiresAtMs(merged);
    store.update((s) => {
      const a = s.accounts.find((x) => x.id === account.id);
      if (a) {
        if (exp !== undefined) a.expiresAt = exp;
        a.needsLogin = false;
      }
    });
    return merged;
  } catch (e) {
    // 传输层失败：沿用旧凭据，让请求自己失败成可重试错误
    if (e?.code === Codes.TRANSPORT || e?.code === Codes.TIMEOUT) return cred;
    if (e?.code === Codes.AUTH) {
      store.update((s) => {
        const a = s.accounts.find((x) => x.id === account.id);
        if (a) a.needsLogin = true;
      });
    }
    throw e;
  }
}

/**
 * @param {import('../store.js').Store} store
 * @param {object} account
 * @param {object} options
 * @param {(cred:object)=>Promise<object>} options.refresh
 * @param {boolean} [options.force]
 */
export async function ensureCredential(store, account, { refresh, force = false } = {}) {
  const cred = store.readCredential(account.credentialRef);
  if (!cred) {
    throw new OfmError(Codes.AUTH, `${account.nickname || account.provider} 的凭据已丢失，需要重新登录`, {
      provider: account.provider,
      accountId: account.id
    });
  }
  if (!force && !shouldRefresh(cred)) return cred;
  // 没有刷新端点的渠道（loomy / zcode）：force 也只是读一次凭据，不发上游请求
  if (!refresh) return cred;

  const key = account.id || account.credentialRef;
  return withRefreshLock(key, () => doRefresh(store, account, refresh, cred));
}
