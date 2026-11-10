/**
 * TRAE 登录 / 续期 / 用户信息（§5.1）。
 */
import { request, briefBody } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { TRAE, TRAE_PATHS } from './product.js';
import { buildLoginUrl, parseCallbackQuery } from './protocol.js';
import { hex32, toEpochMs, expiresInToMs, deepJson, parseUrlEncodedJson, now } from '../../util.js';

export function newLoginSession() {
  const machineId = hex32();
  const deviceId = hex32();
  return {
    machineId,
    deviceId,
    loginUrl: buildLoginUrl({ machineId, deviceId }),
    completed: false
  };
}

export async function exchangeToken(refreshToken) {
  const res = await request(`${TRAE.oauthHost}${TRAE_PATHS.exchangeToken}`, {
    method: 'POST',
    headers: { 'user-agent': TRAE.userAgent, accept: 'application/json' },
    body: {
      ClientID: TRAE.clientId,
      RefreshToken: refreshToken,
      ClientSecret: '-',
      UserID: ''
    }
  });
  const root = res.json?.Result || res.json?.result || res.json;
  const token = root?.Token || root?.token || root?.AccessToken;
  if (res.status >= 400 || !token) {
    throw new OfmError(Codes.AUTH, `TRAE 换取 token 失败: ${briefBody(res.text, 300)}`, { status: 401 });
  }
  const expiresAt =
    toEpochMs(root.TokenExpireAt ?? root.tokenExpireAt, 0) ||
    now() + (expiresInToMs(root.TokenExpireDuration ?? root.ExpiresIn, 0) || 12 * 3600 * 1000);

  return {
    access_token: token,
    refresh_token: root.RefreshToken || root.refresh_token || refreshToken,
    expires_at: expiresAt
  };
}

export async function fetchUserInfo(accessToken, { uid } = {}) {
  try {
    const res = await request(`${TRAE.oauthHost}${TRAE_PATHS.userInfo}`, {
      method: 'POST',
      headers: {
        'user-agent': TRAE.userAgent,
        'x-cloudide-token': accessToken,
        accept: 'application/json'
      },
      body: { ReqSource: 'IDE', IDEVersion: TRAE.ideVersion }
    });
    const root = res.json?.Result || res.json?.result || res.json;
    if (!root) return null;
    return {
      uid: String(root.UserID ?? root.userId ?? uid ?? ''),
      screenName: root.ScreenName || root.screenName || '',
      phone: root.NonPlainTextMobile || root.phone || '',
      email: root.NonPlainTextEmail || root.email || '',
      tenantId: root.TenantID ?? root.tenantId ?? ''
    };
  } catch {
    return null; // 用户信息只是锦上添花，失败不该阻断登录
  }
}

/** 昵称：脱敏手机号 > 脱敏邮箱 > ScreenName > uid（ScreenName 是默认名，多账号分不出来） */
export function displayNickname({ phone, email, screenName, uid }) {
  return phone || email || screenName || uid || 'TRAE 账号';
}

export async function completeLogin(session, callbackUrl) {
  let q;
  try {
    q = parseCallbackQuery(callbackUrl);
  } catch {
    return { success: false, error: '回调链接格式不正确' };
  }

  const userJwt = q.userJwt ? parseUrlEncodedJson(q.userJwt) : undefined;
  const userInfo = q.userInfo ? parseUrlEncodedJson(q.userInfo) : undefined;

  const refreshToken = q.refreshToken || userJwt?.RefreshToken || userJwt?.refreshToken || '';
  if (!refreshToken) {
    if (q.code) {
      return { success: false, error: '上游已切换 PKCE 流程，本实现暂不支持（请反馈日志中的回调参数）' };
    }
    return { success: false, error: '回调链接里没有 refreshToken，请重新授权' };
  }

  const exchanged = await exchangeToken(refreshToken);
  const info = (await fetchUserInfo(exchanged.access_token, { uid: userInfo?.UserID })) || {};

  const uid = String(userInfo?.UserID ?? userJwt?.UserID ?? info.uid ?? q.userId ?? '');
  const nickname = displayNickname({
    phone: userInfo?.NonPlainTextMobile || info.phone,
    email: userInfo?.NonPlainTextEmail || info.email,
    screenName: userInfo?.ScreenName || info.screenName,
    uid
  });

  return {
    success: true,
    nickname,
    expiresAt: exchanged.expires_at,
    credential: {
      access_token: exchanged.access_token,
      refresh_token: exchanged.refresh_token,
      expires_at: exchanged.expires_at,
      uid,
      nickname,
      phone: userInfo?.NonPlainTextMobile || info.phone || '',
      email: userInfo?.NonPlainTextEmail || info.email || '',
      machine_id: session.machineId,
      device_id: session.deviceId,
      // ⚠️ 是 TenantID，不是 EnterpriseID
      enterprise_id: String(userInfo?.TenantID ?? info.tenantId ?? '')
    }
  };
}

export async function refreshCredential(cred) {
  if (!cred.refresh_token) {
    throw new OfmError(Codes.AUTH, 'TRAE 凭据没有 refresh_token，需要重新登录', { status: 401 });
  }
  const next = await exchangeToken(cred.refresh_token);
  // refreshToken 每次轮换，必须回写
  return { ...cred, ...next };
}
