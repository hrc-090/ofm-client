/**
 * 本地回显渠道。作用有两个：
 *  1. M1 验收：不依赖任何账号/网络就能跑通 /v1/models、流式、非流式、工具调用；
 *  2. 协议回归：改 server 渲染逻辑时用它，不消耗真实额度。
 */
import { sleep } from '../util.js';
import { contentToText } from '../canonical.js';

/**
 * 把文本切成若干「片」用于模拟流式。
 * ⚠️ 必须按**字素簇**切，不能按 `.` / `slice` 这类 UTF-16 单元切：
 *  - emoji（😀）是代理对，切一半会产出孤立代理（`\ud83d`），JSON.stringify
 *    后成 `"\ud83d"`，严格点的客户端直接解析失败 → 表现为「有时会中断」；
 *  - ZWJ 组合（👨‍👩‍👧‍👦）、国旗（🇨🇳）会被拆成多个 emoji 显示。
 * Intl.Segmenter 在瘦 ICU 运行时可能没有，兜底到按 code point。
 */
function splitUnits(text) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return [...seg.segment(text)].map((s) => s.segment);
    } catch {
      /* 落到下面 */
    }
  }
  return Array.from(text); // code point，至少不会切断代理对
}

/** 按 size 个字素簇分组 */
function chunkUnits(text, size) {
  const units = splitUnits(text);
  const out = [];
  for (let i = 0; i < units.length; i += size) out.push(units.slice(i, i + size).join(''));
  return out;
}

export class MockChannel {
  constructor() {
    this.id = 'mock';
    this.name = 'mock';
    this.displayName = '本地回显';
    this.loginMode = 'none';
    this.requiresAccount = false;
    this.supported = true;
    this.note = '不联网，用于验收与调试';
  }

  async listModels() {
    return [
      { id: 'echo', displayName: 'Echo（回显）', contextWindow: 128000, multimodal: false, reasoning: true },
      { id: 'slow', displayName: 'Slow（慢速流）', contextWindow: 128000, multimodal: false, reasoning: false }
    ];
  }

  async *stream(req, { signal } = {}) {
    const userText = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = contentToText(userText?.content) || '(空)';
    const slow = req.modelId === 'slow';
    const delay = slow ? 120 : 6;

    yield { type: 'reasoning', text: '（这是本地回显渠道的思考段，用于验证 reasoning 通道）' };
    await sleep(delay);
    if (signal?.aborted) throw new Error('aborted');

    const reply = `你好，我是本地回显渠道。你刚才说的是：「${text}」`;
    for (const ch of chunkUnits(reply, 4)) {
      yield { type: 'text', text: ch };
      await sleep(delay);
    }

    // 带工具时，如果用户说了 "tool"，演示一次标准 function call
    if (req.tools?.length && /tool|工具/i.test(text)) {
      const fn = req.tools[0];
      const args = JSON.stringify({ query: text });
      yield { type: 'tool_call', index: 0, id: `call_${Date.now().toString(36)}`, name: fn.name, argumentsDelta: '' };
      for (const part of chunkUnits(args, 6)) {
        yield { type: 'tool_call', index: 0, argumentsDelta: part };
        await sleep(delay);
      }
      yield { type: 'finish', reason: 'tool_calls' };
    } else {
      yield { type: 'finish', reason: 'stop' };
    }

    const promptTokens = Math.ceil(JSON.stringify(req.messages).length / 4);
    yield {
      type: 'usage',
      usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(reply.length / 4), total_tokens: promptTokens + Math.ceil(reply.length / 4) }
    };
  }
}
