/**
 * ZCode（智谱）每日 plan 领取与余额 —— 对齐上游 zcode-upstream.ts / zcode-diagnostics.ts。
 *
 * 端点（origin = https://zcode.z.ai）：
 *   POST /api/v1/event/report                                   → 补激活信号（否则 preview 恒空）
 *   GET  /api/v1/zcode-plan/billing/preview?app_version=…&platform=win32
 *   POST /api/v1/zcode-plan/billing/claim   {plan_id} + captcha 头
 *   GET  /api/v1/zcode-plan/billing/balance
 *
 * ⚠️ 自动签到排除该渠道（captcha 有设备级代价），但**手动领取完整实现**。
 * ⚠️ 额度不在 balance 桶里，plan.entitlements[0].grant_units 才是额度；unit_type:'token'。
 * ⚠️ 每次领取现产一个 captcha param（一次性，复用必 3007）。
 *     Android 上跑不了 headful 阿里云 SDK ⇒ captcha 做成 Pluggable：
 *     ctx.mintCaptcha(config) 注入；没注入时明确返回 inactive（不假装成功、不自造 token）。
 *
 * 业务码：0 成功 / 1003 已领（幂等成功）/ 3007 captcha 失败 /
 *         3012 风控（「请勿连续重试」+ 短路后续 plan）/ 其它失败。
 * ⚠️ code 要认纯数字字符串 "3012"；code 缺失时才扫正文，判据必须是语义短语
 *    （unusual activity|blocked due to），不能只看裸数字 —— 限流正文 "retry after 3012 ms"
 *    会被误判，两者用户动作相反。
 */
import { makePackage } from '../model.js';
import { readNumber, readString, isObject, looseAmount, finiteNumber, responseJson } from '../read.js';

const ORIGIN = 'https://zcode.z.ai';
const P_REPORT = '/api/v1/event/report';
const P_PREVIEW = '/api/v1/zcode-plan/billing/preview';
const P_CLAIM = '/api/v1/zcode-plan/billing/claim';
const P_BALANCE = '/api/v1/zcode-plan/billing/balance';

/** 纯数字字符串业务码（认 "3012"，不认 "13012"）。 */
export function parseZcodeBusinessCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}
/** 语义短语判风控，且 code 缺失时才用。排除 "retry after 3012 ms" 这类限流。 */
export function mentionsUnusualActivity(text) {
  return /unusual activity|blocked due to/i.test(String(text || ''));
}

export function createZcodeProvider(ctx) {
  const { fetcher, log } = ctx;

  function baseHeaders(cred, { authorization = false, captcha } = {}) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-ZCode-App-Version': cred.app_version || '3.14.3',
      'X-Release-Channel': 'stable',
      'X-Client-Language': 'zh-CN',
      'X-Client-Timezone': 'Asia/Shanghai',
      'X-Device-Mid': cred.device_mid || '',
      'X-Platform': 'win32',
      'X-Os-Category': 'windows'
    };
    if (authorization) h.Authorization = `Bearer ${cred.zcode_jwt || cred.access_token}`;
    if (captcha) {
      h['x-aliyun-captcha-verify-param'] = captcha.param;
      h['x-aliyun-captcha-verify-region'] = captcha.region;
    }
    return h;
  }

  async function getJson(url, cred, init = {}) {
    try {
      const res = await fetcher(url, { method: init.method || 'GET', headers: baseHeaders(cred, init), body: init.body });
      return await responseJson(res);
    } catch {
      return null;
    }
  }

  /** 补两条激活事件（幂等，按 device_mid + 日期去重）。 */
  async function reportActivation(cred) {
    for (const event of ['app_launch', 'app_daily_active']) {
      try {
        await fetcher(`${ORIGIN}${P_REPORT}`, {
          method: 'POST',
          headers: baseHeaders(cred),
          body: JSON.stringify({
            event,
            device_mid: cred.device_mid,
            platform: 'win32',
            app_version: cred.app_version || '3.14.3'
          })
        });
      } catch {
        /* 事件上报失败不阻断后续 */
      }
    }
  }

  /** 拉可领 plan（entitlements[0].grant_units 是额度，priority 降序）。 */
  async function fetchPlans(cred) {
    await reportActivation(cred);
    const q = new URLSearchParams({ app_version: cred.app_version || '3.14.3', platform: 'win32' }).toString();
    const body = await getJson(`${ORIGIN}${P_PREVIEW}?${q}`, cred);
    const raw = isObject(body) && isObject(body.data) && Array.isArray(body.data.plans) ? body.data.plans : [];
    const plans = [];
    for (const item of raw) {
      if (!isObject(item) || typeof item.plan_id !== 'string' || !item.plan_id) continue;
      const ents = Array.isArray(item.entitlements) ? item.entitlements : [];
      const first = isObject(ents[0]) ? ents[0] : {};
      const grantUnits = looseAmount(first.grant_units);
      plans.push({
        planId: item.plan_id,
        priority: looseAmount(item.priority) ?? 0,
        grantUnits,
        unitType: typeof first.unit_type === 'string' ? first.unit_type : undefined
      });
    }
    plans.sort((a, b) => b.priority - a.priority);
    return plans;
  }

  async function fetchStatus() {
    return null; // 无独立状态端点，判定收敛在 claim（precheckStatus:false）
  }

  /** 领一个 plan。返回 {code, ok, alreadyClaimed, message, riskControlled}。 */
  async function claimPlan(cred, plan, captcha) {
    let res;
    try {
      res = await fetcher(`${ORIGIN}${P_CLAIM}`, {
        method: 'POST',
        headers: baseHeaders(cred, { authorization: true, captcha }),
        body: JSON.stringify({ plan_id: plan.planId })
      });
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
    const text = await res.text();
    let code;
    let message;
    try {
      const parsed = JSON.parse(text);
      code = parseZcodeBusinessCode(parsed.code);
      message = typeof parsed.msg === 'string' ? parsed.msg : typeof parsed.message === 'string' ? parsed.message : undefined;
    } catch {
      message = text.slice(0, 200);
    }
    // code 缺失时才扫正文，且用语义短语（避免 "retry after 3012 ms" 误判）
    if (code === undefined && mentionsUnusualActivity(text)) code = 3012;
    const alreadyClaimed = code === 1003;
    const ok = res.ok && (code === 0 || alreadyClaimed);
    return {
      code,
      ok,
      alreadyClaimed,
      riskControlled: code === 3012,
      message: message ?? (ok ? undefined : `HTTP ${res.status}`)
    };
  }

  async function claim(cred) {
    const plans = await fetchPlans(cred);
    if (plans.length === 0) return { kind: 'inactive', message: '当前没有可领取的每日 plan' };
    // captcha Pluggable：Android 无法 headful，注入缺失时明确降级
    if (typeof ctx.mintCaptcha !== 'function') {
      return {
        kind: 'inactive',
        message: 'ZCode 领取需要网页验证码，Android 端无法自动完成；请在桌面端 ZCode 客户端领取，或在设置中注入 captcha。',
        actionRequired: true
      };
    }
    const outcomes = [];
    for (const plan of plans) {
      let captcha;
      try {
        captcha = await ctx.mintCaptcha(cred); // 每次现产一个（一次性）
      } catch (e) {
        outcomes.push({ kind: 'failed', code: -1, message: `captcha 生成失败: ${e?.message || String(e)}` });
        break;
      }
      const r = await claimPlan(cred, plan, captcha);
      if (r.ok) {
        if (r.alreadyClaimed) outcomes.push({ kind: 'already-claimed', message: '该 plan 已领取过', unit: 'token' });
        else {
          outcomes.push({
            kind: 'claimed',
            credit: plan.grantUnits ?? 0,
            unit: plan.unitType === 'token' || plan.unitType === undefined ? 'token' : 'credit',
            streakDays: 0,
            isStreakDay: false
          });
        }
      } else if (r.riskControlled) {
        // 3012 风控：明确文案 + 短路后续 plan（有账号冷却惩罚）
        outcomes.push({ kind: 'failed', code: 3012, message: '领取被风控拦截（unusual activity）。请勿连续重试，稍后再试或改天再领。' });
        break;
      } else {
        outcomes.push({ kind: 'failed', code: r.code ?? -1, message: r.message || '领取失败' });
      }
    }
    // 汇总成一条 outcome（computeClaimSummary 需要逐条，这里用一个多结果包裹）
    return { kind: '_multi', outcomes };
  }

  async function fetchBalance(cred) {
    const body = await getJson(`${ORIGIN}${P_BALANCE}`, cred, { authorization: true });
    if (!isObject(body) || !isObject(body.data)) return { balance: null, error: '余额查询失败' };
    const buckets = Array.isArray(body.data.balances) ? body.data.balances : [];
    const packages = [];
    let total = 0;
    for (const b of buckets) {
      if (!isObject(b)) continue;
      const remaining = looseAmount(b.remaining ?? b.remaining_units ?? b.total) ?? 0;
      const unit = typeof b.unit_type === 'string' ? b.unit_type : 'token';
      const name = readString(b, 'meter') || readString(b, 'name') || '额度';
      const pkg = makePackage({ name, unit, remaining, total: remaining, used: 0 });
      packages.push(pkg);
      total += remaining;
    }
    return { balance: { total, packages, expiredTotal: 0 } };
  }

  return { id: 'zcode', precheckStatus: false, fetchStatus, claim, fetchBalance };
}
