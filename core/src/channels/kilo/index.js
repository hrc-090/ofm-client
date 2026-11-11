/**
 * Kilo 免费池渠道（移植自上游 src/kilo.js）。
 *
 * Kilo AI 的公共网关 free pool 不需要任何凭据：无 key、无登录、无指纹校验。
 * 因此这是最简单的渠道 —— 固定 base URL、一次普通 POST、沿用免费池自己的
 * 流式纪律。代价写在网关的模型卡上，也必须摆在用户面前：
 * **免费池的 prompt 可能被上游记录并用于改进服务**，只适合一次性任务，
 * 不要贴密钥、隐私或公司内部资料。
 *
 * 模型清单取 listing 里 `isFree === true` 的那一片；其余是付费 id，
 * 在这里请求只会拿到 401。
 */
import { openUpstream } from '../../http-client.js';
import { openAiCompatStream } from '../../openai-compat.js';
import { toOpenAiMessages, toOpenAiTools } from '../../convert/openai-chat.js';
import { OfmError, Codes } from '../../errors.js';
import { tryJson } from '../../util.js';

const DEFAULT_BASE = 'https://ai-gateway.kilo.ai/api/v1';
const LISTING_TIMEOUT_MS = 15000;
const TURN_TIMEOUT_MS = 300000;

/** 网关自己的客户端会带的归属头；文档标为可选，不伪装成编辑器。 */
const ATTRIBUTION = {
  'http-referer': 'https://kilo.ai/',
  'x-title': 'OFM'
};

/**
 * 清单拉不到时的兜底：只放网关自带的自动路由 id。
 * 不猜具体模型 id —— 猜错会让用户点进去就 401。
 */
const FALLBACK_MODELS = [
  {
    id: 'kilo-auto/free',
    displayName: 'Kilo Auto（免费池自动路由）',
    contextWindow: 128000,
    multimodal: false,
    reasoning: false,
    fallback: true
  }
];

let listingCache = null;
let listingETag = null;

function base() {
  const v = process.env.OFM_KILO_BASE || DEFAULT_BASE;
  return String(v).replace(/\/+$/, '');
}

/** 列表探测不花生成：GET /models，带 ETag 条件请求。 */
async function fetchListing(signal) {
  const headers = {
    accept: 'application/json',
    'user-agent': 'ofm-android',
    ...ATTRIBUTION,
    ...(listingETag ? { 'if-none-match': listingETag } : {})
  };
  const res = await openUpstream(`${base()}/models`, {
    method: 'GET',
    headers,
    timeoutMs: LISTING_TIMEOUT_MS,
    signal
  });
  if (res.status === 304 && listingCache) return listingCache;
  const text = await res.text();
  if (res.status >= 400) {
    throw new OfmError(
      res.status === 429 ? Codes.QUOTA_EXCEEDED : Codes.UPSTREAM,
      `Kilo 模型清单 HTTP ${res.status}: ${text.slice(0, 200)}`,
      { status: res.status }
    );
  }
  const payload = tryJson(text, undefined);
  if (!payload) throw new OfmError(Codes.UPSTREAM, 'Kilo 模型清单不是合法 JSON');
  const etag = res.headers.etag;
  if (typeof etag === 'string' && etag !== '') {
    listingETag = etag;
    listingCache = payload;
  }
  return payload;
}

/** listing 的条目形状兼容 OpenAI `{data:[...]}` 与裸数组。 */
function rowsOf(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  return Array.isArray(rows) ? rows : [];
}

function isFree(row) {
  return row?.isFree === true || row?.is_free === true || row?.free === true;
}

function toEntry(row) {
  const id = String(row?.id ?? row?.name ?? '').trim();
  if (!id) return null;
  const ctx = Number(row?.context_length ?? row?.context_window ?? row?.contextWindow);
  return {
    id,
    displayName: String(row?.name ?? row?.display_name ?? id),
    contextWindow: Number.isFinite(ctx) && ctx > 0 ? Math.trunc(ctx) : undefined,
    multimodal: row?.architecture?.input_modalities?.includes?.('image') === true || row?.multimodal === true,
    reasoning: row?.supports_reasoning === true || row?.reasoning === true,
    // 免费池标记，App 侧可加徽章
    free: true
  };
}

export class KiloChannel {
  constructor({ listingImpl = null } = {}) {
    this.id = 'kilo';
    this.name = 'kilo';
    this.displayName = 'Kilo 免费池';
    this.loginMode = 'none';
    this.requiresAccount = false;
    this.supported = true;
    this.note = '无需登录；免费池 prompt 可能被上游记录，勿贴敏感内容';
    this.lastModelWarning = null;
    // 可注入：验收测试用 mock 清单，不联网
    this.listingImpl = listingImpl;
  }

  async listModels({ signal } = {}) {
    try {
      const payload = await (this.listingImpl || fetchListing)(signal);
      const entries = rowsOf(payload)
        .filter(isFree)
        .map(toEntry)
        .filter(Boolean);
      if (entries.length === 0) throw new Error('免费池清单为空');
      this.lastModelWarning = null;
      return entries;
    } catch (e) {
      // 目录失败不挡主流程：回退到自动路由，用户仍能用一条可用链路。
      this.lastModelWarning = String(e?.message || '未知原因').slice(0, 200);
      return FALLBACK_MODELS.map((m) => ({ ...m }));
    }
  }

  async *stream(req, { signal } = {}) {
    const body = {
      model: req.modelId,
      messages: toOpenAiMessages(req.messages),
      stream: true
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.topP != null) body.top_p = req.topP;
    if (req.stop) body.stop = req.stop;
    if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
    const tools = toOpenAiTools(req.tools);
    if (tools?.length) body.tools = tools;

    yield* openAiCompatStream({
      url: `${base()}/chat/completions`,
      headers: { ...ATTRIBUTION },
      body,
      timeoutMs: TURN_TIMEOUT_MS,
      signal,
      onHttpError: (status, text, headers) => classifyKilo(status, text, headers)
    });
  }
}

/**
 * Kilo 的拒绝信封把类别写两遍：`error.code` 与 `error_type`，
 * 而通用分类器读 `error.type`，先整形再判。
 *
 * 两个本渠道专有的码要单独给答案：
 *  - 付费 id 无 key 请求 → 这是「选错了模型」，不是凭据坏了；
 *  - 明确的内容审核拦截 → 上游的答复，不是传输故障。
 */
function classifyKilo(status, text, headers) {
  const payload = tryJson(text, {}) || {};
  const type = payload?.error_type ?? payload?.error?.code ?? payload?.error?.type;
  const rawMeta = payload?.error?.metadata?.raw ?? payload?.metadata?.raw;
  let message = payload?.error?.message ?? (typeof payload?.message === 'string' ? payload.message : undefined);

  if (typeof rawMeta === 'string' && rawMeta.trim()) {
    let detail = '';
    try {
      const parsed = JSON.parse(rawMeta);
      detail =
        typeof parsed?.error === 'string'
          ? parsed.error
          : typeof parsed?.message === 'string'
            ? parsed.message
            : typeof parsed?.error?.message === 'string'
              ? parsed.error.message
              : '';
    } catch {
      detail = rawMeta.slice(0, 200).trim();
    }
    const provider = payload?.error?.metadata?.provider_name ?? payload?.metadata?.provider_name;
    const suffix = typeof provider === 'string' && provider ? ` (${provider})` : '';
    if (detail) message = message ? `${message}: ${detail}${suffix}` : `${detail}${suffix}`;
  }

  const retrySec = Number(headers?.['retry-after']);
  const retryAfterMs = Number.isFinite(retrySec) && retrySec > 0 ? Math.trunc(retrySec * 1000) : undefined;

  if (typeof type === 'string' && /PAID_MODEL_AUTH_REQUIRED/i.test(type)) {
    return new OfmError(
      Codes.INVALID_REQUEST,
      '这个模型不在免费池里：它需要 Kilo 账号，本渠道不提供。请在模型页换一个带「免费」标记的模型。',
      { status: 401 }
    );
  }

  const msg = String(message || `HTTP ${status}`);
  if (/moderation|flagged|filtered/i.test(msg)) {
    return new OfmError(Codes.INVALID_REQUEST, `Kilo 内容审核拦截：${msg.slice(0, 200)}`, { status });
  }
  if (status === 429) {
    return new OfmError(Codes.QUOTA_EXCEEDED, `Kilo 免费池限流：${msg.slice(0, 200)}`, {
      status,
      retryAfterMs: retryAfterMs ?? 60000
    });
  }
  if (status === 401 || status === 403) {
    return new OfmError(Codes.AUTH, `Kilo 拒绝：${msg.slice(0, 200)}`, { status });
  }
  return new OfmError(Codes.UPSTREAM, `Kilo HTTP ${status}: ${msg.slice(0, 200)}`, { status, retryAfterMs });
}
