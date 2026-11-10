/**
 * 各渠道响应字段的容错读取。
 * 上游字段形态千奇百怪（数字/字符串、缺失/null、信封 vs 平铺），
 * 统一在这里收敛，避免每个渠道各写一份导致分叉。
 */

/** 严格有限数字（只认 number）。 */
export function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 宽松金额：数字或数字字符串都接受；空串/NaN/undefined 一律 undefined（不编造 0）。 */
export function looseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** 从对象读安全数字，缺失/非法返回 0（用于「缺了就当 0」的字段）。 */
export function readNumber(obj, key, fallback = 0) {
  if (typeof obj !== 'object' || obj === null) return fallback;
  const n = looseAmount(obj[key]);
  return n === undefined ? fallback : n;
}

/** 从对象读可选数字，缺失/非法返回 undefined。 */
export function numberOrUndef(obj, key) {
  if (typeof obj !== 'object' || obj === null) return undefined;
  return looseAmount(obj[key]);
}

/** 从对象读字符串。 */
export function readString(obj, key, fallback = '') {
  if (typeof obj !== 'object' || obj === null) return fallback;
  const v = obj[key];
  return typeof v === 'string' ? v : fallback;
}

/** 认数字与纯数字字符串的业务码（TRAE code 会在网关回 "9074"）。 */
export function readCode(obj, key = 'code') {
  const raw = obj?.[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return raw === undefined ? 0 : -1;
}

/** 判断响应体是不是「对象」而非数组/null。 */
export function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 从 fetch-like Response 读 JSON 对象；失败返回 null（不抛到调用方）。 */
export async function responseJson(res) {
  try {
    const v = await res.json();
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}
