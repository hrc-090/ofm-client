/**
 * Qoder 设备码 + PKCE 登录 / 续期 / 用户信息（§5.2）。
 * ⚠️ 轮询挂 openApiBase；client_id 必须用生产值，否则授权页报「参数无效」。
 */
import crypto from 'node:crypto';
import { request, briefBody } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { PATHS } from './product.js';
import { toEpochMs, now } from '../../util.js';

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function makeVerifier() {
  const len = 64;
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += UNRESERVED[bytes[i] % UNRESERVED.length];
  return out;
}

export function createSession(product) {
  const verifier = makeVerifier();
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const nonce = crypto.randomUUID();
  const machineId = crypto.randomUUID();
  return {
    verifier,
    challenge,
    nonce,
    machineId,
    productId: product.id,
    loginUrl: `${product.authBase}${PATHS.deviceSelect}?${new URLSearchParams({
      challenge,
      challenge_method: 'S256',
      nonce,
      machine_id: machineId,
      client_id: product.clientId
    }).toString()}`,
    failures: 0,
    createdAt: Date.now()
  };
}

export function parseTokenPayload(value) {
  if (!value || typeof value !== 'object') return { accessToken: '' };
  const accessToken = value.token || value.device_token || value.access_token || '';
  return {
    accessToken,
    refreshToken: value.refresh_token || value.refreshToken,
    expiresAt: toEpochMs(value.expires_at ?? value.expiresAt, 0) || undefined,
    refreshExpiresAt: toEpochMs(value.refresh_token_expires_at ?? value.refreshTokenExpiresAt, 0) || undefined,
    uid: value.user_id || value.userId,
    userName: value.user_name || value.userName
  };
}

/** 单次轮询。返回 {done:false} / {done:true, credential} */
export async function pollOnce(session, product) {
  const url = `${product.openApiBase}${PATHS.poll}?${new URLSearchParams({
    nonce: session.nonce,
    verifier: session.verifier,
    challenge_method: 'S256'
  }).toString()}`;

  let res;
  try {
    res = await request(url, { method: 'GET', headers: { accept: 'application/json' }, timeoutMs: 20000 });
    session.failures = 0;
  } catch (e) {
    session.failures += 1;
    if (session.failures >= 5) {
      return { done: true, success: false, error: `连续 ${session.failures} 次网络失败，登录已放弃` };
    }
    return { done: false, status: 'network-retry' };
  }

  // 404 = 用户还没授权，继续等
  if (res.status === 404) return { done: false, status: 'waiting' };
  if (res.status < 200 || res.status >= 300) {
    return { done: true, success: false, error: `登录服务返回异常 HTTP ${res.status}: ${briefBody(res.text, 200)}` };
  }

  const payload = parseTokenPayload(res.json);
  if (!payload.accessToken) {
    return { done: true, success: false, error: '登录响应里没有 access_token' };
  }

  const credential = {
    access_token: payload.accessToken,
    security_oauth_token: payload.accessToken, // 双写：取用顺序是 security_oauth_token ?? access_token
    refresh_token: payload.refreshToken,
    expire_time: payload.expiresAt,
    expires_at: payload.expiresAt,
    refresh_token_expire_time: payload.refreshExpiresAt,
    machine_id: session.machineId,
    uid: payload.uid,
    nickname: payload.userName
  };

  return {
    done: true,
    success: true,
    nickname: payload.userName || payload.uid || 'Qoder 账号',
    expiresAt: payload.expiresAt,
    credential
  };
}

export async function refreshCredential(cred, product) {
  if (!cred.refresh_token) {
    throw new OfmError(Codes.AUTH, 'Qoder 凭据没有 refresh_token，需要重新登录', { status: 401 });
  }
  const res = await request(`${product.openApiBase}${PATHS.refresh}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: { refresh_token: cred.refresh_token, machine_id: cred.machine_id }
  });
  if (res.status === 401 || res.status === 403) {
    throw new OfmError(Codes.AUTH, 'Qoder 续期失败，需要重新登录', { status: 401 });
  }
  if (res.status >= 400) {
    throw new OfmError(Codes.UPSTREAM, `Qoder 续期失败 HTTP ${res.status}: ${briefBody(res.text, 200)}`);
  }
  const p = parseTokenPayload(res.json);
  if (!p.accessToken) throw new OfmError(Codes.UPSTREAM, 'Qoder 续期响应缺少 token');
  return {
    ...cred,
    access_token: p.accessToken,
    security_oauth_token: p.accessToken,
    // 没有新 refresh_token 就沿用旧的（别把可续期凭据变成不可续期）
    refresh_token: p.refreshToken || cred.refresh_token,
    expire_time: p.expiresAt || cred.expire_time,
    expires_at: p.expiresAt || cred.expires_at
  };
}

/** 加密推理依赖 uid；旧凭据缺 uid 时补一次并回写 */
export async function fetchUserInfo(cred, product) {
  const res = await request(`${product.openApiBase}${PATHS.userinfo}`, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${cred.access_token}` },
    timeoutMs: 20000
  });
  if (res.status >= 400) return null;
  const data = res.json?.data || res.json || {};
  return {
    uid: String(data.uid ?? data.user_id ?? data.id ?? ''),
    nickname: data.nickname || data.user_name || data.name || ''
  };
}

export { now };
