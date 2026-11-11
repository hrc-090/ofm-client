/**
 * 缓存命中 token 的统一读取（prompt cache）。
 *
 * 上游命名至少有六种，散落在三家协议里：
 *   OpenAI Chat ......... prompt_tokens_details.cached_tokens
 *   OpenAI Responses .... input_tokens_details.cached_tokens
 *   Anthropic ........... cache_read_input_tokens（读命中）
 *   DeepSeek / Moonshot . prompt_cache_hit_tokens
 *   部分网关 ............ cached_tokens（顶层）
 *
 * 内部统一用 usage.cached_tokens 承载：**只有上游真的上报过缓存字段时才写这个键**，
 * 于是一个键同时表达了数值和「是否上报」——没上报 ≠ 上报了 0，
 * 看板据此显示「—（上游未上报）」，而不是误导性的 0%。
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/** 命中（读取）缓存的字段，按优先级取第一个合法值 */
const HIT_FIELDS = [
  (u) => u.prompt_tokens_details?.cached_tokens,
  (u) => u.input_tokens_details?.cached_tokens,
  (u) => u.cache_read_input_tokens,
  (u) => u.prompt_cache_hit_tokens,
  (u) => u.cached_tokens,
  (u) => u.prompt_tokens_details?.cache_read_tokens
];

/**
 * 只有「写入缓存 / 未命中」字段、没有命中字段时，仍算上游支持并上报了缓存，
 * 只是本次命中为 0。Anthropic 首次请求、DeepSeek 冷缓存都是这种形状。
 */
const WRITE_ONLY_FIELDS = [
  (u) => u.cache_creation_input_tokens,
  (u) => u.prompt_cache_miss_tokens,
  (u) => u.cache_creation?.ephemeral_5m_input_tokens,
  (u) => u.cache_creation?.ephemeral_1h_input_tokens
];

/**
 * @returns {{hit:number, reported:boolean}}
 *   hit      命中（从缓存读取）的 token 数；写入缓存不计入
 *   reported 上游是否上报了任一缓存字段
 */
export function readCacheTokens(usage) {
  if (!usage || typeof usage !== 'object') return { hit: 0, reported: false };
  for (const get of HIT_FIELDS) {
    const n = num(get(usage));
    if (n !== null) return { hit: n, reported: true };
  }
  for (const get of WRITE_ONLY_FIELDS) {
    if (num(get(usage)) !== null) return { hit: 0, reported: true };
  }
  return { hit: 0, reported: false };
}

/** 归一化层调用：把命中数挂到内部 usage 上；未上报则不写键。 */
export function attachCacheTokens(out, raw) {
  const { hit, reported } = readCacheTokens(raw);
  if (reported) out.cached_tokens = hit;
  return out;
}

/**
 * 内部 usage → 对外 OpenAI 风格 usage。
 * 剥掉内部标记，把 cached_tokens 折算成标准的 prompt_tokens_details.cached_tokens，
 * 让第三方客户端也能看到真实缓存命中，而不是写死的 0。
 */
export function publicUsage(u) {
  if (!u) return u;
  const prompt = u.prompt_tokens ?? 0;
  const completion = u.completion_tokens ?? 0;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.total_tokens ?? prompt + completion
  };
  if (u.prompt_tokens_details) out.prompt_tokens_details = { ...u.prompt_tokens_details };
  if (u.completion_tokens_details) out.completion_tokens_details = { ...u.completion_tokens_details };
  if (u.cached_tokens != null) {
    out.prompt_tokens_details = { ...(out.prompt_tokens_details || {}), cached_tokens: u.cached_tokens };
  }
  return out;
}

/** 供 Responses / Anthropic 出口直接取命中数（未上报返回 null） */
export function cachedOrNull(u) {
  return u && u.cached_tokens != null ? u.cached_tokens : null;
}

/**
 * 丢弃装不进上下文窗口的输入侧用量（对齐上游 sanitizeUsage）。
 *
 * 多模态回合偶发：上游把 totalTokens 报得远超模型声明的窗口，宿主的软预算
 * 据此判 CONTEXT_WINDOW_EXCEEDED —— 明明本地对话很短。输出侧数字仍然可信
 * （速度统计要用），所以只丢掉输入压力，并在最后什么都没有时返回 undefined，
 * 让调用方按「上游未上报」处理，而不是把 0 当成事实。
 *
 * @param {object|undefined} usage
 * @param {number|undefined} contextWindow 模型声明的窗口
 */
export function sanitizeUsage(usage, contextWindow) {
  if (!usage || typeof usage !== 'object') return usage;
  const win = Number(contextWindow);
  if (!Number.isFinite(win) || win <= 0) return usage;

  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const cached = Number(usage.cached_tokens ?? 0) || 0;
  const total = Number(usage.total_tokens);
  const over = input + cached > win || (Number.isFinite(total) && total > win);
  if (!over) return usage;

  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  if (output <= 0) return undefined;
  const out = {
    ...usage,
    prompt_tokens: 0,
    input_tokens: undefined,
    total_tokens: output
  };
  if (out.prompt_tokens_details) delete out.prompt_tokens_details;
  return out;
}
