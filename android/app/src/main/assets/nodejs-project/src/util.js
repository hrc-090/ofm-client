/**
 * 通用小工具。
 * 目标运行时是 nodejs-mobile（Node 18.x），所以这里刻意不用
 * structuredClone / AbortSignal.any / fetch —— 那些在旧运行时上不一定有。
 */
import crypto from 'node:crypto';

export const now = () => Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给 Promise 套一个超时，超时抛错（原文案带上了时限，便于日志定位）。
 * ⚠️ 只是不再等它，底层 Promise 仍在跑——用于「宁可放弃也不拖死调用方」的场景。
 */
export function withTimeout(promise, ms, label = '操作') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    if (timer.unref) timer.unref();
  });
  // 超时后原 Promise 仍可能 reject，这里先挂一个空 catch，避免 unhandledRejection
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const uuid = () => crypto.randomUUID();

export function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function sha256Base64url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

/** 32 字节 hex，用作 machine_id / device_id */
export const hex32 = () => randomHex(16);

/** 解析 "1.5s" / "900ms" / "1m" 这类时长，返回毫秒 */
export function parseDuration(v, fallback = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return fallback;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(v);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60000 : n * 3600000;
}

/**
 * 过期时间归一化到毫秒。
 * 上游各家的 TokenExpireAt 有秒、毫秒、字符串三种形态，且常常是 10 位秒。
 */
export function toEpochMs(value, fallbackMs = 0) {
  if (value === null || value === undefined || value === '') return fallbackMs;
  let n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) {
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : fallbackMs;
  }
  // < 1e11 视为秒级时间戳（1e11 ms ≈ 1973 年，1e11 s ≈ 5138 年）
  if (n > 0 && n < 1e11) n *= 1000;
  return n;
}

/** 秒级 / 毫秒级混用的 expires_in */
export function expiresInToMs(v, fallbackMs = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return n < 1e6 ? n * 1000 : n;
}

/** 截断日志里的敏感值：只留前后 4 字符 */
export function mask(secret) {
  if (!secret || typeof secret !== 'string') return '***';
  if (secret.length <= 8) return '***';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** 安全 JSON.parse，失败返回 fallback */
export function tryJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 有些上游把 JSON 再包一层字符串（Qoder 的错误 message、TRAE 的 userInfo，
 * 甚至出现双重 URL 编码）。这里统一做「最多两层」的容错解码。
 */
export function deepJson(value, depth = 2) {
  let cur = value;
  for (let i = 0; i < depth; i += 1) {
    if (typeof cur !== 'string') break;
    const trimmed = cur.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) break;
    const parsed = tryJson(trimmed, undefined);
    if (parsed === undefined) break;
    cur = parsed;
  }
  return cur;
}

/** URL 编码的 JSON（TRAE 回调用），支持双重编码 */
export function parseUrlEncodedJson(value) {
  if (typeof value !== 'string' || !value) return undefined;
  let cur = value;
  for (let i = 0; i < 2; i += 1) {
    if (typeof cur !== 'string') break;
    try {
      const decoded = decodeURIComponent(cur);
      const parsed = tryJson(decoded, undefined);
      if (parsed !== undefined) return parsed;
      cur = decoded;
    } catch {
      break;
    }
  }
  return tryJson(cur, undefined);
}
