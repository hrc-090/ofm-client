/**
 * 省 Token 适配层（移植自上游 src/token-saver）。
 *
 * 两条独立能力：
 *
 * - **RTK 压缩**：只改工具**输出**（`role:'tool'` / `tool_result` /
 *   `function_call_output`），把 diff、构建日志、grep/ls/tree 结果改写成
 *   更紧的形状。系统提示、用户消息、助手正文一律不动 —— 那是用户写下的
 *   上下文，改了就是在替用户改需求。
 * - **提示词瘦身**：caveman（压缩回答的语法与客套）与 ponytail（压缩改动
 *   幅度），默认全关。
 *
 * 所有失败都是 fail-open：宁可一个字不省，也不能把请求改坏。
 */
import { compressRequest } from './rtk/index.js';
import { activePrompts, CAVEMAN_LEVELS, PONYTAIL_LEVELS } from './prompts.js';

export { CAVEMAN_LEVELS, PONYTAIL_LEVELS };

/**
 * 设置 → 生效配置。
 * RTK 默认开（有开关可关）；提示词瘦身默认关。
 */
export function saverConfig(settings) {
  const s = settings?.tokenSaver || {};
  return {
    rtk: s.rtk !== false,
    caveman: CAVEMAN_LEVELS.includes(s.caveman) ? s.caveman : 'off',
    ponytail: PONYTAIL_LEVELS.includes(s.ponytail) ? s.ponytail : 'off'
  };
}

/**
 * 压缩一次出站请求体。
 *
 * @param {object} body 原始请求体（chat / messages / responses 形状）
 * @param {'chat'|'messages'|'responses'} wire
 * @param {object} settings
 * @returns {{enabled:boolean, bytesBefore:number, bytesAfter:number, saved:number, hits:Array}}
 */
export function compressOutbound(body, wire, settings) {
  const cfg = saverConfig(settings);
  const empty = { enabled: cfg.rtk, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] };
  if (!cfg.rtk || !body || typeof body !== 'object') return empty;
  try {
    const { stats } = compressRequest(body, wire, true);
    return {
      enabled: true,
      bytesBefore: stats.bytesBefore,
      bytesAfter: stats.bytesAfter,
      saved: stats.saved,
      hits: stats.hits
    };
  } catch {
    // 压缩器自身的 bug 不该让请求失败
    return empty;
  }
}

/**
 * 把激活的提示词追加到内部规范请求的 system 消息末尾。
 *
 * 内部形状统一为 `{role, content}`，三种 wire 转换后都是它，所以注入只有
 * 这一处。没有 system 消息就插一条 —— 不借用第一条 user 消息，避免改变
 * 用户原话的顺序语义。
 *
 * @param {{messages:Array}} internal
 * @param {object} settings
 * @returns {{enabled:boolean, injected:Array<{id:string,level:string}>, bytes:number}}
 */
export function injectPrompts(internal, settings) {
  const cfg = saverConfig(settings);
  const active = activePrompts({ caveman: cfg.caveman, ponytail: cfg.ponytail });
  if (!active.length || !Array.isArray(internal?.messages)) {
    return { enabled: false, injected: [], bytes: 0 };
  }
  const text = active.map((a) => a.text).join('\n\n');
  const first = internal.messages[0];
  if (first && first.role === 'system') {
    const base = typeof first.content === 'string' ? first.content : '';
    first.content = base ? `${base}\n\n${text}` : text;
  } else {
    internal.messages.unshift({ role: 'system', content: text });
  }
  return {
    enabled: true,
    injected: active.map((a) => ({ id: a.id, level: a.level })),
    bytes: Buffer.byteLength(text)
  };
}

/** 字节 → 粗略 token（4 字节/token），只用于看板展示。 */
export function bytesToTokens(bytes) {
  const n = Number(bytes);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 4) : 0;
}

/** 一行可读的节省摘要，写日志用。 */
export function describeSavings(stats) {
  if (!stats || !stats.saved) return '';
  const pct = stats.bytesBefore > 0 ? ((stats.saved / stats.bytesBefore) * 100).toFixed(0) : '0';
  const filters = Array.from(new Set((stats.hits || []).map((h) => h.filter))).join(',');
  return `省 Token：${stats.saved}B / ${stats.bytesBefore}B（${pct}%）${filters ? ` via ${filters}` : ''}`;
}
