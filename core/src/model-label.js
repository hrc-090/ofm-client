/**
 * 模型列表的展示文案，以及把客户端回传的脏 model 值还原成真实 id。
 *
 * 现在 `/v1/models` 下发的两种形态：
 *   id            trae/Doubao-Seed-Code      ← 永远是真实 `${provider}/${model}`，不装饰
 *   display_name  [TRAE] Doubao-Seed-Code    ← 渠道名只在第一行出现
 *
 * `decorateModelId` 保留下来只是为了**兼容与测试**：早期版本会把 `id` 拼成
 * `[渠道] :: trae/xxx`，装了旧版的客户端会把这种串缓存下来继续发回来，
 * 所以 `resolveModelId` 必须认得它。新版本不再产出这种形态。
 */

/** 旧版展示 id 的分界符。仅用于反解历史值，**不再产出**。 */
export const MODEL_LABEL_SEP = ' :: ';

/**
 * 可选的统一品牌前缀，拼在渠道名之前（如 'Tune'）。默认空 = 只加渠道名。
 * 只影响 display_name。
 */
export const MODEL_LABEL_PREFIX = '';

function labelParts(channelName, prefix) {
  return [
    String(prefix || '').trim(),
    channelName ? `[${channelName}]` : ''
  ].filter(Boolean);
}

/**
 * 旧版展示 id 的构造：`[渠道] :: realId`。
 * ⚠️ **新版本不再调用它**，只留给测试构造「旧客户端缓存下来的脏串」用。
 */
export function decorateModelId(realId, channelName, prefix = MODEL_LABEL_PREFIX) {
  const parts = labelParts(channelName, prefix);
  return parts.length
    ? `${parts.join(' ')}${MODEL_LABEL_SEP}${realId}`
    : String(realId);
}

/** `/v1/models` 的 display_name：渠道名 + 原显示名（不带真实 id，避免重复）。 */
export function decorateDisplayName(name, channelName, prefix = MODEL_LABEL_PREFIX) {
  const parts = labelParts(channelName, prefix);
  return parts.length ? `${parts.join(' ')} ${name}` : String(name);
}

/**
 * 把第三方回传的展示内容还原成 `${provider}/${model}`。
 *
 * 客户端回传的东西比想象中脏，这里逐层剥：
 *   1. URL 编码过的（`%5BTRAE%5D%20%3A%3A%20trae%2Fxxx`）
 *   2. 首尾空白、包裹引号
 *   3. `[渠道] :: ` 前缀（`lastIndexOf` 取最后一段，容忍前缀被截断）
 *   4. 只回传了 display_name（`[渠道] 模型名`）时残留的方括号前缀
 *
 * 剥完若仍不是 `provider/model`，交给上层查目录或报清晰错误——这里绝不猜渠道。
 * 已是真实 id、或不是字符串时原样返回。
 */
export function resolveModelId(input) {
  if (typeof input !== 'string') return input;
  let s = input.trim();
  if (!s) return s;
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try {
      s = decodeURIComponent(s).trim();
    } catch {
      /* 非法编码就按原样继续，别把请求带崩 */
    }
  }
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  const i = s.lastIndexOf(MODEL_LABEL_SEP);
  if (i >= 0) s = s.slice(i + MODEL_LABEL_SEP.length).trim();
  // 剩下的只可能是 display_name 形态：`[渠道] 模型名` / `【渠道】模型名`
  s = s.replace(/^[\[【][^\]】]{0,48}[\]】]\s*/, '').trim();
  return s;
}
