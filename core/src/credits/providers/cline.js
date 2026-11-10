/**
 * Cline 余额查询 —— 对齐上游 cline-credits.ts。
 *
 * 端点：GET {apiBase}/api/v1/users/{userId}/balance
 *   apiBase = 'https://api.cline.bot'
 *   ⚠️ userId 用 credential.account_id（`usr-…`），**不是** JWT 的 sub（`user_…`）
 *      —— 用 sub 会 400 {"error":"Invalid request format"}。
 *   ⚠️ Authorization 必须**原样保留 `workos:` 前缀**，剥掉即 401，
 *      且报错文案是 "make sure you're using the latest version of Cline"（与真因毫不相干）。
 *
 * ⚠️ 余额单位不确定：实测 balance: 500000，推测 micro-USD（÷100000 → $5.00）。
 *    系数收敛成单个具名常量 CLINE_BALANCE_SCALE，并把原始值一并返回供核对；
 *    **不要**用 /usages 的 costUsd 反推（两者口径不同，不可互推）。
 * ⚠️ 失败形态两种都要认：{success:false,error}（HTTP 200）与
 *    {error}（网关层 HTTP 401，**没有 success 字段**）。
 *
 * 签到：**不存在** —— 对整个 sidecar 做字符串扫描，checkin / daily / campaign
 * 零命中。claim 直接返回可读的 inactive，UI 不给按钮。
 */
import { makePackage } from '../model.js';
import { roundCredits } from '../format.js';
import { isObject, looseAmount, responseJson } from '../read.js';

const API = 'https://api.cline.bot';
export const CLINE_BALANCE_SCALE = 100_000;
const CLIENT_HEADERS = {
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk'
};

/** 解析余额响应；失败返回 error，绝不把「查不到」当成 0。 */
export function parseClineBalanceResponse(payload) {
  if (!isObject(payload)) return { error: '响应不是 JSON 对象' };
  const serverError =
    typeof payload.error === 'string' && payload.error.trim().length > 0 ? payload.error.trim() : undefined;
  // HTTP 401 的响应体没有 success 字段，只在 error 里说明原因
  if (payload.success === false || (serverError !== undefined && payload.success !== true)) {
    return { error: serverError ?? '服务端返回失败' };
  }
  const data = isObject(payload.data) ? payload.data : undefined;
  if (data === undefined) return { error: '响应缺少 data 字段' };
  const raw = looseAmount(data.balance);
  if (raw === undefined) return { error: '响应缺少 balance 字段' };
  return { rawBalance: raw };
}

export function toClineCreditBalance(rawBalance) {
  const total = roundCredits(rawBalance / CLINE_BALANCE_SCALE);
  return {
    total,
    packages: [makePackage({ name: 'Cline 账户余额', unit: 'USD', remaining: total, total, used: 0 })],
    expiredTotal: 0
  };
}

export function createClineProvider(ctx) {
  const { fetcher } = ctx;

  async function fetchStatus() {
    return null;
  }

  /** Cline 没有签到接口：返回可读 inactive（自动签到据此判 skipped）。 */
  async function claim() {
    return { kind: 'inactive', message: 'Cline 不支持每日签到（其后端没有签到接口）' };
  }

  async function fetchBalanceDetailed(cred) {
    const userId = cred.account_id;
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      return { balance: null, error: '凭据缺少账号 id（account_id），无法查询余额' };
    }
    const url = `${API}/api/v1/users/${encodeURIComponent(userId.trim())}/balance`;
    let res;
    try {
      res = await fetcher(url, {
        method: 'GET',
        headers: { ...CLIENT_HEADERS, Accept: 'application/json', Authorization: `Bearer ${cred.access_token}` }
      });
    } catch (e) {
      return { balance: null, error: `余额查询网络失败：${e?.message || String(e)}` };
    }
    const payload = await responseJson(res);
    const parsed = parseClineBalanceResponse(payload);
    if (parsed.rawBalance === undefined) {
      const detail = parsed.error ? `：${parsed.error}` : '';
      return {
        balance: null,
        error: res.ok ? parsed.error || '余额响应形状不符' : `余额查询失败（HTTP ${res.status}）${detail}`
      };
    }
    return {
      balance: toClineCreditBalance(parsed.rawBalance),
      extra: { rawBalance: parsed.rawBalance, scale: CLINE_BALANCE_SCALE }
    };
  }

  return { id: 'cline', precheckStatus: false, fetchStatus, claim, fetchBalanceDetailed };
}
