/**
 * TRAE 协议层：请求体转换 + 自定义 SSE 解析（§5.1）。
 */
import crypto from 'node:crypto';
import { TRAE } from './product.js';
import { OfmError, Codes } from '../../errors.js';
import { attachCacheTokens } from '../../usage-cache.js';

export function deriveRotatingMachineId(machineId, generation) {
  if (!generation || generation <= 0) return machineId;
  return crypto.createHash('sha256').update(`${machineId}#machine${generation}`).digest('hex').slice(0, 32);
}

/** 对话 / 模型目录共用的一套头 */
export function traeHeaders({ accessToken, uid, machineId, deviceId, accept = 'text/event-stream' }) {
  return {
    accept,
    'content-type': 'application/json',
    'user-agent': TRAE.userAgent,
    authorization: `Cloud-IDE-JWT ${accessToken}`,
    'x-cloudide-token': accessToken,
    'x-ide-token': accessToken,
    'x-uid': uid || '',
    'x-app-id': TRAE.appId,
    'x-app-version': 'default',
    'x-ide-version': TRAE.ideVersion,
    'x-ide-version-code': TRAE.ideVersionCode,
    'x-app-version-code': TRAE.ideVersionCode,
    'x-ide-version-type': 'stable',
    'x-device-type': 'macos',
    'x-os-version': TRAE.osVersion,
    'x-device-brand': TRAE.deviceBrand,
    'request-traffic-type': 'prod',
    'x-machine-id': machineId,
    'x-device-id': deviceId
  };
}

/** 回调地址：TRAE 的授权页里写死了这个端口，参数名必须是 auth_callback_url */
export const TRAE_CALLBACK_URL = 'http://127.0.0.1:18080/authorize';

export function buildLoginUrl({ machineId, deviceId }) {
  const params = {
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: TRAE.pluginVersion,
    auth_type: 'local',
    client_id: TRAE.clientId,
    redirect: '0',
    login_trace_id: `${machineId}${deviceId}`.slice(-16).padStart(16, '0'),
    auth_callback_url: TRAE_CALLBACK_URL,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: 'PC',
    x_device_type: 'PC',
    x_os_version: '1.0',
    x_app_version: '0.1.52',
    x_app_type: 'stable'
  };
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${TRAE.consoleHost}/authorization?${qs}`;
}

/**
 * 把请求的输出额度收敛到安全范围。
 *
 * 三条规则（对齐上游 `clampTraeMaxTokens` + `readDetailMaxTokens`）：
 *  1. 客户端没指定 → 用上游同款默认 32000，**绝不**直接发 64000；
 *  2. 模型目录声明了 `max_tokens`（`model_detail_list[].max_tokens`）→ 以它为上限；
 *  3. 再套全局 64000 安全线。
 *
 * 为什么不能无脑发 64000：多数模型上限只有 32K 或更低。超限时 TRAE 不会回
 * `event:error`，而是建好会话、只发一帧 `metadata` 就断流 —— 客户端看到的是
 * 「HTTP 200 + 零正文」，正是「接入 API 无回复」的成因之一。
 */
export function resolveMaxTokens({
  asked,
  modelMaxOutputTokens,
  globalCap = TRAE.maxOutputTokens,
  fallback = TRAE.defaultMaxOutputTokens
} = {}) {
  const num = Number(asked);
  const want = Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
  const modelCap = Number(modelMaxOutputTokens);
  const caps = [globalCap, Number.isFinite(modelCap) && modelCap > 0 ? Math.floor(modelCap) : null].filter(
    (n) => Number.isFinite(n) && n > 0
  );
  const limit = caps.length ? Math.min(...caps) : want;
  return Math.max(1, Math.min(want, limit));
}

/**
 * OpenAI 请求体 → SOLO 请求体。九条规则逐条实现：
 *  1) stream 强制 true；2) function 用模型所属通道；3) model/config_name 双写；
 *  4) content 字符串 → 数组；5) assistant 的 tool_calls.function → function_call；
 *  6) tools.parameters → JSON 字符串；7) tool_choice 归一化；
 *  8) reasoning_effort 原样透传；9) 输出上限按模型上限收敛。
 */
export function transformToSoloBody(req, { channel, modelId, maxOutputTokens } = {}) {
  const body = {
    model: stripDevSuffix(modelId),
    config_name: stripDevSuffix(modelId),
    stream: true,
    function: channel || TRAE.function,
    messages: (req.messages || []).map(transformMessage)
  };

  // 出口兜底：上游 Go 侧 content 是 LLMRawMessageContent，收到字符串直接
  // 400「cannot unmarshal string into ... messages.content」。不管哪条消息类型
  // 走漏，这里统一改成内容块数组，避免一条脏消息毁掉整单请求。
  for (const m of body.messages) {
    if (Array.isArray(m.content)) continue;
    m.content = m.content === undefined || m.content === null || m.content === ''
      ? []
      : [{ type: 'text', text: String(m.content) }];
  }

  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: JSON.stringify(t.parameters || { type: 'object', properties: {} })
      }
    }));
  }

  applyToolChoice(body, req.toolChoice);

  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort; // 不做白名单校验
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop) body.stop = req.stop;

  body.max_tokens = resolveMaxTokens({
    asked: req.maxTokens,
    modelMaxOutputTokens: maxOutputTokens
  });

  return body;
}

export function stripDevSuffix(modelId) {
  return String(modelId).includes('__') ? String(modelId).split('__')[0] : String(modelId);
}

function transformMessage(m) {
  const out = { role: m.role };
  if (m.role === 'tool') {
    // ⚠️ content 必须是**内容块数组**，不能是字符串。
    // 实测（2026-11-09）：tool 消息发字符串会直接 400 ——
    //   json: cannot unmarshal string into Go struct field
    //   LLMRawMessage.messages.content of type idecopilot.LLMRawMessageContent
    // TRAE 的 Go 侧把 content 定义成 LLMRawMessageContent（对象/数组），
    // 全协议统一用数组；tool 结果只是内容为纯文本的数组而已。
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
          : String(m.content ?? '');
    out.content = [{ type: 'text', text }];
  } else if (typeof m.content === 'string') {
    // 空串不要再包一个空文本块：assistant 带 tool_calls 时正文本来就是空的，
    // 空 text 块在部分上游会被判成非法内容。
    out.content = m.content ? [{ type: 'text', text: m.content }] : [];
  } else if (Array.isArray(m.content)) {
    out.content = m.content.map((b) =>
      b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'image' ? { type: 'image_url', image_url: { url: b.url } } : b
    );
  } else if (m.content === null || m.content === undefined) {
    out.content = [];
  }

  if (m.role === 'assistant' && m.tool_calls?.length) {
    out.tool_calls = m.tool_calls
      .filter((tc) => tc.name)
      .map((tc) => {
        const fn = { name: tc.name, arguments: tc.arguments || '{}' };
        // TRAE 的 wire 用 function_call，标准 OpenAI 用 function。上游两个版本
        // 都出现过，只写一个就会在多轮工具调用里静默丢参数，所以双写。
        return { id: tc.id, type: 'function', function: fn, function_call: fn };
      });
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}

function applyToolChoice(body, choice) {
  if (!choice) return;
  if (choice === 'none') {
    delete body.tool_choice;
    delete body.tools;
    return;
  }
  if (choice === 'auto' || choice === 'required') {
    body.tool_choice = choice;
    return;
  }
  if (typeof choice === 'object' && choice.name) {
    body.tool_choice = choice.name; // 只留 name 字符串
  }
}

/** Max 模式（1M 上下文）整套字段 —— 只改 max_tokens 无效 */
export function applyMaxMode(body, { contextWindow, maxTokens }) {
  body.model_auto_selection = {
    strategy: 'max',
    fallback_to_advance_model: null,
    entitlement_id: null
  };
  body.model_selection_strategy = 'max';
  body.mode_type = 1;
  if (contextWindow) body.context_window_size = contextWindow;
  body.prompt_max_tokens = 936000;
  body.max_tokens = Math.min(maxTokens || 64000, 64000);
  return body;
}

/**
 * 解析一帧 TRAE SSE。
 * 返回 {event, response?, reasoningContent?, toolCalls?, usage?, finishReason?, errorCode?, errorMessage?}
 */
export function parseTraeEvent(event, dataLine) {
  if (!dataLine) return { event };
  let raw;
  try {
    raw = JSON.parse(dataLine);
  } catch {
    return { event };
  }
  const hasBizError =
    raw &&
    typeof raw === 'object' &&
    ((raw.code !== undefined && raw.code !== 0) || (raw.error != null && raw.error !== false));
  if (hasBizError && !raw.choices) {
    // 流内业务错误（含排队）；也覆盖 200 + JSON 错误体这种非 SSE 降级形态
    throw traeBusinessError(raw);
  }
  // 上游网关高负载 / 版本差异时可能改回标准 OpenAI chunk 形状，且常常不带
  // event 行（只有 `data: {...}`）。以前这类帧全走 default 被丢掉，整条流
  // 解析出 0 个正文 → 第三方「接入 API 无回复」。这里统一兜住。
  if (raw && Array.isArray(raw.choices) && raw.choices.length && !raw.response && !raw.tool_calls) {
    return fromOpenAiChunk(raw, event);
  }
  switch (event) {
    case 'output':
      return {
        event,
        response: typeof raw.response === 'string' ? raw.response : undefined,
        reasoningContent: typeof raw.reasoning_content === 'string' ? raw.reasoning_content : undefined,
        toolCalls: extractToolCalls(raw)
      };
    case 'token_usage':
      return { event, usage: mapUsage(raw) };
    case 'done':
      return { event, finishReason: typeof raw.finish_reason === 'string' ? raw.finish_reason : 'stop' };
    case 'error':
      throw traeBusinessError(raw);
    default:
      // 上游换了 event 名（message / content / 空）但字段仍是 TRAE 自定义形状。
      // 以前这类帧直接丢弃，是「请求成功却无回复」的主要来源之一。
      if (raw && typeof raw === 'object' &&
          (raw.response !== undefined || raw.reasoning_content !== undefined || extractToolCalls(raw))) {
        return {
          event,
          response: typeof raw.response === 'string' ? raw.response : undefined,
          reasoningContent: typeof raw.reasoning_content === 'string' ? raw.reasoning_content : undefined,
          toolCalls: extractToolCalls(raw)
        };
      }
      return { event };
  }
}

/**
 * 兼容上游出现过的四种工具帧形状：
 *  1) `{ tool_calls: [...] }`            标准批量
 *  2) `{ tool_call: {...} }`             单数（TRAE 部分版本）
 *  3) `{ delta: { tool_calls: [...] } }` 只在 delta 里
 *  4) `{ function_call: {...} }`         老式单次调用
 * 任一命中都归一化成数组，raw.tool_calls 保留原 index 供上层归并分片。
 */
export function extractToolCalls(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidates = [raw.tool_calls, raw.tool_call, raw.delta?.tool_calls, raw.function_call];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c.map(normalizeToolCall);
    if (c && typeof c === 'object' && !Array.isArray(c)) return [normalizeToolCall(c)];
  }
  return undefined;
}

/** 标准 OpenAI chunk / 完成对象 → TRAE 统一事件形状（让 stream() 无需分支） */
function fromOpenAiChunk(raw, event) {
  const choice = raw.choices?.[0] || {};
  const delta = choice.delta || choice.message || {};
  let content;
  if (typeof delta.content === 'string') content = delta.content;
  else if (Array.isArray(delta.content)) {
    content = delta.content
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .join('');
  }
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  return {
    event: event || 'output',
    response: typeof content === 'string' && content ? content : undefined,
    reasoningContent: typeof reasoning === 'string' && reasoning ? reasoning : undefined,
    toolCalls: Array.isArray(delta.tool_calls) ? delta.tool_calls.map(normalizeToolCall) : undefined,
    usage: raw.usage ? mapUsage(raw.usage) : undefined,
    finishReason: choice.finish_reason || undefined
  };
}

export function traeBusinessError(raw) {
  const code = Number(raw.code ?? raw.error?.code ?? -1);
  const message = String(raw.message ?? raw.error?.message ?? 'unknown error');
  if (code === 10605) {
    const retryAfterMs = parseQueueRetry(raw);
    return new OfmError(Codes.MODEL_QUEUED, `模型排队中，约 ${Math.round(retryAfterMs / 1000)} 秒后重试`, {
      retryAfterMs
    });
  }
  if (code === 110 || /daily count exceeded/i.test(message)) {
    return new OfmError(Codes.QUOTA_EXCEEDED, `额度已用尽: ${message}`);
  }
  if (code === 105 || code === 401) {
    return new OfmError(Codes.AUTH, `认证失败: ${message}`);
  }
  if (code === 4001) {
    return new OfmError(Codes.INVALID_REQUEST, `参数无效（可能是模型不属于该通道）: ${message}`, { status: 400 });
  }
  return new OfmError(Codes.UPSTREAM, `TRAE 上游错误 ${code}: ${message}`);
}

function parseQueueRetry(raw) {
  const direct = Number(raw.retry_after_ms);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const secs = Number(raw.retry_after_seconds ?? raw.retryAfterSeconds);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  return 30000;
}

/**
 * 统一单条工具调用。
 *
 * 上游有两处容易踩的坑：
 *  1) 字段名是 `function_call` 而不是 `function`；
 *  2) 增量参数放在 `partial_arguments`，`arguments` 为空 —— 以前直接
 *     `delete partial_arguments`，等于把工具参数整段扔掉，客户端只拿到
 *     一个空参数的工具调用，AI 就「无法使用工具」。
 */
export function normalizeToolCall(call) {
  if (!call || typeof call !== 'object') return call;
  const out = { ...call };
  // 顶层老式 function_call → function
  if (!out.function && out.function_call && typeof out.function_call === 'object') {
    out.function = { ...out.function_call };
  }
  if (out.function && typeof out.function === 'object') {
    const fn = { ...out.function };
    const partial = typeof fn.partial_arguments === 'string' ? fn.partial_arguments : '';
    const base = typeof fn.arguments === 'string' ? fn.arguments : '';
    // partial 是增量：arguments 已经是累计值时不要重复拼接。
    // TRAE 的分片帧常见 arguments 为空、partial 为增量，两者拼接即可。
    if (partial) fn.arguments = base.includes(partial) && base.length >= partial.length ? base : base + partial;
    else if (typeof fn.arguments !== 'string') fn.arguments = '';
    // ⚠️ 不要按 `/` 截断 name：部分客户端的 MCP 工具名本身就带 `/`，
    // 截断后客户端按名字匹配不到工具，表现同样是「AI 不能用工具」。
    delete fn.namespace; // 命名空间不是 OpenAI 字段，原样下发会让客户端匹配不到工具
    delete fn.partial_arguments;
    out.function = fn;
  }
  return out;
}

export function mapUsage(u) {
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  // 旧版只留 3 个总数，把 prompt_tokens_details / cache_* 全削掉了，
  // 导致上游即使上报了缓存命中，用量看板也永远记 0。
  return attachCacheTokens({
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(u.total_tokens ?? prompt + completion) || prompt + completion
  }, u);
}

export function mapFinishReason(reason) {
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  if (reason === 'tool_calls' || reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

/** 把回调 query 里的字段解出来（userInfo/userJwt 是 URL 编码 JSON，可能双重编码） */
export function parseCallbackQuery(url) {
  const u = new URL(url);
  const q = u.searchParams;
  const pick = (k) => q.get(k) ?? '';
  return {
    raw: url,
    refreshToken: pick('refreshToken') || pick('refresh_token'),
    userId: pick('userId') || pick('uid'),
    userInfo: pick('userInfo'),
    userJwt: pick('userJwt'),
    code: pick('code') || pick('authCode') || pick('authCodeInfo')
  };
}
