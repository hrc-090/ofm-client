/**
 * 内部规范请求 ↔ Anthropic Messages（作为**上游**协议时用）。
 * MiniMax 与 ZCode 的上游都是 Anthropic 协议，所以共用这一层。
 */
import { contentToText } from './canonical.js';
import { tryJson } from './util.js';
import { OfmError, Codes } from './errors.js';
import { attachCacheTokens } from './usage-cache.js';

export function toAnthropicRequest(req, { maxTokens = 8192 } = {}) {
  const systemParts = [];
  const messages = [];

  for (const m of req.messages || []) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : contentToText(m.content));
      continue;
    }

    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }]
      });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks = [];
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tryJson(tc.arguments || '{}', {}) });
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    // user
    if (Array.isArray(m.content) && m.content.some((b) => b.type === 'image')) {
      messages.push({
        role: 'user',
        content: m.content.map((b) =>
          b.type === 'text'
            ? { type: 'text', text: b.text }
            : {
                type: 'image',
                source: b.url.startsWith('data:')
                  ? {
                      type: 'base64',
                      media_type: /^data:([^;]+)/.exec(b.url)?.[1] || 'image/png',
                      data: b.url.split(',')[1] || ''
                    }
                  : { type: 'url', url: b.url }
              }
        )
      });
      continue;
    }
    messages.push({ role: 'user', content: typeof m.content === 'string' ? m.content : contentToText(m.content) });
  }

  const body = {
    model: req.modelId,
    max_tokens: req.maxTokens || maxTokens,
    messages,
    stream: true
  };
  if (systemParts.length) body.system = systemParts.join('\n\n');
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.parameters || { type: 'object', properties: {} }
    }));
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.reasoningEffort && req.reasoningEffort !== 'none') {
    body.thinking = { type: 'enabled', budget_tokens: 4096 };
  }
  return body;
}

/** 消费 Anthropic SSE，产出内部 delta */
export async function* consumeAnthropicStream(events) {
  let finish = 'stop';
  const tools = new Map();
  let toolSeq = 0;
  let usage = null;

  for await (const evt of events) {
    if (evt.event === 'ping') continue;
    if (evt.event === 'error') {
      const parsed = tryJson(evt.data, {});
      throw new OfmError(Codes.UPSTREAM, parsed?.error?.message || 'Anthropic 上游返回错误');
    }
    const data = tryJson(evt.data, null);
    if (!data) continue;

    switch (data.type) {
      case 'message_start':
        // 保留整份 usage：Anthropic 的 cache_read_input_tokens /
        // cache_creation_input_tokens 只在这里出现，削成 input_tokens 就丢了命中数。
        if (data.message?.usage) usage = { ...data.message.usage };
        break;
      case 'content_block_start':
        if (data.content_block?.type === 'tool_use') {
          const index = toolSeq++;
          tools.set(data.index, { index, id: data.content_block.id, name: data.content_block.name });
          yield {
            type: 'tool_call',
            index,
            id: data.content_block.id,
            name: data.content_block.name,
            argumentsDelta: ''
          };
        }
        break;
      case 'content_block_delta': {
        const d = data.delta || {};
        if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
        else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking };
        else if (d.type === 'input_json_delta' && d.partial_json) {
          const st = tools.get(data.index);
          if (st) yield { type: 'tool_call', index: st.index, argumentsDelta: d.partial_json };
        }
        break;
      }
      case 'message_delta':
        if (data.delta?.stop_reason) finish = data.delta.stop_reason;
        if (data.usage) usage = { ...(usage || {}), ...data.usage };
        break;
      case 'message_stop':
        break;
      default:
        break;
    }
  }

  if (usage) {
    yield {
      type: 'usage',
      usage: attachCacheTokens({
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
      }, usage)
    };
  }
  const reason =
    finish === 'tool_use' ? 'tool_calls' : finish === 'max_tokens' ? 'length' : 'stop';
  yield { type: 'finish', reason };
}
