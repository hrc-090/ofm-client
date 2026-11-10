/**
 * OpenAI Responses API（/v1/responses）。
 * 只覆盖对话 + 函数调用这两条主路径；内置工具（web_search/file_search）不支持。
 */
import { normalizeContent, estimateTokens } from '../canonical.js';
import { cachedOrNull } from '../usage-cache.js';

export function responsesToInternal(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: item.call_id || item.id, name: item.name, arguments: item.arguments || '{}' }]
        });
        continue;
      }
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
        });
        continue;
      }
      // message 项
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user';
      messages.push({ role, content: normalizeContent(item.content) });
    }
  }

  const tools = (body.tools || [])
    .filter((t) => t?.type === 'function' && t.name)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.parameters || {} }
    }));

  return {
    messages,
    tools: tools.length ? tools : undefined,
    toolChoice: typeof body.tool_choice === 'string' ? body.tool_choice : body.tool_choice?.name ? { name: body.tool_choice.name } : undefined,
    maxTokens: body.max_output_tokens ?? null,
    temperature: body.temperature,
    topP: body.top_p,
    reasoningEffort: body.reasoning?.effort,
    stream: body.stream === true
  };
}

const responseId = () => `resp_${Math.random().toString(36).slice(2, 14)}`;
const itemId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 14)}`;

export function toResponsesObject({ id, model, text, reasoning, toolCalls, finishReason, usage, createdAt }) {
  const output = [];
  if (reasoning) {
    output.push({
      type: 'reasoning',
      id: itemId('rs'),
      summary: [{ type: 'summary_text', text: reasoning }]
    });
  }
  if (text || !toolCalls?.length) {
    output.push({
      type: 'message',
      id: itemId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: text || '', annotations: [] }]
    });
  }
  for (const tc of toolCalls || []) {
    output.push({
      type: 'function_call',
      id: itemId('fc'),
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments || '{}',
      status: 'completed'
    });
  }
  return {
    id: id || responseId(),
    object: 'response',
    created_at: createdAt || Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    output_text: text || '',
    incomplete_details: finishReason === 'length' ? { reason: 'max_output_tokens' } : null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
      total_tokens: usage?.total_tokens || 0,
      input_tokens_details: { cached_tokens: cachedOrNull(usage) ?? 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    }
  };
}

/**
 * Responses 的流式事件序列。结构与官方一致，客户端 SDK 可直接消费。
 */
export class ResponsesStreamWriter {
  constructor({ id, model, createdAt }) {
    this.id = id || responseId();
    this.model = model;
    this.createdAt = createdAt || Math.floor(Date.now() / 1000);
    this.seq = 0;
    this.textItem = null;
    this.textBuf = '';
    this.reasoningItem = null;
    this.reasoningBuf = '';
    this.tools = new Map();
    this.started = false;
  }

  #ev(type, payload) {
    this.seq += 1;
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq, ...payload })}\n\n`;
  }

  #baseResponse(status = 'in_progress') {
    return {
      id: this.id,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: [],
      usage: null
    };
  }

  start() {
    this.started = true;
    return (
      this.#ev('response.created', { response: this.#baseResponse('in_progress') }) +
      this.#ev('response.in_progress', { response: this.#baseResponse('in_progress') })
    );
  }

  delta(d) {
    let out = '';
    if (!this.started) out += this.start();

    if (d.type === 'reasoning') {
      if (!this.reasoningItem) {
        this.reasoningItem = { type: 'reasoning', id: itemId('rs'), summary: [] };
        out += this.#ev('response.output_item.added', { output_index: 0, item: this.reasoningItem });
      }
      this.reasoningBuf += d.text;
      return out;
    }

    if (d.type === 'text') {
      if (!this.textItem) {
        this.textItem = {
          type: 'message',
          id: itemId('msg'),
          status: 'in_progress',
          role: 'assistant',
          content: []
        };
        const idx = this.reasoningItem ? 1 : 0;
        this.textIndex = idx;
        out += this.#ev('response.output_item.added', { output_index: idx, item: this.textItem });
        out += this.#ev('response.content_part.added', {
          item_id: this.textItem.id,
          output_index: idx,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] }
        });
      }
      this.textBuf += d.text;
      out += this.#ev('response.output_text.delta', {
        item_id: this.textItem.id,
        output_index: this.textIndex,
        content_index: 0,
        delta: d.text
      });
      return out;
    }

    if (d.type === 'tool_call') {
      const key = d.index ?? 0;
      let st = this.tools.get(key);
      if (!st) {
        st = { id: itemId('fc'), call_id: d.id || itemId('call'), name: d.name || '', args: '' };
        this.tools.set(key, st);
      }
      if (d.name && !st.name) st.name = d.name;
      if (d.argumentsDelta) st.args += d.argumentsDelta;
      return out;
    }

    return out;
  }

  finish({ finishReason, usage }) {
    let out = '';
    if (!this.started) out += this.start();

    const output = [];
    let index = 0;
    if (this.reasoningItem) {
      const item = {
        type: 'reasoning',
        id: this.reasoningItem.id,
        summary: this.reasoningBuf ? [{ type: 'summary_text', text: this.reasoningBuf }] : []
      };
      out += this.#ev('response.output_item.done', { output_index: index, item });
      output.push(item);
      index += 1;
    }

    if (this.textItem) {
      out += this.#ev('response.output_text.done', {
        item_id: this.textItem.id,
        output_index: this.textIndex,
        content_index: 0,
        text: this.textBuf
      });
      out += this.#ev('response.content_part.done', {
        item_id: this.textItem.id,
        output_index: this.textIndex,
        content_index: 0,
        part: { type: 'output_text', text: this.textBuf, annotations: [] }
      });
      const item = {
        type: 'message',
        id: this.textItem.id,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.textBuf, annotations: [] }]
      };
      out += this.#ev('response.output_item.done', { output_index: this.textIndex, item });
      output.push(item);
      index = Math.max(index, this.textIndex + 1);
    }

    for (const st of this.tools.values()) {
      const item = {
        type: 'function_call',
        id: st.id,
        call_id: st.call_id,
        name: st.name,
        arguments: st.args || '{}',
        status: 'completed'
      };
      out += this.#ev('response.output_item.done', { output_index: index, item });
      output.push(item);
      index += 1;
    }

    const final = {
      ...this.#baseResponse('completed'),
      output,
      output_text: this.textBuf,
      incomplete_details: finishReason === 'length' ? { reason: 'max_output_tokens' } : null,
      usage: {
        input_tokens: usage?.prompt_tokens || 0,
        output_tokens: usage?.completion_tokens || 0,
        total_tokens:
          usage?.total_tokens || (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0),
        input_tokens_details: { cached_tokens: cachedOrNull(usage) ?? 0 },
        output_tokens_details: { reasoning_tokens: 0 }
      }
    };
    out += this.#ev('response.completed', { response: final });
    return out;
  }

  error(err) {
    return this.#ev('response.failed', {
      response: {
        ...this.#baseResponse('failed'),
        error: { code: err?.code || 'server_error', message: err?.message || '上游错误' }
      }
    });
  }
}

export function countResponsesTokens(body) {
  const internal = responsesToInternal({ ...body, max_output_tokens: 1 });
  let total = 0;
  for (const m of internal.messages) {
    total += 4;
    total += estimateTokens(typeof m.content === 'string' ? m.content : '');
  }
  return Math.max(1, total);
}
