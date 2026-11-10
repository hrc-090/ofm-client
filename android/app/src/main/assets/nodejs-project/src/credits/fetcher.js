/**
 * 把现有 upstream.request（node:http，nodejs-mobile 兼容）包装成 fetch-like 接口。
 *
 * 上游 credits 实现用的是 `fetch(url, init) -> Response`，但内嵌 Node 18 不保证
 * 有全局 fetch（README 里也刻意不用它）。这里提供等价的最小 Response 形状，
 * 让各渠道模块既能用真实网络，又能在验收里被注入 mock fetcher 完全替身。
 *
 * fetcher 契约：
 *   fetcher(url: string, init?: { method, headers, body, timeoutMs })
 *     -> Promise<{ ok, status, headers:{get(k)}, text():Promise<string>, json():Promise<any> }>
 */
import { request } from '../upstream.js';

export function makeFetcher({ timeoutMs = 30000, onError } = {}) {
  return async function fetcher(url, init = {}) {
    try {
      const res = await request(url, {
        method: init.method || 'GET',
        headers: init.headers || {},
        body: init.body, // request 会把对象 JSON.stringify，字符串原样发
        timeoutMs: init.timeoutMs ?? timeoutMs
      });
      return toResponse(res);
    } catch (e) {
      // 记下最近一次出站网络异常。很多 provider 内部catch后只回「余额查询失败」，
      // 服务层拿到这个线索才能把真实原因（证书/DNS/超时）透给 UI。
      try { onError?.(e, url); } catch { /* 诊断钩子不能影响主流程 */ }
      throw e;
    }
  };
}

/** 把 request() 的结果转成 fetch-like Response。 */
export function toResponse(res) {
  const headers = res.headers || {};
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    text: async () => (typeof res.text === 'string' ? res.text : ''),
    json: async () => {
      if (res.json !== undefined) return res.json;
      const t = typeof res.text === 'string' ? res.text : '';
      return JSON.parse(t);
    }
  };
}

/** 测试用：直接用一个假 Response 构造 fetcher。handler(url, init) -> Response 描述。 */
export function mockFetcher(handler) {
  return async function fetcher(url, init = {}) {
    const raw = await handler(url, init);
    // 允许 handler 直接返回 {status, json} / {status, text} / 完整 Response
    if (raw && typeof raw.text === 'function') return raw;
    const status = raw.status ?? 200;
    const bodyObj = raw.json;
    const bodyText = raw.text ?? (bodyObj !== undefined ? JSON.stringify(bodyObj) : '');
    const headers = raw.headers || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
      text: async () => bodyText,
      json: async () => (bodyObj !== undefined ? bodyObj : JSON.parse(bodyText || '{}'))
    };
  };
}
