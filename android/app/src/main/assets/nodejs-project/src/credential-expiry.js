/**
 * 凭据过期时间统一解析 —— 对齐上游 channel pack (trae.ts) 的
 * `traeCredentialExpiresAtMs` / `isTraeRefreshable` / `buildTraeCredential`。
 *
 * 本地旧实现只认 `expires_at` 的**数字毫秒**，于是：
 *  - 秒级时间戳（如 1731484800）被当成「1.7e9 毫秒 = 1970 年」→ 永远判已过期；
 *  - ISO 字符串 / 只有 JWT `exp` 的凭据被当成「无过期时间」→ 永不主动续。
 * 两者都会让「请求前按需续期」与「后台定时续期」双双失效，表现为放着不用
 * 一段时间后账号悄悄变成需重登。
 *
 * 上游的取值顺序：expires_at（数字秒/毫秒或 ISO）→ access_token 的 JWT exp。
 * 无法解析时返回 undefined，**不判定过期**（与上游 `isTraeExpired` 一致）。
 */
const EPOCH_MS_THRESHOLD = 1_000_000_000_000; // 1e12：小于它按「秒」处理

/** 解析一个可能是数字 / 数字字符串 / ISO 串的时间戳为毫秒。无法解析返回 undefined。 */
export function parseExpiryMs(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return raw > EPOCH_MS_THRESHOLD ? raw : raw * 1000;
  }
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (/^\d+$/.test(t)) {
    const v = Number(t);
    if (!Number.isFinite(v) || v <= 0) return undefined;
    return v > EPOCH_MS_THRESHOLD ? v : v * 1000;
  }
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 从 JWT 的 payload 取 `exp`（Unix 秒）转毫秒。
 * 只解码、不验签：这里仅用于估算过期时间，凭据真伪由上游接口判定。
 */
export function jwtExpiresAtMs(token) {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return undefined;
    return exp > EPOCH_MS_THRESHOLD ? exp : exp * 1000;
  } catch {
    return undefined;
  }
}

/** 凭据里的候选过期字段，按优先级。各渠道写入习惯不一，逐个试。 */
const EXPIRY_KEYS = ['expires_at', 'expire_time', 'expiresAt', 'expiry', 'expires'];

/**
 * 凭据过期毫秒时间戳；全部来源都拿不到时回退 JWT exp；再拿不到返回 undefined。
 * @returns {number|undefined}
 */
export function credentialExpiresAtMs(cred) {
  if (!cred || typeof cred !== 'object' || Array.isArray(cred)) return undefined;
  for (const key of EXPIRY_KEYS) {
    const ms = parseExpiryMs(cred[key]);
    if (ms !== undefined) return ms;
  }
  return jwtExpiresAtMs(cred.access_token || cred.token || cred.zcode_jwt);
}

/** 是否已过期（无法解析时不判过期，对齐上游 isTraeExpired）。 */
export function isCredentialExpired(cred, nowMs = Date.now()) {
  const exp = credentialExpiresAtMs(cred);
  return exp === undefined ? false : nowMs >= exp;
}

/** 距过期是否小于 marginMs；无法解析过期时间返回 false（不主动打扰永久 token）。 */
export function expiresWithin(cred, marginMs, nowMs = Date.now()) {
  const exp = credentialExpiresAtMs(cred);
  if (exp === undefined) return false;
  return exp - nowMs < marginMs;
}

/** 是否携带可静默续期的刷新材料（对齐上游 isTraeRefreshable）。 */
export function isRefreshable(cred) {
  if (!cred || typeof cred !== 'object') return false;
  for (const key of ['refresh_token', 'refreshToken']) {
    const v = cred[key];
    if (typeof v === 'string' && v.trim().length > 0) return true;
  }
  return false;
}

/** 给排障看的可读剩余时长，不含任何凭据值。 */
export function describeExpiry(cred, nowMs = Date.now()) {
  const exp = credentialExpiresAtMs(cred);
  if (exp === undefined) return '无过期时间';
  const hours = (exp - nowMs) / 3_600_000;
  if (hours <= 0) return `已过期 ${Math.round(-hours * 10) / 10}h`;
  return `剩余 ${Math.round(hours * 10) / 10}h`;
}
