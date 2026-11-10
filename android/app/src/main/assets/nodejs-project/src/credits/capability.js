/**
 * 渠道签到能力表 —— 对应说明书 §0 那张「决定要不要写代码」的表。
 * 判据来自上游 channel-pack-rpc.ts 的 credits.claimAll 分支逐渠道实读，
 * 不是「有没有 /api/ 前缀」这种猜测。
 *
 * 字段：
 *  - dailyCheckin    有每日签到/领取（UI 显示「一键签到」）
 *  - checkinStatus   有独立签到状态端点（LobsterAI/Loomy 没有 → status 恒 null）
 *  - balance         能查余额
 *  - onboardingTasks 有一次性「新手任务」（Raccoon 的桌面端登录奖励）
 *  - autoExcluded    自动签到排除（ZCode：领取有 captcha 代价，只能手动）
 *  - quotaOnly       配额是百分比窗口，不是积分（Gemini，绝不换算成积分数字）
 *  - note            无签到时给 UI 的说明
 *
 * ⚠️ mock/gemini/opencode 在本工程里要么无账号、要么未实现登录，
 * 仍登记在表里让 API 对未知 provider 返回可读错误而非 500。
 */
export const CREDIT_CAPABILITIES = {
  trae: { dailyCheckin: true, checkinStatus: true, balance: true },
  qoder: { dailyCheckin: true, checkinStatus: true, balance: true },
  qodercn: { dailyCheckin: true, checkinStatus: true, balance: true },
  lobsterai: { dailyCheckin: true, checkinStatus: false, balance: true },
  loomy: { dailyCheckin: true, checkinStatus: false, balance: true },
  minimax: { dailyCheckin: true, checkinStatus: true, balance: true },
  zcode: { dailyCheckin: true, checkinStatus: false, balance: true, autoExcluded: true },
  raccoon: {
    dailyCheckin: false,
    checkinStatus: false,
    balance: true,
    onboardingTasks: true,
    note: '无每日签到（每日 300 由服务端自动发放）；有一次性「桌面端登录奖励」'
  },
  cline: { dailyCheckin: false, checkinStatus: false, balance: true, note: 'Cline 不支持每日签到（其后端没有签到接口）' },
  gemini: { dailyCheckin: false, checkinStatus: false, balance: true, quotaOnly: true, note: '只有 5 小时 / 周配额窗口，不是积分' },
  opencode: { dailyCheckin: false, checkinStatus: false, balance: false, note: '无余额端点（实测 15 个候选路径全 404）' },
  mock: { dailyCheckin: false, checkinStatus: false, balance: false, note: '本地回显渠道，无积分概念' }
};

export function capabilityOf(provider) {
  return CREDIT_CAPABILITIES[provider] || null;
}

/**
 * 自动签到排除表 —— 必须在「调用之前」生效，不是「等它返回错误再判定」。
 * ZCode 的代价发生在调用期间（拉起浏览器产 captcha），事后判已经太晚。
 */
export function isAutoCheckinExcluded(provider) {
  return capabilityOf(provider)?.autoExcluded === true;
}

/** 给 UI 用的能力表（含 provider 名与展示文案）。 */
export function listCapabilities() {
  return Object.entries(CREDIT_CAPABILITIES).map(([provider, cap]) => ({
    provider,
    dailyCheckin: cap.dailyCheckin === true,
    onboardingTasks: cap.onboardingTasks === true,
    balance: cap.balance === true,
    quotaOnly: cap.quotaOnly === true,
    autoExcluded: cap.autoExcluded === true,
    note: cap.note || ''
  }));
}
