/**
 * 上游调用的语法糖：JSON / 表单 / 纯文本。
 * 统一返回 {status, headers, json, text}，由渠道自己判业务码。
 */
import { openUpstream } from './http-client.js';
import { OfmError, Codes } from './errors.js';
import { tryJson } from './util.js';

export async function request(url, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 60000, signal } = options;
  const payload =
    body === undefined || body === null
      ? null
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  const h = { ...headers };
  if (payload && !h['content-type'] && !h['Content-Type']) {
    h['content-type'] = 'application/json; charset=utf-8';
  }
  if (payload) h['content-length'] = Buffer.byteLength(payload);

  const res = await openUpstream(url, { method, headers: h, body: payload, timeoutMs, signal });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    json: tryJson(text, undefined)
  };
}

export function encodeForm(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

export function postForm(url, form, options = {}) {
  return request(url, {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(options.headers || {}) },
    body: encodeForm(form)
  });
}

/** 把非 2xx 的响应体裁成可读的一句话（避免把整页 HTML 塞进错误文案） */
export function briefBody(text, limit = 300) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/** 上游返回 JSON 但业务失败时的标准抛错 */
export function upstreamError(label, res, code = Codes.UPSTREAM) {
  const msg = res?.json?.error?.message || res?.json?.message || briefBody(res?.text);
  return new OfmError(code, `${label}: ${msg || `HTTP ${res?.status}`}`, {
    status: res?.status && res.status >= 400 ? res.status : undefined,
    detail: res?.json
  });
}
