/**
 * 向上游发请求的最小 HTTP 客户端。
 *
 * 这里不用 fetch：nodejs-mobile 的 Node 版本可能落后，且我们需要
 * 「首帧超时 / 帧间空闲超时 / 主动 abort」这三个精确控制点，
 * 直接用 node:http(s) 最省心。
 */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { URL } from 'node:url';
import { OfmError, Codes } from './errors.js';
import { httpsOptions } from './ca-bundle.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * @returns {Promise<{status:number, headers:object, raw:import('node:http').IncomingMessage,
 *                    text:()=>Promise<string>, destroy:()=>void}>}
 */
export function openUpstream(urlStr, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 120000,
    signal = null
  } = options;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new OfmError(Codes.INVALID_REQUEST, `非法 URL: ${urlStr}`));
      return;
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        // Android 内嵌 Node 拿不到系统 CA，必须显式带上打包的根证书；
        // 同时开启双栈择优，避免「IPv6 能解析但路由不通」。
        ...(u.protocol === 'https:' ? httpsOptions() : {}),
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          'user-agent': DEFAULT_UA,
          'accept-encoding': 'identity', // 避免 gzip 让 SSE 分帧变复杂
          ...headers
        }
      },
      (res) => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          raw: res,
          text: () => readAll(res, res.headers['content-encoding']),
          destroy: () => res.destroy()
        });
      }
    );

    req.on('error', (e) => reject(normalizeNetError(e)));
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new OfmError(Codes.TIMEOUT, `上游连接超时（${timeoutMs}ms）`));
      });
    }
    if (signal) {
      if (signal.aborted) {
        req.destroy(new OfmError(Codes.TRANSPORT, '请求已被取消'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new OfmError(Codes.TRANSPORT, '请求已被取消')), {
        once: true
      });
    }
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 把 OpenSSL / getaddrinfo 的错误码翻译成能直接给用户在手机上看的一句话。
 * 以前只回 `unable to verify the first certificate`，界面上一句「拉取失败」，
 * 根本分不清是没网、DNS 被污染，还是根证书缺失。
 */
const NET_HINTS = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链校验失败：缺少根证书，或网络被中间人代理',
  UNABLE_TO_GET_ISSUER_CERT: '找不到证书签发者：根证书不全',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '找不到本地根证书',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链含自签证书：可能被代理 / 抓包拦截',
  DEPTH_ZERO_SELF_SIGNED_CERT: '上游返回自签证书',
  CERT_HAS_EXPIRED: '上游证书已过期：检查手机系统时间',
  CERT_NOT_YET_VALID: '上游证书尚未生效：检查手机系统时间',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配：可能被 DNS 劫持',
  ENOTFOUND: '域名解析失败：DNS 被污染或没有外网',
  EAI_AGAIN: '域名解析临时失败',
  ENODATA: '域名解析成功但没有返回地址',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
  ENETUNREACH: '网络不可达：检查手机联网或 VPN',
  EHOSTUNREACH: '主机不可达',
  ETIMEDOUT: '连接超时',
  EPERM: '系统拒绝联网：检查联网权限或防火墙',
  EACCES: '系统拒绝访问网络',
  ERR_SOCKET_TIMEOUT: 'Socket 超时',
  TIMEOUT: '本步探测超时'
};

export function describeNetError(e) {
  const code = String(e?.code || '').toUpperCase();
  return NET_HINTS[code] || '';
}

function normalizeNetError(e) {
  if (e instanceof OfmError) return e;
  const code = e?.code;
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new OfmError(Codes.TIMEOUT, `上游连接超时: ${e.message}`);
  }
  const hint = describeNetError(e);
  const msg = `上游连接失败: ${e.message}${hint ? `（${hint}）` : ''}`;
  return new OfmError(Codes.TRANSPORT, msg, { detail: code });
}

/**
 * 按 `content-encoding` 解压响应体。
 *
 * 为什么必须有：内嵌 Node 没有 fetch，`node:http` 只给原始字节。TRAE 的签到
 * 请求头带 `Accept-Encoding: gzip, deflate`，小响应不压缩、大响应（余额明细）
 * 压缩 —— 于是同一个渠道「签到正常、余额报非 JSON」。解压失败一律回退原文，
 * 绝不因为一个坏头把整段响应丢掉。
 */
export function decodeBody(buf, encoding = '') {
  if (!buf || buf.length === 0) return buf;
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf); // 少数网关发裸 deflate
      }
    }
    // 网关漏发 content-encoding 但实际压缩：按 gzip 魔数嗅探
    if (enc === '' && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return zlib.gunzipSync(buf);
    }
  } catch {
    /* 解压失败：原样返回，让上层把真实错误显示出来 */
  }
  return buf;
}

export async function readAll(stream, encoding = '') {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return decodeBody(Buffer.concat(chunks), encoding).toString('utf8');
}

/**
 * 读 SSE 的关键：既要能按帧切分，又要能在「上游用 application/json 返回整段 SSE」
 * 这种降级形态下工作（见 §6.2）。
 *
 * 返回 async generator，产出 {event, data, raw}；同时把每个原始 chunk 交给 onChunk，
 * 方便上层做空闲超时。
 */
export async function* iterateSse(stream, options = {}) {
  const {
    idleTimeoutMs = 120000,
    onIdle = null,
    signal = null,
    // 只看「有效事件」的首帧超时：注释帧/心跳帧不算内容，不会给它续命。
    // 上游若 200 之后一直只吐 `: keepalive`，旧逻辑会被每个 chunk 重置空闲计时，
    // 导致流永不结束也永不出内容 —— 第三方表现为「接入 API 无回复」。
    firstEventTimeoutMs = 0
  } = options;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawEvent = false;
  let firstEventTimer = null;

  // 掐断流：真实场景是 IncomingMessage（有 destroy）；测试或包装层可能是
  // async generator（只有 return）。两种都要能停下来，否则超时形同虚设。
  const killStream = (err) => {
    try {
      if (typeof stream?.destroy === 'function') stream.destroy(err);
      else if (typeof stream?.return === 'function') stream.return();
    } catch {
      /* noop */
    }
  };

  if (firstEventTimeoutMs > 0) {
    firstEventTimer = setTimeout(() => {
      if (!sawEvent) {
        killStream(
          new OfmError(Codes.TIMEOUT, `上游 ${Math.round(firstEventTimeoutMs / 1000)} 秒内没有返回任何有效内容帧`)
        );
      }
    }, firstEventTimeoutMs);
    if (firstEventTimer.unref) firstEventTimer.unref();
  }

  // 默认行为：空闲超时直接掐掉 socket，否则 for-await 会永远挂住
  const idleHandler =
    onIdle ||
    (() => {
      killStream(new OfmError(Codes.TIMEOUT, `上游超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有输出`));
    });

  const markFirstEvent = () => {
    if (sawEvent) return;
    sawEvent = true;
    if (firstEventTimer) {
      clearTimeout(firstEventTimer);
      firstEventTimer = null;
    }
  };

  const deadline = createIdleWatchdog(idleTimeoutMs, idleHandler);
  if (signal) {
    signal.addEventListener('abort', () => deadline.fire(), { once: true });
  }

  try {
    for await (const chunk of stream) {
      deadline.tick();
      buffer += decoder.decode(chunk, { stream: true });
      // SSE 事件以空行分隔；\r\n 也要认。
      // ⚠️ findEventBoundary 返回的是 {start,end} 对象，绝不能写成
      // `while ((idx = findEventBoundary(buffer)) >= 0)` —— 对象与 0 比较
      // 恒为 false，循环一次都不进，整条流只会在结束时被当成「一帧」解析：
      // 多个 event 被合并成最后一个事件名 + 全部 data，JSON.parse 必然失败，
      // 于是上游明明有输出、本机却零正文（「接入 API 无回复」的总根因）。
      let idx = findEventBoundary(buffer);
      while (idx !== -1) {
        const raw = buffer.slice(0, idx.start);
        buffer = buffer.slice(idx.end);
        const evt = parseEvent(raw);
        if (evt) {
          markFirstEvent();
          yield evt;
        }
        idx = findEventBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const evt = parseEvent(buffer);
      if (evt) {
        markFirstEvent();
        yield evt;
      }
    }
  } finally {
    deadline.stop();
    if (firstEventTimer) clearTimeout(firstEventTimer);
  }
}

function findEventBoundary(buf) {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a < 0 && b < 0) return -1;
  if (b >= 0 && (a < 0 || b < a)) return { start: b, end: b + 4 };
  return { start: a, end: a + 2 };
}

export function parseEvent(raw) {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  let event = '';
  const dataLines = [];
  let sawField = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // 注释帧（心跳）
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    sawField = true;
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!sawField) return null;
  return { event, data: dataLines.join('\n'), raw };
}

function createIdleWatchdog(ms, onFire) {
  let timer = null;
  const arm = () => {
    if (!ms || ms <= 0) return;
    timer = setTimeout(() => {
      if (onFire) onFire();
    }, ms);
    if (timer.unref) timer.unref();
  };
  arm();
  return {
    tick() {
      if (timer) clearTimeout(timer);
      arm();
    },
    fire() {
      if (onFire) onFire();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

/**
 * 上游有时把整段 SSE 用 application/json 吐回来（网关高负载）。
 * 嗅探首块内容：以 data:/event:/: 开头就当 SSE 处理。
 */
export function looksLikeSse(head) {
  const s = head.replace(/^\uFEFF/, '').trimStart();
  return s.startsWith('data:') || s.startsWith('event:') || s.startsWith(':');
}
