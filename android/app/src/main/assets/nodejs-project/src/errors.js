/**
 * 统一错误码。上游各家的错误形状千奇百怪（HTTP 码 + 业务码 + 字符串套 JSON），
 * 到这一层必须收敛成可判定的几类，否则重试/续期/换账号的决策会散落各处。
 */

export const Codes = {
  AUTH: 'AUTH', // 需重新登录（或首次登录失效）
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED', // 额度用尽（该账号当天不可用）
  MODEL_QUEUED: 'MODEL_QUEUED', // 上游排队，可按 retryAfterMs 精确等待后重试
  RATE_LIMITED: 'RATE_LIMITED', // 本地账号池全部处于限流期
  TRANSPORT: 'TRANSPORT', // 连接失败/断流，可重试
  TIMEOUT: 'TIMEOUT', // 首 token 或空闲超时，可重试
  SERVER: 'SERVER', // 上游 5xx，可重试
  INVALID_REQUEST: 'INVALID_REQUEST', // 请求本身不合法，不要重试
  NO_ACCOUNT: 'NO_ACCOUNT', // 该渠道没有可用账号
  UNSUPPORTED: 'UNSUPPORTED', // 渠道/能力未实现
  EMPTY_REPLY: 'EMPTY_REPLY', // 上游返回了响应但解析不出任何正文（帧格式不认识 / 空流）
  UPSTREAM: 'UPSTREAM' // 其它上游业务错误，原样透传
};

const HTTP_STATUS = {
  AUTH: 401,
  QUOTA_EXCEEDED: 429,
  MODEL_QUEUED: 429,
  RATE_LIMITED: 429,
  TRANSPORT: 502,
  TIMEOUT: 504,
  SERVER: 502,
  INVALID_REQUEST: 400,
  NO_ACCOUNT: 400,
  UNSUPPORTED: 501,
  EMPTY_REPLY: 502,
  UPSTREAM: 502
};

const RETRYABLE = new Set(['TRANSPORT', 'TIMEOUT', 'SERVER', 'MODEL_QUEUED']);

export class OfmError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'OfmError';
    this.code = code;
    this.status = options.status ?? HTTP_STATUS[code] ?? 500;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.retryAfterMs = options.retryAfterMs ?? 0;
    this.provider = options.provider;
    this.accountId = options.accountId;
    this.detail = options.detail;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retry_after_ms: this.retryAfterMs || undefined,
      provider: this.provider,
      detail: this.detail
    };
  }
}

export function ofmError(code, message, options) {
  return new OfmError(code, message, options);
}

/** OpenAI 形状的错误体（本机 API 对外只用这一种） */
export function openAiErrorBody(err) {
  const type =
    err.code === Codes.AUTH
      ? 'authentication_error'
      : err.status === 404
        ? 'not_found_error'
        : err.code === Codes.INVALID_REQUEST || err.code === Codes.NO_ACCOUNT || err.code === Codes.UNSUPPORTED || err.status === 400
          ? 'invalid_request_error'
          : err.code === Codes.RATE_LIMITED || err.code === Codes.QUOTA_EXCEEDED || err.code === Codes.MODEL_QUEUED
            ? 'rate_limit_error'
            : 'api_error';
  return {
    error: {
      message: err.message,
      type,
      code: err.code,
      ...(err.retryAfterMs ? { retry_after_ms: err.retryAfterMs } : {}),
      ...(err.provider ? { provider: err.provider } : {})
    }
  };
}

export function isOfmError(e) {
  return e instanceof OfmError;
}

/** 把任意异常包成 OfmError，避免上层到处 try/catch 分类型 */
export function normalizeError(e, fallbackCode = Codes.UPSTREAM) {
  if (e instanceof OfmError) return e;
  const msg = e?.message || String(e);
  if (/ETIMEDOUT|timeout|timed out/i.test(msg)) return new OfmError(Codes.TIMEOUT, msg);
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|socket hang up|network/i.test(msg)) {
    return new OfmError(Codes.TRANSPORT, msg);
  }
  return new OfmError(fallbackCode, msg, { detail: e?.stack });
}
