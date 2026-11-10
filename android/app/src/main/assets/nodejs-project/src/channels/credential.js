/**
 * 凭据生命周期：读、按需续期、回写。
 *
 * 续期时机的三条规则（§5.0）：
 *  - 距过期 < 60s 才续，且是在**发请求前**做；
 *  - 传输层失败不判终态（网络抖动不该让用户重登），沿用旧凭据；
 *  - 只有明确的 401/403 + auth 错误码才标记需重新登录。
 */
import { OfmError, Codes } from '../errors.js';

const REFRESH_MARGIN_MS = 60000;

export function shouldRefresh(credential, marginMs = REFRESH_MARGIN_MS) {
  if (!credential) return false;
  // 没有过期时间（例如永久 token）就不主动续
  if (!credential.expires_at) return false;
  return credential.expires_at - Date.now() < marginMs;
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
  if (!refresh) return cred;

  try {
    const next = await refresh(cred);
    const merged = { ...cred, ...next };
    store.writeCredential(account.credentialRef, merged);
    if (merged.expires_at) {
      store.update((s) => {
        const a = s.accounts.find((x) => x.id === account.id);
        if (a) {
          a.expiresAt = merged.expires_at;
          a.needsLogin = false;
        }
      });
    }
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
