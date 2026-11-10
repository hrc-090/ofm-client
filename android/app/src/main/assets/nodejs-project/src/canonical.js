/**
 * 内部规范请求（canonical request）。
 *
 * 三家上游协议（OpenAI Chat / OpenAI Responses / Anthropic Messages）在入口处
 * 统一折算成这个形状，渠道实现只面对它；出口再按客户端要的协议渲染。
 * 这样加一个渠道不用写三遍，加一种对外协议也不用改渠道。
 */

export const emptyUsage = () => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

export function normalizeRole(role) {
  if (!role) return 'user';
  const r = String(role).toLowerCase();
  if (r === 'developer') return 'system';
  if (r === 'function') return 'tool';
  return r;
}

/**
 * 统一的内容块：
 *   {type:'text', text}
 *   {type:'image', url}            // 已是 data URL 或可访问 URL
 *   {type:'tool_call', id, name, arguments}   // arguments 是 JSON 字符串
 *   {type:'tool_result', id, content}
 */
export function normalizeContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    switch (part.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        blocks.push({ type: 'text', text: String(part.text ?? '') });
        break;
      case 'image_url':
      case 'input_image': {
        const url = part.image_url?.url || part.image_url || part.url || '';
        if (url) blocks.push({ type: 'image', url });
        break;
      }
      case 'image': {
        // Anthropic: {type:'image', source:{type:'base64', media_type, data} | {type:'url', url}}
        const src = part.source || {};
        if (src.type === 'base64' && src.data) {
          blocks.push({ type: 'image', url: `data:${src.media_type || 'image/png'};base64,${src.data}` });
        } else if (src.url) {
          blocks.push({ type: 'image', url: src.url });
        }
        break;
      }
      default:
        // 未知块（thinking 等）丢弃，不要把脏数据透传给上游
        break;
    }
  }
  return blocks;
}

/** 把内容块拼成纯文本（某些上游只支持纯文本） */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** 收集所有图片 URL（data URL 保持原样） */
export function collectImages(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b.type === 'image').map((b) => b.url);
}

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return contentToText(messages[i].content);
  }
  return '';
}

/** 粗略 token 估算：CJK 每字 ≈ 1 token，其余 ≈ 4 字符/token（仅用于 count_tokens 兜底） */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}
