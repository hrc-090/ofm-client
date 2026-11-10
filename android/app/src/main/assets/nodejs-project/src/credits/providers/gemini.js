/**
 * Gemini（Cloud Code Assist）配额窗口 —— 对齐上游 gemini-credits.ts。
 *
 * 端点（**sandbox**，不是 daily）：
 *   POST {sandbox}/v1internal:retrieveUserQuotaSummary  body {"project":"…"}
 *   POST {sandbox}/v1internal:loadCodeAssist            body '{"metadata":{"ideType":"ANTIGRAVITY"}}'
 *   sandbox = https://daily-cloudcode-pa.sandbox.googleapis.com
 *
 * ⚠️ 请求体**必须带 project**：发 {} 对部分账号会 403 SUBSCRIPTION_REQUIRED；
 *    字段名是 `project` 不是 `cloudaicompanionProject`（后者 400 Unknown name）。
 * ⚠️ 桶 id 是判据（`gemini-5h` / `gemini-weekly`），**不按 displayName 匹配**。
 * ⚠️ resetTime 无法解析 ⇒ **整条桶丢弃**（编个空串会让窗口永不过期）。
 * ⚠️ 两个桶都没认出来 ⇒ 返回 null（失败），**不伪造 100%**。
 * ⚠️ 这不是积分：面板如实显示「5 小时窗口 99% / 周窗口 99%」，
 *    **绝不换算成任何积分数字**（那是编造）。单位固定 '%'。
 * ⚠️ 档位（paidTier 优先于 currentTier）与配额并行发；档位失败不影响配额行。
 */
import { makePackage } from '../model.js';
import { roundCredits } from '../format.js';
import { isObject, responseJson } from '../read.js';

const SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const P_QUOTA = '/v1internal:retrieveUserQuotaSummary';
const P_LOAD = '/v1internal:loadCodeAssist';
// 逐字常量，content-length 恰 38
const LOAD_BODY = '{"metadata":{"ideType":"ANTIGRAVITY"}}';
const DEFAULT_PROJECT = 'aicode-consumers';
const BUCKET_5H = 'gemini-5h';
const BUCKET_WEEKLY = 'gemini-weekly';
const UNAUTHORIZED = '尚未授权 Google 账号';

/** 解析单个桶；硬约束不满足即丢弃（不编造）。 */
export function parseGeminiQuotaWindow(raw) {
  if (!isObject(raw)) return undefined;
  const bucketId = typeof raw.bucketId === 'string' ? raw.bucketId : '';
  if (bucketId === '') return undefined;
  if (typeof raw.remainingFraction !== 'number' || !Number.isFinite(raw.remainingFraction)) return undefined;
  const resetTime = typeof raw.resetTime === 'string' ? raw.resetTime : '';
  if (resetTime === '' || Number.isNaN(Date.parse(resetTime))) return undefined;
  return {
    bucketId,
    window: typeof raw.window === 'string' ? raw.window : '',
    resetTime,
    remainingFraction: raw.remainingFraction
  };
}

/** 按 bucketId 挑出两个 Gemini 桶（第三组 3p-* 属于别的产品线，忽略）。 */
export function parseGeminiQuotaWindows(payload) {
  const out = {};
  if (!isObject(payload) || !Array.isArray(payload.groups)) return out;
  for (const group of payload.groups) {
    if (!isObject(group) || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      const parsed = parseGeminiQuotaWindow(bucket);
      if (parsed === undefined) continue;
      if (parsed.bucketId === BUCKET_5H && out.fiveHour === undefined) out.fiveHour = parsed;
      if (parsed.bucketId === BUCKET_WEEKLY && out.weekly === undefined) out.weekly = parsed;
    }
  }
  return out;
}

function percentOf(w) {
  return Math.round(Math.min(1, Math.max(0, w.remainingFraction)) * 100);
}

function quotaPackage(label, w) {
  const remaining = percentOf(w);
  return makePackage({
    name: label,
    unit: '%',
    remaining,
    total: 100,
    used: 100 - remaining,
    cycleEndTime: w.resetTime
  });
}

/** 两个窗口 → CreditBalance（total 取平均，不取 min，避免把整条线误判成快用完）。 */
export function toGeminiCreditBalance(fiveHour, weekly) {
  const packages = [];
  if (fiveHour !== undefined) packages.push(quotaPackage('5 小时窗口', fiveHour));
  if (weekly !== undefined) packages.push(quotaPackage('周窗口', weekly));
  if (packages.length === 0) return { total: 0, packages: [], expiredTotal: 0 };
  const sum = packages.reduce((s, p) => s + p.remaining, 0);
  return { total: roundCredits(sum / packages.length), packages, expiredTotal: 0 };
}

/** paidTier 优先于 currentTier（两个账号的 currentTier 实测完全一样）。 */
export function parseGeminiAccountTier(payload) {
  if (!isObject(payload)) return undefined;
  const pick = (raw) => {
    if (!isObject(raw)) return undefined;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const name = typeof raw.name === 'string' ? raw.name : '';
    return id === '' && name === '' ? undefined : { id, name };
  };
  const tier = pick(payload.paidTier) ?? pick(payload.currentTier);
  if (tier === undefined) return undefined;
  const combined = `${tier.id} ${tier.name}`.toLowerCase();
  const label = combined.includes('ultra') ? 'Ultra' : combined.includes('pro') ? 'Pro' : combined.includes('free') ? 'Free' : tier.name || tier.id;
  return { ...tier, label };
}

export function createGeminiProvider(ctx) {
  const { fetcher } = ctx;

  function headers(cred) {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${cred.access_token}`,
      'User-Agent': 'GeminiCLI/1.0',
      'X-Goog-Api-Client': 'gl-node/22.0.0'
    };
  }

  async function postJson(path, cred, body) {
    try {
      const res = await fetcher(`${SANDBOX}${path}`, { method: 'POST', headers: headers(cred), body });
      return { text: await res.text(), ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, status: 0, error: e?.message || String(e) };
    }
  }

  function parseBody(r) {
    if (r.text === undefined) return undefined;
    try {
      return JSON.parse(r.text);
    } catch {
      return undefined;
    }
  }

  async function fetchStatus() {
    return null;
  }

  /** Gemini 没有签到：只有配额窗口。 */
  async function claim() {
    return { kind: 'inactive', message: 'Gemini 没有每日签到（只有 5 小时 / 周配额窗口，不是积分）' };
  }

  async function fetchBalanceDetailed(cred) {
    const token = cred.access_token ?? '';
    if (token === '') return { balance: null, error: UNAUTHORIZED };
    const project = cred.cloudaicompanionProject || DEFAULT_PROJECT;

    // 档位与配额并行；档位失败被吞成 undefined，绝不污染配额行
    const [quotaRes, tierRes] = await Promise.all([
      postJson(P_QUOTA, cred, JSON.stringify({ project })),
      postJson(P_LOAD, cred, LOAD_BODY)
    ]);

    const tier = tierRes.ok ? parseGeminiAccountTier(parseBody(tierRes)) : undefined;
    const extra = { quotaOnly: true, quotaWindows: [], ...(tier ? { tier } : {}) };

    if (!quotaRes.ok) {
      if (quotaRes.status === 0) return { balance: null, error: `配额查询网络失败：${quotaRes.error}`, extra };
      return { balance: null, error: `配额查询失败（HTTP ${quotaRes.status}）`, extra };
    }
    const payload = parseBody(quotaRes);
    if (payload === undefined) return { balance: null, error: '配额响应不是 JSON', extra };
    const { fiveHour, weekly } = parseGeminiQuotaWindows(payload);
    if (fiveHour === undefined && weekly === undefined) {
      return { balance: null, error: '配额响应里没有 Gemini 配额桶', extra };
    }
    const windows = [];
    if (fiveHour) windows.push({ label: '5 小时窗口', percent: percentOf(fiveHour), resetTime: fiveHour.resetTime });
    if (weekly) windows.push({ label: '周窗口', percent: percentOf(weekly), resetTime: weekly.resetTime });
    extra.quotaWindows = windows;
    return { balance: toGeminiCreditBalance(fiveHour, weekly), extra };
  }

  return { id: 'gemini', precheckStatus: false, fetchStatus, claim, fetchBalanceDetailed };
}
