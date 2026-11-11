/**
 * OpenAI Chat Completions 请求 → 内部规范请求。
 */
import { normalizeContent, normalizeRole } from '../canonical.js';
import { OfmError, Codes } from '../errors.js';
import { explicitEffort, thinkingEffort } from '../effort.js';

export function normalizeChatBody(body) {
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    throw new OfmError(Codes.INVALID_REQUEST, 'messages 必须是数组', { status: 400 });
  }
  const messages = (body.messages || [])
    .filter((m) => m && typeof m === 'object')
    .map((m) => {
      const msg = {
        role: normalizeRole(m.role),
        content: normalizeContent(m.content)
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        msg.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name || tc.name || '',
          arguments: tc.function?.arguments ?? tc.arguments ?? '{}'
        }));
      }
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.name) msg.name = m.name;
      return msg;
    });

  // 兼容老的 functions / function_call 写法
  let tools = body.tools;
  if (!tools && Array.isArray(body.functions)) {
    tools = body.functions.map((f) => ({ type: 'function', function: f }));
  }

  return {
    messages,
    tools: normalizeTools(tools),
    toolChoice: normalizeToolChoice(body.tool_choice),
    maxTokens: body.max_completion_tokens ?? body.max_tokens ?? null,
    temperature: body.temperature,
    topP: body.top_p,
    stop: body.stop,
    // 三个入口都收：reasoning_effort / reasoning.effort / thinking.budget_tokens
    reasoningEffort: explicitEffort(body) ?? thinkingEffort(body),
    stream: body.stream === true,
    user: body.user,
    parallelToolCalls: body.parallel_tool_calls
  };
}

/** 内部规范消息 → OpenAI wire 形状（多数渠道直接发这个） */
export function toOpenAiMessages(messages) {
  return messages.map((m) => {
    const out = { role: m.role === 'tool' ? 'tool' : m.role };
    if (Array.isArray(m.content)) {
      out.content = m.content.map((b) =>
        b.type === 'text'
          ? { type: 'text', text: b.text }
          : { type: 'image_url', image_url: { url: b.url } }
      );
    } else {
      out.content = m.content ?? '';
    }
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments || '{}' }
      }));
    }
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    return out;
  });
}

export function toOpenAiTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.parameters || {} }
  }));
}

export function normalizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type && t.type !== 'function') continue; // 内置工具（web_search 等）不支持
    const fn = t.function || t;
    if (!fn?.name) continue;
    out.push({
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} }
    });
  }
  return out.length ? out : undefined;
}

export function normalizeToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'any') return 'required';
    if (choice === 'none') return 'none';
    return choice; // auto | required
  }
  const name = choice.function?.name || choice.name;
  if (name) return { name };
  return undefined;
}
