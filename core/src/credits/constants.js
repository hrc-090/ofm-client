/**
 * 签到 / 积分功能的公共常量与时间口径。
 *
 * ⚠️ 日界归服务端（各渠道按 UTC+8 结算），一律用**算术平移**取「今天」，
 * 不能用本机时区：地理位置差 / 改系统时区会得到错的「今天」，
 * 偏东会提前把当天记为已跑（真漏签），偏西会一天跑两次。
 * 对照上游 model-queue.ts:QODER_BILLING_UTC_OFFSET_MS 与 auto-checkin.ts。
 */
export const UTC8_OFFSET_MS = 8 * 3600 * 1000;

/** Qoder 每日活动刷新时刻（UTC+8 的 10:00）。 */
export const QODER_CAMPAIGN_REFRESH_HOUR_UTC8 = 10;

/** 余额卡片按到期远近分「临时 / 长期」的默认时间窗口（天）。 */
export const DEFAULT_CREDIT_EXPIRING_WINDOW_DAYS = 15;

/** 窗口天数只接受显式的非负有限数值；0 表示没有临时窗口。 */
export function creditExpiringWindowDays(env = process.env) {
  const raw = env.DSH_CREDIT_EXPIRING_WINDOW_DAYS ?? env.OFM_CREDIT_WINDOW_DAYS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_CREDIT_EXPIRING_WINDOW_DAYS;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CREDIT_EXPIRING_WINDOW_DAYS;
}

/** 「UTC+8 的当天日期」（YYYY-MM-DD）。 */
export function utc8DateString(nowMs = Date.now()) {
  return new Date(nowMs + UTC8_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Qoder 每日 10:00（UTC+8）刷新前，看到的 CLAIMED 属于昨天。
 * 用算术平移取 UTC+8 小时，不用 getHours()（那是本机时区）。
 */
export function hasQoderCampaignRefreshedToday(nowMs = Date.now()) {
  return new Date(nowMs + UTC8_OFFSET_MS).getUTCHours() >= QODER_CAMPAIGN_REFRESH_HOUR_UTC8;
}

/** 自动签到默认延迟（毫秒）。理由：不跟启动抢资源 + 等凭据续期先跑一轮。 */
export const AUTO_CHECKIN_DELAY_MS = 30_000;
/** 常驻进程跨天巡检间隔（2.5 小时）。 */
export const AUTO_CHECKIN_TICK_MS = 150 * 60 * 1000;
/** 失败退避下限（1 小时）：拦住巡检被调小后高频打上游。 */
export const AUTO_CHECKIN_RETRY_MS = 60 * 60 * 1000;
export const AUTO_CHECKIN_DELAY_ENV = 'OFM_AUTO_CHECKIN_DELAY_MS';
export const AUTO_CHECKIN_TICK_ENV = 'OFM_AUTO_CHECKIN_TICK_MS';

/**
 * 读延迟配置。⚠️ 不能写 Number(env.X) || 默认值：0 是合法值（立刻跑），
 * 而 0 是 falsy 会被静默换成 30 秒。
 */
export function autoCheckinDelayMs(env = process.env) {
  const raw = env[AUTO_CHECKIN_DELAY_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return AUTO_CHECKIN_DELAY_MS;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : AUTO_CHECKIN_DELAY_MS;
}

export function autoCheckinTickMs(env = process.env) {
  const raw = env[AUTO_CHECKIN_TICK_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return AUTO_CHECKIN_TICK_MS;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : AUTO_CHECKIN_TICK_MS;
}
