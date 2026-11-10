/**
 * OpenAI 兼容推理层（§6.2）。
 *
 * 七家渠道的 wire 形状都是 OpenAI Chat + SSE，差别只在 URL/头/少量字段，
 * 所以共用这一层；渠道只提供 headers / body / 错误判定。
 *
 * 三个必须固化的细节：
 *  1. 首 token 超时与帧间空闲超时分开；
 *  2. **按响应体形状**判定是否 SSE（网关会用 application/json 回整段 SSE）；
 *  3. tool_calls 的 index 要重新从 0 编号 —— 上游的 index 是「块序号」，
 *     思考/正文块会占号，客户端按 index 累加就会得到稀疏数组。
 */
import { openUpstream, looksLikeSse } from './http-client.js';
import { OfmError, Codes } from './errors.js';
import { tryJson } from './util.js';
import { attachCacheTokens } from './usage-cache.js';

const DEFAULT_FIRST_TOKEN_MS = 60000;
const DEFAULT_IDLE_MS = 120000;

/**
 * @param {object} options
 * @param {string} options.url
 * @param {object} options.headers
 * @param {object|string} options.body
 * @param {number} [options.firstTokenTimeoutMs]
 * @param {number} [options.idleTimeoutMs]
 * @param {(status:number, text:string, headers:object)=>Error} [options.onHttpError]
 * @param {(json:object)=>void} [options.inspectChunk] 用于识别业务错误帧（Qoder / TRAE）
 * @param {AbortSignal} [options.signal]
 */
export async function* openAiCompatStream(options) {
  const {
    url,
    headers = {},
    body,
    firstTokenTimeoutMs = DEFAULT_FIRST_TOKEN_MS,
    idleTimeoutMs = DEFAULT_IDLE_MS,
    onHttpError,
    inspectChunk,
    signal
  } = options;

  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await openUpstream(url, {
    method: 'POST',
    headers: {
      accept: 'text/event-stream, application/json',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...headers
    },
    body: payload,
    timeoutMs: firstTokenTimeoutMs,
    signal
  });

  if (res.status < 200 || res.status >= 300) {
    const text = await res.text();
    if (onHttpError) throw onHttpError(res.status, text, res.headers);
    throw new OfmError(
      res.status === 401 || res.status === 403 ? Codes.AUTH : res.status === 429 ? Codes.QUOTA_EXCEEDED : Codes.UPSTREAM,
      `上游 HTTP ${res.status}: ${text.slice(0, 200)}`,
      { status: res.status }
    );
  }

  const iterator = res.raw[Symbol.asyncIterator]();
  let first;
  try {
    first = await iterator.next();
  } catch (e) {
    throw new OfmError(Codes.TRANSPORT, `读取上游响应失败: ${e.message}`);
  }
  if (first.done) throw new OfmError(Codes.TRANSPORT, '上游返回了空响应');

  const decoder = new TextDecoder('utf-8');
  const head = decoder.decode(first.value, { stream: true });

  if (!looksLikeSse(head)) {
    // 非 SSE：整体 JSON（普通完成对象，或网关降级后的整段内容）
    let rest = '';
    for await (const chunk of iterator) rest += decoder.decode(chunk, { stream: true });
    rest += decoder.decode();
    const full = head + rest;
    const parsed = tryJson(full, undefined);
    if (parsed === undefined) {
      throw new OfmError(Codes.UPSTREAM, `上游返回了无法解析的响应: ${full.slice(0, 200)}`);
    }
    yield* deltasFromCompletion(parsed);
    return;
  }

  yield* consumeSse([head], iterator, {
    decoder,
    idleTimeoutMs,
    inspectChunk,
    destroy: () => {
      try {
        res.raw.destroy(new OfmError(Codes.TIMEOUT, `上游超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有输出，已中断`));
      } catch {
        /* noop */
      }
    }
  });
}

async function* consumeSse(prefetched, iterator, { decoder, idleTimeoutMs, inspectChunk, destroy }) {
  let buffer = prefetched.join('');
  let idleTimer = null;
  const arm = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // 光置标志位没用：卡在 iterator.next() 时根本走不到检查点
      if (destroy) destroy();
    }, idleTimeoutMs);
    if (idleTimer.unref) idleTimer.unref();
  };
  arm();

  try {
    // 先消化预取的 head 里已经完整的事件
    // ⚠️ findBoundary 返回 {start,end} 或 -1：绝不能写 `boundary < 0`。
    // 对象与数字比较恒为 false，循环不会退出，整条流会在原地空转
    // （工具调用是多帧流，必现；正文流也会挂住）。这与 http-client 里
    // `idx !== -1` 是同一个坑，这里是历史遗留的副本。
    while (true) {
      const boundary = findBoundary(buffer);
      if (boundary === -1) break;
      const raw = buffer.slice(0, boundary.start);
      buffer = buffer.slice(boundary.end);
      const evt = parseEvent(raw);
      if (evt) yield* handleSseEvent(evt, inspectChunk);
    }

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      arm();
      buffer += decoder.decode(next.value, { stream: true });

      while (true) {
        const boundary = findBoundary(buffer);
        if (boundary === -1) break;
        const raw = buffer.slice(0, boundary.start);
        buffer = buffer.slice(boundary.end);
        const evt = parseEvent(raw);
        if (evt) yield* handleSseEvent(evt, inspectChunk);
      }
    }

    buffer += decoder.decode();
    // ⚠️ 收尾：残留的最后一帧（没有结尾空行）必须再走一遍，否则 done/usage 丢失
    if (buffer.trim()) {
      const evt = parseEvent(buffer);
      if (evt) yield* handleSseEvent(evt, inspectChunk);
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function findBoundary(buf) {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a < 0 && b < 0) return -1;
  if (b >= 0 && (a < 0 || b < a)) return { start: b, end: b + 4 };
  return { start: a, end: a + 2 };
}

function parseEvent(raw) {
  const lines = raw.split(/\r?\n/);
  let event = '';
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!event && !data.length) return null;
  return { event, data: data.join('\n') };
}

function* handleSseEvent(evt, inspectChunk) {
  const payload = evt.data.trim();
  if (!payload) return;
  if (payload === '[DONE]') return;
  const json = tryJson(payload, undefined);
  if (json === undefined) return;
  if (inspectChunk) inspectChunk(json);
  yield* deltasFromChunk(json);
}

/** 把一个流式 chunk 折算成内部 delta（可能多个） */
export function* deltasFromChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return;
  if (chunk.usage) yield { type: 'usage', usage: normalizeUsage(chunk.usage) };

  const choices = chunk.choices;
  if (!Array.isArray(choices) || !choices.length) return;

  const choice = choices[0];
  const delta = choice.delta || choice.message || {};

  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    yield { type: 'reasoning', text: delta.reasoning_content };
  } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
    yield { type: 'reasoning', text: delta.reasoning };
  }

  if (typeof delta.content === 'string' && delta.content) {
    yield { type: 'text', text: delta.content };
  } else if (Array.isArray(delta.content)) {
    // 有的网关回 content 数组
    for (const part of delta.content) {
      if (typeof part === 'string') yield { type: 'text', text: part };
      else if (part?.type === 'text' && part.text) yield { type: 'text', text: part.text };
    }
  }

  for (const [i, call] of (delta.tool_calls || []).entries()) {
    yield {
      type: 'tool_call',
      index: typeof call.index === 'number' ? call.index : i,
      id: call.id,
      name: call.function?.name || call.name,
      argumentsDelta: call.function?.arguments ?? call.arguments ?? ''
    };
  }

  if (choice.finish_reason) {
    yield { type: 'finish', reason: mapFinish(choice.finish_reason) };
  }
}

function* deltasFromCompletion(json) {
  if (!json || typeof json !== 'object') return;
  if (json.error) {
    throw new OfmError(Codes.UPSTREAM, json.error.message || '上游返回错误', { detail: json.error });
  }
  if (json.usage) yield { type: 'usage', usage: normalizeUsage(json.usage) };
  const choice = json.choices?.[0];
  if (!choice) {
    if (json.output_text) yield { type: 'text', text: json.output_text };
    return;
  }
  const msg = choice.message || {};
  if (msg.reasoning_content) yield { type: 'reasoning', text: msg.reasoning_content };
  if (typeof msg.content === 'string' && msg.content) yield { type: 'text', text: msg.content };
  for (const [i, tc] of (msg.tool_calls || []).entries()) {
    yield {
      type: 'tool_call',
      index: tc.index ?? i,
      id: tc.id,
      name: tc.function?.name,
      argumentsDelta: tc.function?.arguments || ''
    };
  }
  yield { type: 'finish', reason: mapFinish(choice.finish_reason || 'stop') };
}

export function normalizeUsage(u) {
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completion = u.completion_tokens ?? u.output_tokens ?? 0;
  // 除 OpenAI Chat 的 prompt_tokens_details 外，把 Anthropic / Responses /
  // 国内厂商的缓存字段也统一折算到 cached_tokens，避免归一化时把命中数削掉。
  return attachCacheTokens({
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.total_tokens ?? prompt + completion,
    ...(u.prompt_tokens_details ? { prompt_tokens_details: u.prompt_tokens_details } : {}),
    ...(u.completion_tokens_details ? { completion_tokens_details: u.completion_tokens_details } : {}),
    ...(u.input_tokens_details ? { input_tokens_details: u.input_tokens_details } : {})
  }, u);
}

export function mapFinish(reason) {
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool_use':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * 聚合 delta 流。tool_calls 按 index 累加 arguments。
 * 返回值就是非流式响应所需的一切。
 */
export function aggregateDeltas(deltas) {
  const out = {
    text: '',
    reasoning: '',
    toolCalls: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    finishReason: 'stop'
  };
  const byIndex = new Map();
  for (const d of deltas) {
    if (d.type === 'text') out.text += d.text;
    else if (d.type === 'reasoning') out.reasoning += d.text;
    else if (d.type === 'usage') out.usage = d.usage;
    else if (d.type === 'finish') out.finishReason = d.reason;
    else if (d.type === 'tool_call') {
      const key = d.index ?? 0;
      let st = byIndex.get(key);
      if (!st) {
        st = { id: '', name: '', arguments: '' };
        byIndex.set(key, st);
      }
      if (d.id) st.id = d.id;
      if (d.name) st.name = d.name;
      if (d.argumentsDelta) st.arguments += d.argumentsDelta;
    }
  }
  out.toolCalls = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, st]) => st)
    .filter((tc) => tc.name);
  if (out.toolCalls.length && out.finishReason === 'stop') out.finishReason = 'tool_calls';
  return out;
}
