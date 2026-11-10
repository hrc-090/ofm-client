/**
 * Qoder / Qoder 中国版 每日活动领取与余额 —— 对齐上游 qoder-credits.ts。
 *
 * 端点：
 *   GET  {openApiBase}/sash/api/v1/me/campaigns
 *   POST {openApiBase}/sash/api/v1/me/campaigns/{id}/claim   body **空串**
 *   GET  {openApiBase}/sash/api/v2/me/usage
 *
 * ⚠️ 最大的坑：活动每日 10:00（UTC+8）刷新。刷新前看到的 CLAIMED 属于**昨天**：
 *  - 一律判 todayCheckedIn: false；
 *  - 领取结果的 coversToday: false（不得据此认定今天已处理，否则当天新额度整天漏领）。
 *
 * ⚠️ 签到专用头：Cosy-ClientType:'10' 是前提，Cosy-MachineToken + Cosy-MachineType
 *    才决定是否下发可领项。Android 通常拿不到这两个值 → Pluggable：
 *    用户在设置里手工粘贴就带上，否则照常发（只是不带），UI 必须显示「未下发可领活动」
 *    而**不是**「今天已领」。绝不自造 token 冒充。
 */
import { QODER, QODER_CN } from '../../channels/qoder/product.js';
import { hasQoderCampaignRefreshedToday, QODER_CAMPAIGN_REFRESH_HOUR_UTC8 } from '../constants.js';
import { makePackage, emptyCheckinStatus } from '../model.js';
import { roundCredits } from '../format.js';
import { readNumber, numberOrUndef, readString, isObject, responseJson } from '../read.js';

const P_CAMPAIGNS = '/sash/api/v1/me/campaigns';
const P_USAGE = '/sash/api/v2/me/usage';

const NOT_ACTIVATED_HINT =
  '该账号尚未在 Qoder 侧开通每日领取（每日 100 Credits）。' +
  '请先用 Qoder 官方客户端登录一次该账号，开通后再回来领取。';
const NOT_REFRESHED_YET_HINT =
  `今天的每日活动尚未刷新（每日 ${QODER_CAMPAIGN_REFRESH_HOUR_UTC8}:00（UTC+8）刷新），` +
  '当前看到的是昨天那一轮，请稍后再来领取。';

export function createQoderProvider(ctx) {
  const { fetcher, now, settings, productId } = ctx;
  const product = productId === 'qodercn' ? QODER_CN : QODER;
  const nowMs = () => (typeof now === 'function' ? now() : Date.now());

  // Pluggable machine 头：从最新 settings.credits 读（用户手工粘贴），
  // 或 ctx.machineHeaders 直接注入（测试）。⚠️ 必须用 getSettings() 现取：
  // store.update() 会替换整个 settings 对象，构造时缓存的引用会读不到新值。
  function creditsHeaders(cred) {
    const h = {
      Accept: 'application/json',
      Authorization: `Bearer ${cred.security_oauth_token ?? cred.access_token}`,
      'Cosy-ClientType': product.sashClientType, // '10'
      'User-Agent': 'Qoder'
    };
    const current = typeof ctx.getSettings === 'function' ? ctx.getSettings() : settings;
    const mt = ctx.machineHeaders || current?.credits?.qoderMachine || null;
    if (mt && mt.token && mt.type) {
      h['Cosy-MachineToken'] = mt.token;
      h['Cosy-MachineType'] = mt.type;
    }
    return h;
  }

  async function getJson(path, cred, init = {}) {
    try {
      const res = await fetcher(`${product.openApiBase}${path}`, {
        method: init.method || 'GET',
        headers: { ...creditsHeaders(cred), ...(init.headers || {}) },
        body: init.body
      });
      if (!res.ok) return undefined;
      return await responseJson(res);
    } catch {
      return undefined;
    }
  }

  /** 解析 campaigns 响应；形状非法返回 undefined。 */
  function parseCampaigns(body) {
    if (!isObject(body)) return undefined;
    const campaigns = [];
    if (Array.isArray(body.campaigns)) {
      for (const item of body.campaigns) {
        const id = readString(item, 'campaignId');
        if (!id) continue;
        const benefit = isObject(item.benefit) ? numberOrUndef(item.benefit, 'amount') : undefined;
        campaigns.push({
          campaignId: id,
          campaignKey: readString(item, 'campaignKey'),
          actionType: readString(item, 'actionType'),
          claimStatus: readString(item, 'claimStatus'),
          amount: benefit
        });
      }
    }
    return {
      showCampaign: body.showCampaign === true,
      claimable: body.claimable === true,
      campaigns
    };
  }

  async function loadCampaigns(cred) {
    return parseCampaigns(await getJson(P_CAMPAIGNS, cred));
  }

  function claimableCampaigns(parsed) {
    return parsed.campaigns.filter((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE');
  }

  async function fetchUsageRaw(cred) {
    return await getJson(P_USAGE, cred);
  }

  /**
   * 「未开通」判据（两条同时满足）：
   *  ① 列表里没有 CLAIM_BENEFIT（连已领的都没有）；
   *  ② 用量响应里 addOnQuota **字段不存在**（缺失，不是 0）。
   */
  function isNotActivated(parsed, usageBody) {
    if (parsed === undefined) return false;
    if (parsed.campaigns.some((c) => c.actionType === 'CLAIM_BENEFIT')) return false;
    const usage = isObject(usageBody) ? usageBody.qoderUsage : undefined;
    if (!isObject(usage)) return false;
    return usage.addOnQuota === undefined;
  }

  async function fetchStatus(cred) {
    const parsed = await loadCampaigns(cred);
    if (parsed === undefined) return null;
    const refreshed = hasQoderCampaignRefreshedToday(nowMs());
    const claimable = claimableCampaigns(parsed);
    const benefit = parsed.campaigns.filter((c) => c.actionType === 'CLAIM_BENEFIT');
    const claimedBenefit = benefit.filter((c) => c.claimStatus === 'CLAIMED');
    // 只在「刷新后 && 存在 CLAIMED && 没有 CLAIMABLE」时判今天已领
    const todayCheckedIn = refreshed && claimedBenefit.length > 0 && claimable.length === 0;
    let actionRequired = false;
    if (!todayCheckedIn && claimable.length === 0) {
      actionRequired = isNotActivated(parsed, await fetchUsageRaw(cred));
    }
    return emptyCheckinStatus({
      active: true, // 拿到响应即 true，不按列表非空
      todayCheckedIn,
      dailyCredit: claimable[0]?.amount ?? benefit[0]?.amount ?? 0,
      activityName: benefit[0]?.campaignKey || '',
      ...(actionRequired ? { actionRequired: true } : {})
    });
  }

  /** 领取单个活动；幂等判据是响应体 replayed:true，不是 HTTP 状态码。 */
  async function claimCampaign(cred, campaignId) {
    let res;
    try {
      res = await fetcher(`${product.openApiBase}${P_CAMPAIGNS}/${encodeURIComponent(campaignId)}/claim`, {
        method: 'POST',
        headers: { ...creditsHeaders(cred), 'Content-Type': 'application/json' },
        body: '' // 必须空串，抓包 content-length: 0
      });
    } catch (e) {
      return { kind: 'failed', code: -1, message: e?.message || String(e) };
    }
    const text = await res.text();
    let body = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      return { kind: 'failed', code: res.status, message: describeNonJson(res.status, text) };
    }
    if (!res.ok) return { kind: 'failed', code: res.status, message: describeNonJson(res.status, text) };
    const root = isObject(body) ? body : {};
    if (root.replayed === true) return { kind: 'already-claimed', message: '今天已领取' };
    const status = typeof root.status === 'string' ? root.status : undefined;
    if (status !== undefined && status !== 'CLAIMED') {
      return { kind: 'failed', code: -1, message: `领取未成功（status=${status}）` };
    }
    const amount = isObject(root.benefit) ? numberOrUndef(root.benefit, 'amount') : undefined;
    return { kind: 'claimed', credit: amount ?? 0, streakDays: 0, isStreakDay: false };
  }

  function describeNonJson(status, text) {
    if (status === 401 || status === 403) return `凭据已失效（HTTP ${status}），请重新登录该账号`;
    return `服务端返回了非 JSON 响应（HTTP ${status}）：${text.trim().slice(0, 80)}`;
  }

  /** 领取当前所有可领活动（一个账号可能同时有多个 CLAIM_BENEFIT）。 */
  async function claim(cred) {
    const parsed = await loadCampaigns(cred);
    if (parsed === undefined) return { kind: 'failed', code: -1, message: '活动列表查询失败' };
    const refreshed = hasQoderCampaignRefreshedToday(nowMs());
    const stale = refreshed ? {} : { coversToday: false };
    const targets = claimableCampaigns(parsed);
    if (targets.length === 0) {
      const claimedBefore = parsed.campaigns.some(
        (c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMED'
      );
      if (claimedBefore) {
        if (!refreshed) return { kind: 'inactive', message: NOT_REFRESHED_YET_HINT, ...stale };
        return { kind: 'already-claimed', message: '今天已领取' };
      }
      if (isNotActivated(parsed, await fetchUsageRaw(cred))) {
        return { kind: 'inactive', message: NOT_ACTIVATED_HINT, actionRequired: true };
      }
      // 可领项为 0 且非已领 → inactive（不是 already-claimed），且不算今天这一轮
      return { kind: 'inactive', message: '未下发可领活动（每日 10:00 UTC+8 刷新，或该账号暂无此类活动）', ...stale };
    }
    let total = 0;
    let firstError;
    for (const t of targets) {
      const o = await claimCampaign(cred, t.campaignId);
      if (o.kind === 'claimed') total += o.credit;
      else if (o.kind === 'failed' && firstError === undefined) firstError = o.message;
    }
    if (total > 0) return { kind: 'claimed', credit: total, streakDays: 0, isStreakDay: false, ...stale };
    if (firstError !== undefined) return { kind: 'failed', code: -1, message: firstError, ...stale };
    return { kind: 'already-claimed', message: '今天已领取', ...stale };
  }

  function toPackage(name, quota, options = {}) {
    const total = numberOrUndef(quota, 'total');
    const used = numberOrUndef(quota, 'used');
    const remainingRaw = numberOrUndef(quota, 'remaining');
    if (total === undefined && used === undefined && remainingRaw === undefined) return undefined;
    const totalValue = Math.max(0, total ?? 0);
    const usedValue = Math.max(0, used ?? 0);
    const remaining = remainingRaw !== undefined ? Math.max(0, remainingRaw) : Math.max(0, totalValue - usedValue);
    const expStr = options.expiredTime || '';
    const expMs = expStr ? Date.parse(expStr.replace(' ', 'T')) : NaN;
    return makePackage({
      name,
      unit: readString(quota, 'unit') || 'credits',
      remaining,
      total: totalValue,
      used: usedValue,
      active: options.active !== false,
      expiredTime: expStr,
      deductionEndTime: Number.isFinite(expMs) ? expMs : undefined
    });
  }

  async function fetchBalance(cred) {
    const body = await getJson(P_USAGE, cred);
    if (!isObject(body)) return { balance: null, error: '余额查询失败' };
    if (body.displayMode === 'enterprise') {
      return { balance: null, error: '企业版账号不提供额度数字（有额度但需到官方查看）' };
    }
    const usage = isObject(body.qoderUsage) ? body.qoderUsage : undefined;
    if (!isObject(usage)) return { balance: null, error: '余额响应形状不符' };
    const packages = [];
    const p1 = toPackage('套餐额度', usage.userQuota);
    if (p1) packages.push(p1);
    // ⚠️ 余额不只在 userQuota：实测 userQuota.remaining=0 而 addOnQuota.remaining=100
    const p2 = toPackage('资源包', usage.addOnQuota);
    if (p2) packages.push(p2);
    if (Array.isArray(usage.dedicatedResourcePackages)) {
      for (const item of usage.dedicatedResourcePackages) {
        const p = toPackage(
          readString(item, 'name') || readString(item, 'id') || '专用资源包',
          item,
          { expiredTime: readString(item, 'expiresAt') || readString(item, 'expires_at') }
        );
        if (p) packages.push(p);
      }
    }
    if (packages.length === 0) return { balance: null, error: '未解析到任何额度包' };
    const total = roundCredits(packages.reduce((s, p) => s + p.remaining, 0));
    return { balance: { total, packages, expiredTotal: 0 } };
  }

  return { id: productId, precheckStatus: true, fetchStatus, claim, fetchBalance };
}
