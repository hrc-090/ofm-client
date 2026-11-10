/**
 * 搜索/抓取用的文本 HTTP 客户端。
 *
 * 复用 http-client.js 的 openUpstream：Android 内嵌 Node 拿不到系统 CA，
 * 必须走打包的根证书；这里再补三件它没有的：跟随重定向、响应体积封顶、
 * 返回最终 URL（重定向后的地址要给用户看）。
 */
import { openUpstream, decodeBody } from '../http-client.js';

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const DEFAULT_HEADERS = {
  'user-agent': DESKTOP_UA,
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
};

export class HttpTextError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'HttpTextError';
    this.status = extra.status || 0;
    this.code = extra.code || 'HTTP_ERROR';
  }
}

async function readCapped(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.raw) {
    size += chunk.length;
    if (size > maxBytes) {
      try {
        res.destroy();
      } catch {
        /* noop */
      }
      throw new HttpTextError(`响应超过 ${Math.round(maxBytes / 1024)}KB 上限`, { status: res.status, code: 'TOO_LARGE' });
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return decodeBody(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8');
}

/**
 * @returns {Promise<{status:number, headers:object, text:string, finalUrl:string, bytes:number}>}
 */
export async function fetchText(urlStr, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 15000,
    maxBytes = 3 * 1024 * 1024,
    maxRedirects = 3,
    signal = null
  } = options;

  let current = String(urlStr);
  let verb = method;
  let payload = body;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await openUpstream(current, {
      method: verb,
      headers: { ...DEFAULT_HEADERS, ...headers },
      body: payload,
      timeoutMs,
      signal
    });

    const status = res.status;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      const next = new URL(String(res.headers.location), current).toString();
      try {
        res.destroy();
      } catch {
        /* noop */
      }
      current = next;
      if (status === 303 || (status === 301 && verb === 'POST') || (status === 302 && verb === 'POST')) {
        verb = 'GET';
        payload = null;
      }
      continue;
    }

    const declared = Number(res.headers['content-length'] || 0);
    if (declared && declared > maxBytes) {
      try {
        res.destroy();
      } catch {
        /* noop */
      }
      throw new HttpTextError(`响应声明 ${declared} 字节，超过上限`, { status, code: 'TOO_LARGE' });
    }

    const text = await readCapped(res, maxBytes);
    return { status, headers: res.headers, text, finalUrl: current, bytes: Buffer.byteLength(text) };
  }

  throw new HttpTextError('重定向次数过多', { code: 'TOO_MANY_REDIRECTS' });
}
