/**
 * Loomy 每日额度重置与余额 —— 对齐上游 loomy-credits.ts。
 *
 * 端点：
 *   POST /points/first-login                                   // 写（签到）
 *   GET  /points/records?pageNo=1&pageSize=1&recordType=all     // 只读（余额）
 *
 * ⚠️ 语义是「每日额度重置」，不是「+5000 积分」：dailyBalance = dailyQuota - dailyConsumed，消耗后不回补。
 * ⚠️ 只读路径绝不碰写端点：打开面板调 first-login 会**意外触发签到**。
 * ⚠️ 幂等判据是响应体 alreadyProcessed（重复调用同样 HTTP 200）→ 映射 already-claimed，不是 claimed。
 * ⚠️ dailyQuota 只在 first-login 响应里，records 不返回它 ⇒ 不硬编码 5000。
 * ⚠️ 头只用小写 token，不加 Authorization。业务失败恒 HTTP 200，成败只能读 body.code（'000000'）。
 */
import { makePackage } from '../model.js';
import { readNumber, isObject, responseJson } from '../read.js';

const API = 'https://loomyad.xunfei.cn/api/v1';
const OK_CODE = '000000';
const RECORDS = '/points/records?pageNo=1&pageSize=1&recordType=all';
const FIRST_LOGIN = '/points/first-login';

export function createLoomyProvider(ctx) {
  const { fetcher } = ctx;

  async function loomyRequest(cred, path, init = {}) {
    const headers = { Accept: 'application/json', token: cred.access_token };
    let body;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    let res;
    try {
      res = await fetcher(`${API}${path}`, { method: init.method || 'GET', headers, body });
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
    const payload = await responseJson(res);
    if (!isObject(payload)) return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` };
    const code = typeof payload.code === 'string' ? payload.code : '';
    if (code !== OK_CODE) {
      const message = typeof payload.desc === 'string' && payload.desc ? payload.desc : typeof payload.message === 'string' ? payload.message : '';
      return { ok: false, message: message || `业务错误 ${code || '(缺少 code)'}` };
    }
    return { ok: true, data: isObject(payload.data) ? payload.data : {} };
  }

  async function fetchStatus() {
    return null; // 无独立签到状态端点
  }

  async function claim(cred) {
    const r = await loomyRequest(cred, FIRST_LOGIN, { method: 'POST', body: {} });
    if (!r.ok) return { kind: 'failed', code: -1, message: r.message };
    const dailyQuota = readNumberOrUndef(r.data, 'dailyQuota');
    const dailyBalance = readNumberOrUndef(r.data, 'dailyBalance');
    if (r.data.alreadyProcessed === true) {
      return {
        kind: 'already-claimed',
        message:
          dailyQuota === undefined
            ? '今日额度已初始化'
            : `今日额度已初始化（每日 ${dailyBalance ?? 0}/${dailyQuota}）`
      };
    }
    // 首次处理：credit = dailyQuota - dailyConsumed（服务端不给差值，本地推算；缺则回 0，不编造）
    const dailyConsumed = readNumberOrUndef(r.data, 'dailyConsumed');
    const granted =
      dailyQuota !== undefined && dailyConsumed !== undefined
        ? Math.max(0, dailyQuota - dailyConsumed)
        : (dailyQuota ?? 0);
    return { kind: 'claimed', credit: granted, streakDays: 0, isStreakDay: false };
  }

  async function fetchBalance(cred) {
    const r = await loomyRequest(cred, RECORDS); // 只读，绝不碰 first-login
    if (!r.ok) return { balance: null, error: r.message };
    const permanent = readNumberOrUndef(r.data, 'balance');
    if (permanent === undefined) return { balance: null, error: '余额响应缺少 balance' };
    const daily = readNumberOrUndef(r.data, 'dailyBalance') ?? 0;
    const available = readNumberOrUndef(r.data, 'availableBalance');
    const total = available ?? permanent + daily;
    const mk = (name, remaining) =>
      makePackage({ name, unit: '积分', remaining, total: remaining, used: 0 });
    return {
      balance: {
        total,
        packages: [mk('永久积分', permanent), mk('每日赠送', daily)],
        expiredTotal: 0
      }
    };
  }

  return { id: 'loomy', precheckStatus: false, fetchStatus, claim, fetchBalance };
}

function readNumberOrUndef(obj, key) {
  if (!isObject(obj)) return undefined;
  const v = obj[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
