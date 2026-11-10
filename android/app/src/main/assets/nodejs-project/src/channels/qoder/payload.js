/**
 * 构造加密端点 agent_chat_generation 的明文请求体（结构逐项复刻官方）。
 *
 * 关键点（写死在这里，改之前先想清楚）：
 *  - `chat_context` 不能传空对象；
 *  - `business` 必填，缺了会被路由到故障节点；
 *  - `tools` 必须真的下发，否则模型会用正文 XML 臆造工具调用；
 *  - 图片走 messages[].content 的多模态数组，不走 chat_context.imageUrls。
 */
import crypto from 'node:crypto';
import { contentToText } from '../../canonical.js';

export function buildQoderInferPayload(ask) {
  const isReasoning = ask.isReasoning ?? false;
  const text = ask.userText;
  const requestId = crypto.randomUUID();

  const parameters = {};
  if (ask.maxTokens !== undefined) parameters.max_tokens = ask.maxTokens;
  if (ask.reasoningEffort !== undefined) {
    parameters.reasoning_effort = ask.reasoningEffort;
    parameters.enable_thinking = ask.reasoningEffort !== 'none';
  }
  if (ask.contextWindow !== undefined) parameters.context_length = ask.contextWindow;

  const messages = (ask.history || []).map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.tool_calls === undefined ? {} : { tool_calls: m.tool_calls }),
    ...(m.tool_call_id === undefined ? {} : { tool_call_id: m.tool_call_id })
  }));
  if (!messages.length) messages.push({ role: 'user', content: text });

  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: crypto.randomUUID(),
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: ask.modelKey, is_reasoning: isReasoning },
        originalContent: text
      },
      chatPrompt: '',
      imageUrls: null
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: ask.sessionType || 'qodercli',
    aliyun_user_type: '',
    model_config: {
      key: ask.modelKey,
      display_name: ask.displayName ?? '',
      model: '',
      format: ask.format ?? 'openai',
      is_vl: ask.isVl ?? true,
      is_reasoning: isReasoning,
      api_key: '',
      url: '',
      source: ask.source ?? 'system',
      max_input_tokens: ask.maxInputTokens ?? ask.contextWindow ?? 200000
    },
    custom_model: null,
    system: ask.systemText ? [{ type: 'text', text: ask.systemText }] : [],
    messages,
    tools: ask.tools ?? [],
    parameters,
    business: ask.business ?? { type: 'agent' }
  };
}

/** 内部规范消息 → Qoder history */
export function toQoderHistory(messages) {
  const history = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // system 单独走 ask.systemText
    const hasImages = Array.isArray(m.content) && m.content.some((b) => b.type === 'image');
    const content = hasImages
      ? m.content.map((b) =>
          b.type === 'text'
            ? { type: 'text', text: b.text }
            : { type: 'image_url', image_url: { url: b.url } }
        )
      : typeof m.content === 'string'
        ? m.content
        : contentToText(m.content);
    const entry = { role: m.role, content };
    if (m.tool_calls?.length) {
      entry.tool_calls = m.tool_calls.map((tc, i) => ({
        id: tc.id,
        type: 'function',
        index: i,
        function: { name: tc.name, arguments: tc.arguments || '{}' }
      }));
    }
    if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
    history.push(entry);
  }
  return history;
}
