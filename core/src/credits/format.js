/**
 * 积分类型的单位与格式化工具 —— 逐字对齐上游 credits.ts。
 *
 * 核心纪律：**单位不能跨渠道相加**。ZCode 下发 token（一次 1 亿），其余是积分。
 * 汇总必须按单位分组（totalByUnit），展示路径只走 formatClaimGains / formatUnitAmount。
 */

export function roundCredits(value) {
  return Math.round(value * 100) / 100;
}

/** 单位归一到展示口径。'credit'/'credits' 同组，token 独立。 */
export function normalizeCreditUnit(unit) {
  return unit === 'token' ? 'token' : 'credit';
}

/** ClaimOutcome.unit 可选且可能来自 RPC 未知值，统一收敛（缺省 credit）。 */
export function claimUnitOf(unit) {
  return normalizeCreditUnit(typeof unit === 'string' ? unit : '');
}

/** 积分：整数不带小数，有小数保留两位（与 IDE 顶部精度一致，不压缩）。 */
export function formatCreditAmount(value) {
  if (!Number.isFinite(value)) return '?';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** token：>=1e6 → "94.54M"；>=1e3 → "945.39K"；否则取整。 */
export function formatTokenAmount(value) {
  if (!Number.isFinite(value)) return '?';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Math.round(value));
}

/** 单位展示名：Token / 积分。 */
export function claimUnitLabel(unit) {
  return unit === 'token' ? 'Token' : '积分';
}

/** 一个「数值 + 单位」读数，如 "100.00MToken" / "800积分"（中间不留空格）。 */
export function formatUnitAmount(value, unit) {
  const u = claimUnitOf(unit);
  const text = u === 'token' ? formatTokenAmount(value) : formatCreditAmount(value);
  return `${text}${claimUnitLabel(u)}`;
}

/**
 * 把按单位分组的领取所得拼成 "+100.00MToken, +100积分"。
 * 每个单位各带一个 "+"，顺序固定 token → credit，只列非零，全零返回 null。
 */
export function formatClaimGains(totals) {
  if (totals === undefined || totals === null || typeof totals !== 'object') return null;
  const parts = [];
  for (const unit of ['token', 'credit']) {
    const value = Number(totals[unit]);
    if (!Number.isFinite(value) || value <= 0) continue;
    parts.push(`+${formatUnitAmount(value, unit)}`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}

/** 把包列表按「扣费截止时间」相对 windowDays 分成临时 / 长期两桶（渲染时现算）。 */
export function splitCreditsByExpiry(packages, windowDays, nowMs = Date.now()) {
  const temporary = [];
  const longTerm = [];
  const horizon = windowDays > 0 ? nowMs + windowDays * 86400000 : -Infinity;
  for (const pkg of packages || []) {
    const d = pkg.deductionEndTime;
    if (typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= horizon) temporary.push(pkg);
    else longTerm.push(pkg);
  }
  return { temporary, longTerm };
}
