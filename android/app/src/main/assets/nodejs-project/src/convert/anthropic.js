/**
 * Anthropic Messages ↔ 内部规范请求。
 * 也负责把内部 delta 流渲染成 Anthropic SSE（Claude Code / Anthropic SDK 直接可用）。
 */
import { normalizeContent, estimateTokens, lastUserText } from '../canonical.js';
import { normalizeTools } from './openai-chat.js';
import { OfmError, Codes } from '../errors.js';
import { cachedOrNull } from '../usage-cache.js';

export function anthropicToInternal(body) {
  const messages = [];
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    throw new OfmError(Codes.INVALID_REQUEST, 'messages 必须是数组', { status: 400 });
  }

  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : (body.system || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];

    if (role === 'assistant') {
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
      const content = normalizeContent(blocks.filter((b) => b.type !== 'tool_use' && b.type !== 'thinking'));
      const msg = { role, content };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }

    // user 消息里的 tool_result 在 OpenAI 协议里必须拆成独立的 tool 消息
    const results = blocks.filter((b) => b.type === 'tool_result');
    for (const r of results) {
      const text = typeof r.content === 'string'
        ? r.content
        : (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: text });
    }
    const rest = blocks.filter((b) => b.type !== 'tool_result');
    if (rest.length) messages.push({ role: 'user', content: normalizeContent(rest) });
  }

  const tools = (body.tools || [])
    .filter((t) => t && t.name)
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} } }));

  return {
    messages,
    tools: normalizeTools(tools),
    toolChoice: normalizeAnthropicToolChoice(body.tool_choice),
    maxTokens: body.max_tokens ?? null,
    temperature: body.temperature,
    topP: body.top_p,
    stop: body.stop_sequences,
    reasoningEffort: body.thinking?.type === 'enabled' ? 'high' : undefined,
    thinkingBudget: body.thinking?.type === 'enabled' ? body.thinking.budget_tokens : undefined,
    stream: body.stream === true
  };
}

function normalizeAnthropicToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && choice.name) return { name: choice.name };
  return undefined;
}

export function anthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export function anthropicUsage(usage) {
  const cached = cachedOrNull(usage);
  return {
    input_tokens: usage?.prompt_tokens || 0,
    output_tokens: usage?.completion_tokens || 0,
    ...(cached != null ? { cache_read_input_tokens: cached } : {})
  };
}

/** 非流式：一组 delta 聚合后的最终 message */
export function toAnthropicMessage({ id, model, text, reasoning, toolCalls, finishReason, usage }) {
  const content = [];
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: '' });
  if (text) content.push({ type: 'text', text });
  for (const tc of toolCalls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.arguments || '{}');
    } catch {
      input = { _raw: tc.arguments };
    }
    content.push({ type: 'tool_use', id: tc.id || `toolu_${Math.random().toString(36).slice(2)}`, name: tc.name, input });
  }
  return {
    id: id || `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: anthropicStopReason(finishReason),
    stop_sequence: null,
    usage: anthropicUsage(usage)
  };
}

/**
 * 把内部 delta 流渲染成 Anthropic SSE 文本块。
 * 块顺序固定 thinking → text → tool_use（Anthropic 客户端对块顺序敏感）。
 */
export class AnthropicStreamWriter {
  constructor({ id, model, usage }) {
    this.id = id || `msg_${Date.now().toString(36)}`;
    this.model = model;
    this.usage = usage || {};
    this.index = -1;
    this.openType = null;
    this.started = false;
    this.toolIndex = new Map(); // 内部 tool index → anthropic block index
    this.toolStarted = new Set();
  }

  #event(name, payload) {
    return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  start() {
    this.started = true;
    return this.#event('message_start', {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.usage.prompt_tokens || 0, output_tokens: 0 }
      }
    });
  }

  #openBlock(type, extra = {}) {
    this.index += 1;
    this.openType = type;
    const content_block =
      type === 'text'
        ? { type: 'text', text: '' }
        : type === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'tool_use', id: extra.id, name: extra.name, input: {} };
    return this.#event('content_block_start', { type: 'content_block_start', index: this.index, content_block });
  }

  #close() {
    if (this.openType === null) return '';
    const out = this.#event('content_block_stop', { type: 'content_block_stop', index: this.index });
    this.openType = null;
    return out;
  }

  delta(d) {
    let out = '';
    if (!this.started) out += this.start();

    if (d.type === 'reasoning') {
      if (this.openType !== 'thinking') {
        out += this.#close();
        out += this.#openBlock('thinking');
      }
      out += this.#event('content_block_delta', {
        type: 'content_block_delta',
        index: this.index,
        delta: { type: 'thinking_delta', thinking: d.text }
      });
      return out;
    }

    if (d.type === 'text') {
      if (this.openType !== 'text') {
        out += this.#close();
        out += this.#openBlock('text');
      }
      out += this.#event('content_block_delta', {
        type: 'content_block_delta',
        index: this.index,
        delta: { type: 'text_delta', text: d.text }
      });
      return out;
    }

    if (d.type === 'tool_call') {
      const key = d.index ?? 0;
      if (!this.toolStarted.has(key)) {
        out += this.#close();
        out += this.#openBlock('tool_use', {
          id: d.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
          name: d.name || ''
        });
        this.toolIndex.set(key, this.index);
        this.toolStarted.add(key);
      }
      const blockIndex = this.toolIndex.get(key);
      if (d.argumentsDelta) {
        out += this.#event('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: d.argumentsDelta }
        });
      }
      return out;
    }

    return out;
  }

  finish({ finishReason, usage }) {
    let out = '';
    if (!this.started) out += this.start();
    out += this.#close();
    // 流式拿不到上游 usage 时没有缓存字段；有则补进 message_delta，
    // 让按 usage 合并统计的第三方客户端能看到真实命中，而不是恒定 0。
    const cached = cachedOrNull(usage);
    out += this.#event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null },
      usage: {
        output_tokens: usage?.completion_tokens ?? this.usage.completion_tokens ?? 0,
        ...(cached != null ? { cache_read_input_tokens: cached } : {})
      }
    });
    out += this.#event('message_stop', { type: 'message_stop' });
    return out;
  }

  error(err) {
    return this.#event('error', {
      type: 'error',
      error: { type: 'api_error', message: err?.message || '上游错误' }
    });
  }
}

/** 本地估算（/v1/messages/count_tokens 不发上游） */
export function countAnthropicTokens(body) {
  const internal = anthropicToInternal({ ...body, max_tokens: body.max_tokens ?? 1 });
  let total = 0;
  for (const m of internal.messages) {
    total += 4;
    total += estimateTokens(typeof m.content === 'string' ? m.content : lastUserText([m]));
    for (const tc of m.tool_calls || []) total += estimateTokens(tc.name + tc.arguments);
  }
  for (const t of internal.tools || []) total += estimateTokens(t.name + t.description) + 8;
  return Math.max(1, total);
}
