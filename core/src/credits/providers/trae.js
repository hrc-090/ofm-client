/**
 * TRAE 每日签到与积分余额 —— 对齐上游 trae-credits.ts。
 *
 * 端点（独立域名 api.trae.cn，与推理用的 agentHost 不是一回事）：
 *   POST /trae/api/v2/ug/checkin_credits/status   body {}
 *   POST /trae/api/v2/ug/checkin_credits/claim    body {}
 *   POST /trae/api/v2/pay/ide_user_ent_usage      body {require_usage:true,req_source:2}
 *
 * 关键坑：
 *  1. 约 20 个客户端头；设备身份由 uid **确定性派生**（每账号一台独立设备）。
 *  2. claim 响应不含积分数（只有 {code:0}）→ 成功后**补查 status.credits**。
 *  3. claim 对「今天已签」幂等且无法区分 → 靠状态预检（precheckStatus）。
 *  4. 业务码认字符串形态（"9074"）；9074 = 签到人数过多，不换设备重试。
 *  5. 只对网络异常重试，最多 3 次、间隔 1s；业务码不重试。
 */
import crypto from 'node:crypto';
import { TRAE } from '../../channels/trae/product.js';
import { makePackage, emptyCheckinStatus } from '../model.js';
import { readCode, readNumber, readString, isObject, responseJson } from '../read.js';
import { sleep } from '../../util.js';

const HOST = 'https://api.trae.cn';
const P_STATUS = '/trae/api/v2/ug/checkin_credits/status';
const P_CLAIM = '/trae/api/v2/ug/checkin_credits/claim';
const P_USAGE = '/trae/api/v2/pay/ide_user_ent_usage';

// ── 设备身份：sha256("<salt>:<uid>" + 4 字节大端计数器) 逐块输出 ──
function seededStream(seed, salt, nbytes) {
  const prefix = `${salt}:${seed}`;
  const out = [];
  let counter = 0;
  while (out.length < nbytes) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter >>> 0, 0);
    const h = crypto.createHash('sha256').update(prefix, 'utf8').update(c).digest();
    for (const b of h) {
      out.push(b);
      if (out.length >= nbytes) break;
    }
    counter += 1;
  }
  return out.slice(0, nbytes);
}
function deriveDeviceId15(uid) {
  return seededStream(uid, 'devid', 15).map((b) => String(b % 10)).join('');
}
function deriveMarketUserId(uid) {
  const bs = seededStream(uid, 'market', 16);
  bs[6] = (bs[6] & 0x0f) | 0x40;
  bs[8] = (bs[8] & 0x3f) | 0x80;
  const hex = bs.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function deriveSessionId(uid) {
  return seededStream(uid, 'sess', 32).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function checkinHeaders(cred) {
  const uid = String(cred.uid || '');
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': 'zh-CN',
    'User-Agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    Authorization: `Cloud-IDE-JWT ${cred.access_token}`,
    'X-Market-Client-Id': 'VSCode 1.107.1',
    'X-Market-User-Id': deriveMarketUserId(uid),
    'X-User-Region': 'CN',
    'X-Device-Id': deriveDeviceId15(uid),
    'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': 'stable_cn',
    'X-Lscbd-Aid': '787976',
    'X-Lscbd-Platform': 'windows',
    'App-Version': TRAE.ideVersion,
    'X-Tt-Trace-Id': `00-${crypto.randomBytes(8).toString('hex')}-01`,
    'Vscode-Sessionid': deriveSessionId(uid),
    'X-Request-Id': crypto.randomUUID(),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'none'
  };
}

/** 错误分类与冷却（对齐 classifyTraeCheckinError）。 */
export function classifyTraeCheckinError(httpStatus, code) {
  if (httpStatus === 200 && code === 1005) return { type: 'PlanLimit', cooldownSecs: 43200 };
  if (httpStatus === 429) return { type: 'SoftRate', cooldownSecs: 60 };
  if (httpStatus === 401) return { type: 'SessionDead', cooldownSecs: -1 };
  if (httpStatus === 404) return { type: 'NotFound', cooldownSecs: 60 };
  if (httpStatus >= 500 && httpStatus < 600) return { type: 'Server', cooldownSecs: 600 };
  if (httpStatus >= 400 && httpStatus < 500) return { type: 'Client', cooldownSecs: 600 };
  if (code !== undefined && code !== 0) return { type: 'BusinessError', cooldownSecs: 300 };
  return { type: 'Unknown', cooldownSecs: 0 };
}

/** 错误文案里的一小段响应样本（压平换行、限长），便于区分 HTML / 空响应 / 乱码。 */
function briefText(text, limit = 60) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '空响应';
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/** 错误文案统一带上 HTTP 状态与 content-type，别再只回一句「非 JSON 响应」。 */
function describeBody(res, text) {
  const type = String(res.headers?.get?.('content-type') || '').split(';')[0].trim();
  const size = String(text || '').length;
  return `HTTP ${res.status}${type ? `，${type}` : ''}，${size} 字符`;
}

export function createTraeProvider(ctx) {
  const { fetcher, log } = ctx;
  const warn = (m) => log?.warn?.(m);

  async function post(path, cred, body) {
    const uid = String(cred.uid || '');
    if (!uid) return { ok: false, httpStatus: 0, message: '缺少 uid，无法构造设备身份' };
    // 只对网络异常重试；业务码（HTTP 有响应）不重试
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetcher(`${HOST}${path}`, {
          method: 'POST',
          headers: checkinHeaders(cred),
          body
        });
        const text = await res.text();
        if (!res.ok) {
          return { ok: false, httpStatus: res.status, message: `HTTP ${res.status}: ${text.trim().slice(0, 80)}` };
        }
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // 以前只回「非 JSON 响应」，真机上完全看不出是压缩乱码、HTML 拦截页还是空体
          return {
            ok: false,
            httpStatus: res.status,
            message: `非 JSON 响应（${describeBody(res, text)}）：${briefText(text)}`
          };
        }
        if (!isObject(parsed)) return { ok: false, httpStatus: res.status, message: '响应不是对象' };
        return { ok: true, httpStatus: res.status, body: parsed };
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await sleep(1000);
      }
    }
    return { ok: false, httpStatus: 0, message: lastErr?.message || '网络失败' };
  }

  async function fetchStatus(cred) {
    const r = await post(P_STATUS, cred, '{}');
    if (!r.ok || readCode(r.body) !== 0) return null;
    return emptyCheckinStatus({
      active: r.body.enable === true,
      todayCheckedIn: r.body.checked_in === true,
      streakDays: readNumber(r.body, 'streak_days'),
      dailyCredit: readNumber(r.body, 'credits'),
      todayCredit: 0,
      totalCredits: readNumber(r.body, 'total_credits')
    });
  }

  async function claim(cred) {
    const r = await post(P_CLAIM, cred, '{}');
    if (!r.ok) return { kind: 'failed', code: -1, message: r.message };
    const code = readCode(r.body);
    const msg = readString(r.body, 'message') || readString(r.body, 'msg');
    if (code === 9074) {
      // 上游已废弃「9074 换设备号重试」；账号已由 uid 派生独立设备，直接失败 + 300s 冷却
      return { kind: 'failed', code: 9074, message: msg || '签到人数过多，请稍后再试' };
    }
    if (code === 0) {
      // claim 响应不含积分数 → 补查 status.credits（实测 150）
      const status = await fetchStatus(cred);
      return {
        kind: 'claimed',
        credit: status?.dailyCredit ?? 0,
        streakDays: status?.streakDays ?? 0,
        isStreakDay: false
      };
    }
    const { type } = classifyTraeCheckinError(r.httpStatus, code);
    return { kind: 'failed', code, message: msg || `签到失败（code=${code}）`, detail: type };
  }

  async function fetchBalance(cred) {
    const r = await post(P_USAGE, cred, JSON.stringify({ require_usage: true, req_source: 2 }));
    if (!r.ok) return { balance: null, error: r.message };
    const list = r.body.user_entitlement_pack_list;
    if (!Array.isArray(list) || list.length === 0) return { balance: null, error: '余额响应缺少资源包' };
    const packages = [];
    let total = 0;
    for (const item of list) {
      if (!isObject(item)) continue;
      const base = item.entitlement_base_info;
      const quota = isObject(base) ? base.quota : undefined;
      const limit = isObject(quota) ? readNumber(quota, 'credits_limit') : 0;
      if (limit <= 0) continue;
      const usage = isObject(item.usage) ? readNumber(item.usage, 'credits_amount') : 0;
      // 条目级 expire_time 是**秒**级，×1000；拿不到就不设（UI 显示「永久」）
      const expireSec = readNumber(item, 'expire_time');
      const pkg = makePackage({
        name: (isObject(base) ? readString(base, 'display_desc') : '') || readString(item, 'display_desc') || '资源包',
        unit: 'credits',
        remaining: limit - usage,
        total: limit,
        used: usage,
        deductionEndTime: expireSec > 0 ? expireSec * 1000 : undefined
      });
      packages.push(pkg);
      total += pkg.remaining;
    }
    if (packages.length === 0) return { balance: null, error: '余额响应形状不符' };
    return { balance: { total, packages, expiredTotal: 0 } };
  }

  return { id: 'trae', precheckStatus: true, fetchStatus, claim, fetchBalance };
}
