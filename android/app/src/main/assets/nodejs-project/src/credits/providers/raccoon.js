/**
 * Raccoon（商汤）余额 + 一次性「桌面端登录奖励」—— 对齐上游 raccoon-credits.ts。
 *
 * 端点（apiBase = https://xiaohuanxiong.com）：
 *   GET  /api/web/points/v1/balance                          只读（余额）
 *   GET  /api/web/points/v1/bills?paging.limit=50&paging.offset=0  只读（查是否已领）
 *   POST /api/web/desktop/v1/login/points/grant             写（一次性奖励）
 *
 * ⚠️ **没有每日签到**：每日 300 由服务端 daily_grant 自动发放，没有可调用端点。
 *    本 provider 的 claim 是「新手任务」（onboardingTasks），不是 dailyCheckin。
 * ⚠️ 幂等判据 `granted`（重复领取同样 200 + granted:false）⇒ already-claimed。
 * ⚠️ 「是否已领」只能查账单：biz_type==='reward_grant' **且**
 *    event_name==='桌面端登录奖励'（只按 biz_type 判会把新人注册礼包算进去）。
 *    查询失败保守返回 claimed:false（宁可多点一次，服务端幂等）。
 * ⚠️ X-Client-Platform: desktop-windows 必需（标识来自桌面端）。
 * ⚠️ 余额只读端点绝不碰写端点（Loomy first-login 踩过坑）。
 */
import { makePackage } from '../model.js';
import { isObject, responseJson, looseAmount } from '../read.js';

const API = 'https://xiaohuanxiong.com';
const P_BALANCE = '/api/web/points/v1/balance';
const P_BILLS = '/api/web/points/v1/bills?paging.limit=50&paging.offset=0';
const P_GRANT = '/api/web/desktop/v1/login/points/grant';
export const RACCOON_LOGIN_REWARD_POINTS = 3000;
export const RACCOON_LOGIN_REWARD_EVENT_NAME = '桌面端登录奖励';

export function parseRaccoonEnvelope(payload, status) {
  const record = isObject(payload) ? payload : {};
  const code = typeof record.code === 'number' ? record.code : status >= 400 ? status : 0;
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : typeof record.details === 'string'
        ? record.details
        : '';
  const data = isObject(record.data) ? record.data : undefined;
  return { ok: code === 0, code, message, data };
}

export function createRaccoonProvider(ctx) {
  const { fetcher } = ctx;

  function headers(cred) {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cred.access_token}`,
      'X-Org-Code': cred.office_identity ?? '',
      'X-Raccoon-Language': 'zh',
      // 必需：标识「来自桌面端」，缺了会被拒
      'X-Client-Platform': 'desktop-windows'
    };
  }

  /** 发一次业务请求并拆信封。不抛错（批量时单账号失败不中断）。 */
  async function requestJson(url, cred, init = {}) {
    try {
      const res = await fetcher(url, {
        method: init.method || 'GET',
        headers: headers(cred),
        ...(init.body !== undefined ? { body: init.body } : {})
      });
      return parseRaccoonEnvelope(await responseJson(res), res.status);
    } catch (e) {
      return { ok: false, code: -1, message: e?.message || String(e), data: undefined };
    }
  }

  async function fetchStatus() {
    return null; // 无每日签到状态端点
  }

  /** 一次性领取。⚠️ 属新手任务，自动签到不会调到它。 */
  async function claim(cred) {
    const r = await requestJson(`${API}${P_GRANT}`, cred, { method: 'POST', body: '{}' });
    if (!r.ok) {
      return { kind: 'failed', code: r.code, message: r.message || '领取登录奖励失败' };
    }
    if (r.data?.granted !== true) {
      return { kind: 'already-claimed', message: '该账号已领取过桌面端登录奖励（每号一次）' };
    }
    const popup = isObject(r.data.popup) ? r.data.popup : {};
    const points = looseAmount(popup.points) ?? RACCOON_LOGIN_REWARD_POINTS;
    return { kind: 'claimed', credit: points, streakDays: 0, isStreakDay: false };
  }

  /** 查账单判是否已领（供 UI「新手任务」显示已领）。失败保守 false。 */
  async function fetchOnboardingStatus(cred) {
    const r = await requestJson(`${API}${P_BILLS}`, cred);
    if (!r.ok || r.data === undefined) {
      return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS };
    }
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    for (const raw of items) {
      if (!isObject(raw)) continue;
      if (raw.biz_type !== 'reward_grant') continue;
      if (raw.event_name !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue;
      const p = looseAmount(raw.points);
      return { claimed: true, points: p !== undefined && p > 0 ? p : RACCOON_LOGIN_REWARD_POINTS };
    }
    return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS };
  }

  /** 余额：available_points 是核心字段；各池独立成包（有效期/回补规则不同）。 */
  async function fetchBalance(cred) {
    const r = await requestJson(`${API}${P_BALANCE}`, cred);
    if (!r.ok || r.data === undefined) return { balance: null, error: r.message || '余额查询失败' };
    const available = looseAmount(r.data.available_points);
    if (available === undefined) return { balance: null, error: '余额响应缺少 available_points' };
    const mk = (name, v) => makePackage({ name, unit: '积分', remaining: v, total: v, used: 0 });
    const packages = [];
    for (const [key, name] of [
      ['reward_points', '奖励积分'],
      ['daily_points', '每日积分'],
      ['monthly_points', '会员积分'],
      ['topup_points', '充值积分']
    ]) {
      const v = looseAmount(r.data[key]);
      if (v !== undefined && (key !== 'monthly_points' || v > 0)) packages.push(mk(name, v));
    }
    if (packages.length === 0) packages.push(mk('可用积分', available));
    return { balance: { total: available, packages, expiredTotal: 0 } };
  }

  return { id: 'raccoon', precheckStatus: false, fetchStatus, claim, fetchBalance, fetchOnboardingStatus };
}
