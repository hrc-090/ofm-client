/**
 * 数据模型与结果汇总 —— 逐字对齐上游 credits.ts 与 auto-checkin.ts。
 *
 * 三个类型：
 *  - CheckinStatus：签到状态（todayCheckedIn 是领取判定的权威依据）
 *  - ClaimOutcome：四分支 + coversToday / actionRequired / unit 三个可选语义字段
 *  - CreditBalance：total = 各有效包本周期剩余之和；null 与 0 严格区分
 */
import { claimUnitOf, formatClaimGains, roundCredits } from './format.js';

/** 兜底的空 CheckinStatus（渠道不臆造状态时返回 null，这里只给需要的渠道用）。 */
export function emptyCheckinStatus(overrides = {}) {
  return {
    active: true,
    todayCheckedIn: false,
    streakDays: 0,
    dailyCredit: 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
    ...overrides
  };
}

/** 一个 CreditPackage（各渠道的构造口径不同，但形状统一）。 */
export function makePackage(o) {
  return {
    name: o.name || '资源包',
    unit: o.unit || 'credit',
    remaining: o.remaining ?? 0,
    total: o.total ?? 0,
    used: o.used ?? 0,
    active: o.active !== false,
    cycleStartTime: o.cycleStartTime || '',
    cycleEndTime: o.cycleEndTime || '',
    expiredTime: o.expiredTime || '',
    ...(Number.isFinite(o.deductionEndTime) ? { deductionEndTime: o.deductionEndTime } : {})
  };
}

/**
 * 汇总一次批量领取的结果（纯函数）。
 * inactive（正常业务状态）与 failed（需要关注）分开计数。
 *
 * ⚠️ totalByUnit 两个键恒存在；totalCredit 保留「跨单位求和」的旧语义，
 * 但**展示路径不得用它**。coversToday 只累加「覆盖今天这一轮」的结果。
 */
export function computeClaimSummary(outcomes) {
  const summary = {
    claimed: 0,
    totalCredit: 0,
    alreadyClaimed: 0,
    inactive: 0,
    failed: 0,
    coversToday: 0,
    totalByUnit: { token: 0, credit: 0 }
  };
  for (const o of outcomes || []) {
    switch (o?.kind) {
      case 'claimed':
        summary.claimed += 1;
        summary.totalCredit += o.credit || 0;
        summary.totalByUnit[claimUnitOf(o.unit)] += o.credit || 0;
        if (o.coversToday !== false) summary.coversToday += 1;
        break;
      case 'already-claimed':
        summary.alreadyClaimed += 1;
        if (o.coversToday !== false) summary.coversToday += 1;
        break;
      case 'inactive':
        summary.inactive += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      default:
        summary.failed += 1; // 未知 kind 宁可多报一个失败
    }
  }
  summary.totalCredit = roundCredits(summary.totalCredit);
  summary.totalByUnit.token = roundCredits(summary.totalByUnit.token);
  summary.totalByUnit.credit = roundCredits(summary.totalByUnit.credit);
  return summary;
}

/** 一轮自动签到的累计口径（跨渠道）。 */
export function emptyRunTotals() {
  return {
    providers: 0,
    claimed: 0,
    totalCredit: 0,
    totalByUnit: { token: 0, credit: 0 },
    alreadyClaimed: 0,
    inactive: 0,
    failed: 0,
    coversToday: 0,
    skipped: 0,
    errors: 0
  };
}

/** 把一个渠道的 claim summary 累加进整轮 totals。coversToday 缺字段≠0。 */
export function accumulateRunTotals(totals, summary) {
  totals.claimed += summary.claimed || 0;
  totals.totalCredit += summary.totalCredit || 0;
  const byUnit = summary.totalByUnit || { credit: summary.totalCredit || 0, token: 0 };
  totals.totalByUnit.credit += Number(byUnit.credit) || 0;
  totals.totalByUnit.token += Number(byUnit.token) || 0;
  totals.alreadyClaimed += summary.alreadyClaimed || 0;
  totals.inactive += summary.inactive || 0;
  totals.failed += summary.failed || 0;
  totals.coversToday +=
    summary.coversToday ?? (summary.claimed || 0) + (summary.alreadyClaimed || 0);
}

/**
 * 这一轮该不该把「今天」记为已跑 —— 整份文档里最贵的一行。
 * ⚠️ 只认 coversToday > 0，不是 claimed + alreadyClaimed > 0。
 */
export function shouldMarkToday(totals) {
  return totals.coversToday > 0;
}

/** 判据必须窄：只匹配这两个短语，别泛化成「含 unsupported」。 */
export function isUnsupportedCheckin(message) {
  const s = String(message || '');
  return s.includes('不支持每日签到') || s.includes('unsupported provider');
}

/** 整轮结果的一句中文摘要。 */
export function describeRun(totals) {
  const parts = [];
  if (totals.claimed > 0) {
    const gains = formatClaimGains(totals.totalByUnit || { credit: totals.totalCredit });
    parts.push(`${totals.claimed} 个账号领取成功${gains === null ? '' : `（${gains}）`}`);
  }
  if (totals.alreadyClaimed > 0) parts.push(`${totals.alreadyClaimed} 个今天已领`);
  if (totals.failed > 0) parts.push(`${totals.failed} 个失败`);
  if (totals.errors > 0) parts.push(`${totals.errors} 个渠道出错`);
  if (totals.skipped > 0) parts.push(`${totals.skipped} 个渠道不支持签到`);
  if (parts.length === 0) return `${totals.providers} 个渠道：没有需要领取的账号`;
  return `${totals.providers} 个渠道：${parts.join('，')}`;
}

/**
 * 单渠道短状态。⚠️ 刷新前看到的是「非今日轮次」，不能说「今天已领」。
 */
export function describeChannel(summary) {
  const parts = [];
  if (summary.claimed > 0) {
    const gains = formatClaimGains(summary.totalByUnit || { credit: summary.totalCredit });
    parts.push(gains === null ? `${summary.claimed} 个领取成功` : `${summary.claimed} 个 ${gains}`);
  }
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今天已领`);
  if (summary.failed > 0) parts.push(`${summary.failed} 个失败`);
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个未开启`);
  if (parts.length === 0) return '无可领';
  const coversToday = summary.coversToday ?? (summary.claimed || 0) + (summary.alreadyClaimed || 0);
  if (coversToday === 0 && (summary.claimed || 0) + (summary.alreadyClaimed || 0) > 0) {
    parts.push('非今日轮次');
  }
  return parts.join('，');
}
