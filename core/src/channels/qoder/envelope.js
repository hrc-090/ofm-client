/**
 * Qoder 加密端点的响应信封。
 *
 * 每帧：{headers, body:"<内层 JSON 字符串>", statusCodeValue, statusCode}
 * 内层 body **未加密**，剥掉后就是标准 OpenAI chunk —— 别做解密，也别做字符串嗅探。
 *
 * 按 JSON 结构分类（三种：chunk / error / heartbeat）。
 */
import { tryJson } from '../../util.js';

export function innerTextOf(payload) {
  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object' || envelope.body === undefined) return null;
  return typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body);
}

/** @returns {'chunk'|'error'|'heartbeat'} */
export function classifyInner(inner) {
  const trimmed = String(inner ?? '').trim();
  if (!trimmed) return 'heartbeat';
  if (trimmed.includes('[DONE]')) return 'chunk';
  const parsed = tryJson(trimmed, undefined);
  if (parsed === undefined) return 'error'; // 解析不了的原文按业务错误处理
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'heartbeat';
  if (Array.isArray(parsed.choices) || parsed.usage !== undefined) return 'chunk';
  if (
    parsed.code !== undefined ||
    parsed.message !== undefined ||
    parsed.error !== undefined ||
    parsed.statusCodeValue !== undefined ||
    parsed.type !== undefined
  ) {
    return 'error';
  }
  return 'heartbeat';
}

/** 业务错误里的排队参数藏在 message（一个 JSON 字符串）里，要二次解析 */
export function parseQoderError(inner) {
  const parsed = tryJson(String(inner).trim(), {});
  let code = parsed?.code;
  const message = typeof parsed?.message === 'string' ? parsed.message : String(inner);
  let retryAfterMs = 0;

  const nested = tryJson(message, undefined);
  if (nested) {
    retryAfterMs =
      Number(nested.retry_after_ms) ||
      Number(nested.retryAfterSeconds) * 1000 ||
      Number(nested.retry_after_seconds) * 1000 ||
      0;
    if (code === undefined && nested.code !== undefined) code = nested.code;
  }

  return { code: code === undefined ? undefined : String(code), message, retryAfterMs };
}
