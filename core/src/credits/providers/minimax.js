/**
 * MiniMax Code 签到面板 / 领取 / 余额 —— 对齐上游 minimax-credits.ts。
 *
 * 端点（apiHost = https://agent.minimax.cn，头只需 Bearer + Accept）：
 *   GET  /minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
 *   POST /minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   body {}
 *   GET  /minimax-cloud/api/v1/credit/details
 *
 * 四个坑：
 *  1. timezone_id 是 **query 且必填**（放头无效、非法时区名报错）；按客户端上报时区结算，不套 Qoder 的 UTC+8。
 *  2. 业务码在 base_resp.status_code（不是 code），且 invalid timezone_id 也是 HTTP 200。
 *  3. points 是总数，bonus_points 是其中「额外」部分，**不得相加**（800 vs 1200）。
 *  4. 「今日已领」= is_today && status===3，不能用「没有 Claimable」反推。
 *  5. status/claim 是信封（data 下），credit/details 是平铺（无 data）→ 有 data 对象就用它，否则用顶层。
 *  6. 余额用 remaining_amount（实测字符串 "800.00"），不是 total_count（那是记录条数）。
 */
import { emptyCheckinStatus } from '../model.js';
import { roundCredits } from '../format.js';
import { finiteNumber, looseAmount, isObject, readNumber, readString } from '../read.js';

const HOST = 'https://agent.minimax.cn';
const P_STATUS = '/minimax-cloud/api/v1/signin/status';
const P_CLAIM = '/minimax-cloud/api/v1/signin/claim';
const P_DETAILS = '/minimax-cloud/api/v1/credit/details';
const STATUS_CLAIMED = 3;
const STATUS_CLAIMABLE = 2; // 面板里的可领态（判定用不上，但保留语义）
const CLAIM_RESULT_CLAIMED = 1;
const CLAIM_RESULT_ALREADY = 2;
const PANEL_SCENES = [0, 1, 2, 3, 4];
const STATUS_VALUES = [1, 2, 3, 4];

export function resolveTimezoneId(ctx) {
  if (typeof ctx.timezoneId === 'function') return ctx.timezoneId();
  if (typeof ctx.timezoneId === 'string' && ctx.timezoneId.trim()) return ctx.timezoneId.trim();
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof z === 'string' && z.trim() ? z.trim() : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 面板硬约束解析：不满足即返回 undefined，绝不编造。 */
export function parseMinimaxSigninPanel(data) {
  if (!isObject(data)) return undefined;
  const scene = finiteNumber(data.scene);
  if (scene === undefined || !PANEL_SCENES.includes(scene)) return undefined;
  const rawDays = data.days;
  if (!Array.isArray(rawDays) || rawDays.length !== 7) return undefined;
  const days = [];
  const seen = new Set();
  let claimable = 0;
  let today = 0;
  for (const raw of rawDays) {
    if (!isObject(raw)) return undefined;
    const dayNo = finiteNumber(raw.day_no);
    const points = finiteNumber(raw.points);
    const status = finiteNumber(raw.status);
    const bonusRaw = raw.bonus_points;
    const bonus = bonusRaw === undefined ? 0 : finiteNumber(bonusRaw);
    if (dayNo === undefined || !Number.isInteger(dayNo) || dayNo < 1 || dayNo > 7) return undefined;
    if (seen.has(dayNo)) return undefined;
    if (points === undefined || points < 0) return undefined;
    if (bonus === undefined || bonus < 0) return undefined;
    if (typeof raw.is_today !== 'boolean') return undefined;
    if (status === undefined || !STATUS_VALUES.includes(status)) return undefined;
    seen.add(dayNo);
    if (status === STATUS_CLAIMABLE) claimable += 1;
    if (raw.is_today) today += 1;
    days.push({ dayNo, points, bonus, status, isToday: raw.is_today });
  }
  if (claimable > 1 || today > 1) return undefined;
  return { scene, days };
}

/** 面板 → CheckinStatus。⚠️ dailyCredit = points（800），不是 points+bonus。 */
export function panelToCheckinStatus(panel) {
  const today = panel.days.find((d) => d.isToday);
  const claimedToday = today !== undefined && today.status === STATUS_CLAIMED;
  const sorted = [...panel.days].sort((a, b) => a.dayNo - b.dayNo);
  const idx = sorted.findIndex((d) => d.isToday);
  let streakDays = 0;
  if (idx >= 0) {
    let i = sorted[idx].status === STATUS_CLAIMED ? idx : sorted[idx].status === STATUS_CLAIMABLE ? idx - 1 : -1;
    for (; i >= 0; i -= 1) {
      if (sorted[i].status !== STATUS_CLAIMED) break;
      streakDays += 1;
    }
  }
  const claimable = panel.days.find((d) => d.status === STATUS_CLAIMABLE);
  const target = today || claimable;
  return emptyCheckinStatus({
    active: true,
    todayCheckedIn: claimedToday,
    streakDays,
    dailyCredit: target?.points ?? 0,
    todayCredit: claimedToday ? (today?.points ?? 0) : 0,
    isStreakDay: (target?.bonus ?? 0) > 0,
    totalCredits: 0
  });
}

export function createMinimaxProvider(ctx) {
  const { fetcher, log } = ctx;

  function headers(cred) {
    return { accept: 'application/json', authorization: `Bearer ${cred.access_token}` };
  }
  function withTimezone(path) {
    const u = new URL(`${HOST}${path}`);
    u.searchParams.set('timezone_id', resolveTimezoneId(ctx));
    return u.toString();
  }
  /** 有 data 对象就用它，否则用顶层（credit/details 平铺）。 */
  function unwrap(payload) {
    return isObject(payload.data) ? payload.data : payload;
  }

  async function requestEnvelope(url, cred, init = {}) {
    let res;
    try {
      const h = { ...headers(cred) };
      if (init.body !== undefined) h['Content-Type'] = 'application/json';
      res = await fetcher(url, { method: init.method || 'GET', headers: h, body: init.body });
    } catch (e) {
      return { ok: false, code: -1, message: e?.message || String(e) };
    }
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        ok: false,
        code: res.status,
        message:
          res.status === 401 || res.status === 403
            ? `凭据已失效（HTTP ${res.status}），请重新登录该账号`
            : `非 JSON 响应（HTTP ${res.status}）`
      };
    }
    if (!isObject(payload)) return { ok: false, code: -1, message: '响应无法解析' };
    const base = isObject(payload.base_resp) ? payload.base_resp : {};
    const statusCode = finiteNumber(base.status_code);
    if (statusCode !== undefined && statusCode !== 0) {
      return { ok: false, code: statusCode, message: readString(base, 'status_msg') || `业务错误 ${statusCode}` };
    }
    if (!res.ok) return { ok: false, code: res.status, message: `HTTP ${res.status}` };
    return { ok: true, payload };
  }

  async function fetchStatus(cred) {
    const r = await requestEnvelope(withTimezone(P_STATUS), cred);
    if (!r.ok) return null;
    const panel = parseMinimaxSigninPanel(unwrap(r.payload));
    return panel === undefined ? null : panelToCheckinStatus(panel);
  }

  async function claim(cred) {
    const r = await requestEnvelope(withTimezone(P_CLAIM), cred, { method: 'POST', body: '{}' });
    if (!r.ok) return { kind: 'failed', code: r.code, message: r.message };
    const data = unwrap(r.payload);
    const claimResult = finiteNumber(data.claim_result);
    if (claimResult === CLAIM_RESULT_ALREADY) return { kind: 'already-claimed', message: '今日已签到' };
    if (claimResult !== CLAIM_RESULT_CLAIMED) {
      return { kind: 'failed', code: -1, message: '签到响应缺少有效的 claim_result' };
    }
    const points = finiteNumber(data.points) ?? 0;
    const panel = parseMinimaxSigninPanel(data.panel);
    const status = panel === undefined ? undefined : panelToCheckinStatus(panel);
    return {
      kind: 'claimed',
      credit: points, // 已含 bonus_points，不相加
      streakDays: status?.streakDays ?? 0,
      isStreakDay: status?.isStreakDay ?? false
    };
  }

  async function fetchBalance(cred) {
    const r = await requestEnvelope(`${HOST}${P_DETAILS}`, cred);
    if (!r.ok) return { balance: null, error: r.message };
    const data = unwrap(r.payload);
    const details = Array.isArray(data.details) ? data.details : undefined;
    const totalCount = finiteNumber(data.total_count);
    if (details === undefined && totalCount === undefined) return { balance: null, error: '余额响应形状不符' };
    let total = 0;
    for (const entry of details || []) {
      if (!isObject(entry)) continue;
      const remaining = looseAmount(entry.remaining_amount);
      if (remaining !== undefined) total += remaining;
    }
    return { balance: { total: roundCredits(total), packages: [], expiredTotal: 0 } };
  }

  return { id: 'minimax', precheckStatus: true, fetchStatus, claim, fetchBalance };
}
