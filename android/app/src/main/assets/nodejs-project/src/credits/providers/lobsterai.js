/**
 * LobsterAI（有道）每日签到与余额 —— 对齐上游 lobsterai-credits.ts。
 *
 * 三步（clientVersion 是必填参数，带缓存，兜底 '2026.9.4'）：
 *   1) GET  /api/client-activities/slot?placement=desktop_sidebar&clientVersion=…&containerApiVersion=2&platform=win32
 *   2) GET  /api/client-activities/{activityCode}/context?configRevision=n
 *   3) POST /api/client-activities/{activityCode}/actions/check_in  {configRevision, idempotencyKey, payload:{}}
 *   余额 GET /api/user/profile-summary（不是 /api/user/quota）
 *
 * 判定顺序：slot 失败→failed；slotState!=='available'→inactive；context 失败→failed；
 *          claimedToday→already-claimed；actions 不含 check_in→inactive；check_in 失败→failed；成功→claimed。
 * ⚠️ 没有独立签到状态端点 ⇒ fetchStatus 恒 null（precheckStatus:false），判定全收敛在 claim 内部。
 * ⚠️ 积分三级回退 creditsGranted → rewardCredits → credits。
 */
import crypto from 'node:crypto';
import { makePackage } from '../model.js';
import { roundCredits } from '../format.js';
import { readNumber, readString, isObject, responseJson } from '../read.js';

const API = 'https://lobsterai-server.youdao.com';
const CLIENT_VERSION_API = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update';
const FALLBACK_CLIENT_VERSION = '2026.9.4';
const SLOT = '/api/client-activities/slot';
const ACTIVITY = '/api/client-activities';
const PROFILE = '/api/user/profile-summary';

export function createLobsteraiProvider(ctx) {
  const { fetcher, log } = ctx;
  let versionCache; // Promise<string>

  function headers(cred) {
    return {
      'X-LobsterAI-Client-Capabilities': 'kimi-k3-agentic-v1,thinking-level-control-v1',
      'X-LobsterAI-Client-Version': '0.1.0',
      'user-agent': 'LobsterAI/0.1.0',
      accept: 'application/json',
      authorization: `Bearer ${cred.access_token}`
    };
  }

  async function clientVersion() {
    if (!versionCache) {
      versionCache = (async () => {
        try {
          const res = await fetcher(CLIENT_VERSION_API, { method: 'GET' });
          const body = await responseJson(res);
          const v = body?.data?.value?.version;
          return typeof v === 'string' && v.trim() ? v.trim() : FALLBACK_CLIENT_VERSION;
        } catch {
          return FALLBACK_CLIENT_VERSION; // 取不到也别放弃签到
        }
      })();
    }
    return versionCache;
  }

  async function getJson(url, cred, init = {}) {
    try {
      const res = await fetcher(url, {
        method: init.method || 'GET',
        headers: { ...headers(cred), ...(init.headers || {}) },
        body: init.body
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, message: `非 JSON 响应（HTTP ${res.status}）` };
      }
      if (!isObject(parsed)) return { ok: false, message: '响应无法解析' };
      // 信封：code===0 视为成功，data 在 body.data
      const code = parsed.code;
      if (code !== undefined && Number(code) !== 0) {
        return { ok: false, message: readString(parsed, 'message') || `信封 code=${code}` };
      }
      const data = isObject(parsed.data) ? parsed.data : {};
      return { ok: true, data };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  }

  async function fetchStatus() {
    return null; // LobsterAI 没有独立签到状态端点，不臆造
  }

  async function claim(cred) {
    const version = await clientVersion();
    const slotQ = new URLSearchParams({
      placement: 'desktop_sidebar',
      clientVersion: version,
      containerApiVersion: '2',
      platform: 'win32'
    }).toString();
    const slotRes = await getJson(`${API}${SLOT}?${slotQ}`, cred);
    if (!slotRes.ok) return { kind: 'failed', code: -1, message: '活动槽位查询失败' };
    const activity = isObject(slotRes.data.activity) ? slotRes.data.activity : {};
    const slotState = readString(slotRes.data, 'slotState');
    const activityCode = readString(activity, 'activityCode');
    const configRevision = readNumber(activity, 'configRevision');
    if (slotState !== 'available' || !activityCode) {
      return { kind: 'inactive', message: `无可用活动（slotState=${slotState}）` };
    }

    const ctxRes = await getJson(`${API}${ACTIVITY}/${encodeURIComponent(activityCode)}/context?configRevision=${configRevision}`, cred);
    if (!ctxRes.ok) return { kind: 'failed', code: -1, message: '活动上下文查询失败' };
    const state = isObject(ctxRes.data.state) ? ctxRes.data.state : {};
    if (state.claimedToday === true) return { kind: 'already-claimed', message: '今天已签到' };
    const actions = Array.isArray(ctxRes.data.actions) ? ctxRes.data.actions.filter((a) => typeof a === 'string') : [];
    if (!actions.includes('check_in')) return { kind: 'inactive', message: '当前不可签到' };

    const postRes = await getJson(`${API}${ACTIVITY}/${encodeURIComponent(activityCode)}/actions/check_in`, cred, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ configRevision, idempotencyKey: crypto.randomUUID(), payload: {} })
    });
    if (!postRes.ok) return { kind: 'failed', code: -1, message: postRes.message };
    const result = isObject(postRes.data.result) ? postRes.data.result : {};
    let credit = 0;
    for (const key of ['creditsGranted', 'rewardCredits', 'credits']) {
      if (typeof result[key] === 'number' && Number.isFinite(result[key])) {
        credit = result[key];
        break;
      }
    }
    const delayedMessage = readString(result, 'message');
    return {
      kind: 'claimed',
      credit,
      streakDays: 0,
      isStreakDay: false,
      ...(delayedMessage ? { delayedMessage } : {})
    };
  }

  async function fetchBalance(cred) {
    const res = await getJson(`${API}${PROFILE}`, cred);
    if (!res.ok) return { balance: null, error: res.message };
    const packages = [];
    const items = Array.isArray(res.data.creditItems) ? res.data.creditItems : [];
    for (const item of items) {
      if (!isObject(item)) continue;
      const remaining = readNumber(item, 'creditsRemaining');
      const label = readString(item, 'label');
      const type = readString(item, 'type');
      const expiresAt = readString(item, 'expiresAt');
      const expMs = expiresAt ? Date.parse(expiresAt.replace(' ', 'T')) : NaN;
      const active = !(expiresAt && Number.isFinite(expMs) && Date.now() >= expMs);
      packages.push(
        makePackage({
          name: label || type || '积分包',
          unit: 'credit',
          remaining,
          total: 0, // 服务端不给面值，下面按同组最大值推断
          used: 0,
          active,
          expiredTime: expiresAt,
          deductionEndTime: Number.isFinite(expMs) ? expMs : undefined
        })
      );
    }
    // 面值推断：同组（label）有效包剩余量的最大值当面值（100/100 而非 100/0）
    const faceByGroup = new Map();
    for (const p of packages) {
      if (!p.active) continue;
      faceByGroup.set(p.name, Math.max(faceByGroup.get(p.name) ?? 0, p.remaining));
    }
    for (const p of packages) {
      const face = faceByGroup.get(p.name);
      if (face !== undefined && face > 0) {
        p.total = roundCredits(face);
        if (p.used <= 0) p.used = roundCredits(Math.max(0, face - p.remaining));
      }
    }
    const total = roundCredits(Math.max(0, readNumber(res.data, 'totalCreditsRemaining')));
    if (total === 0 && packages.length === 0) return { balance: null, error: '余额查询失败' };
    const expiredTotal = roundCredits(packages.reduce((s, p) => s + (p.active ? 0 : Math.max(0, p.remaining)), 0));
    return { balance: { total, packages, expiredTotal } };
  }

  return { id: 'lobsterai', precheckStatus: false, fetchStatus, claim, fetchBalance };
}
