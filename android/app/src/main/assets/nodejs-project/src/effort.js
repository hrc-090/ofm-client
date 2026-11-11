/**
 * 思考档位入口与输出预算阶梯（对齐上游 src/effort.js 的语义）。
 *
 * 两件事：
 *  1. **入口解析**：第三方客户端把档位写在三个不同的地方 ——
 *     `reasoning_effort`、`reasoning.effort`、以及模型名尾部 `xxx(high)`。
 *     前两个以前只认第一个；第三个以前会被当成模型名，直接 400 找不到模型。
 *  2. **预算阶梯**：模型目录**没有**声明档位菜单时，light/balanced/deep
 *     只能翻译成 max_tokens 预算（2048 / 8192 / 模型上限）。
 *     声明了菜单的模型必须原值下发，不能替换成预算 —— 上游对集合外的值回 400。
 *
 * 预算阶梯默认关闭（设置项 `effortBudget`），因为不同渠道对 max_tokens
 * 的容忍度不一样，贸然调大可能被判超限；开启后才会按阶梯改写。
 */

/** 上游的三个档位名。别名只做归一，不新增档位。 */
export const EFFORT_LEVELS = ['light', 'balanced', 'deep'];

const ALIASES = {
  minimal: 'light',
  low: 'light',
  light: 'light',
  medium: 'balanced',
  balanced: 'balanced',
  high: 'deep',
  deep: 'deep',
  max: 'deep'
};

export const MIN_BUDGET = 512;
/** 思考不可关闭的模型：预算减半等于没思考，上游翻倍。 */
export const ALWAYS_THINKING_FACTOR = 2;

/**
 * 把任意档位写法归一成 light/balanced/deep。
 * 不认识的值返回 null —— 绝不猜上游缺省值。
 */
export function effortLevel(value) {
  if (typeof value !== 'string') return null;
  return ALIASES[value.trim().toLowerCase()] || null;
}

/**
 * 从模型名尾部取 `(level)`，并从 body 上剥掉。
 *
 * 只有「括号里是一个已知档位」才剥：模型名本身可能带括号
 * （`gpt-x (preview)`），乱剥会让正常模型找不到。
 *
 * @returns {string|null} 取到的档位原文
 */
export function takeModelEffort(body) {
  if (!body || typeof body.model !== 'string') return null;
  const raw = body.model.trim();
  const hit = /\(([^()]{1,24})\)\s*$/.exec(raw);
  if (!hit) return null;
  const value = hit[1].trim();
  if (!effortLevel(value)) return null;
  body.model = raw.slice(0, hit.index).trim();
  // 显式字段优先于模型名后缀
  if (!body.reasoning_effort && !body.reasoning?.effort) body.reasoning_effort = value;
  return value;
}

/**
 * 三个入口里第一个非空值。
 * 顺序与上游一致：`reasoning_effort` → `reasoning.effort`。
 */
export function explicitEffort(body) {
  for (const value of [body?.reasoning_effort, body?.reasoning?.effort]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * thinking.budget_tokens → 档位。
 *
 * 第三方（Claude Code / Cline / 各种 anthropic 兼容壳）只会写
 * `thinking: {type:'enabled', budget_tokens: N}`，以前这里一律当 'high'，
 * 于是「设了预算也没变化」。按预算换算成三档，再由 dispatch 落到
 * 模型目录声明的真实档位（见 normalizeEffortAgainstMenu）。
 */
export function effortFromBudget(budget) {
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0) return null;
  if (b < 4096) return 'light';
  if (b < 16384) return 'balanced';
  return 'deep';
}

/**
 * thinking 字段（Anthropic 形状，部分 OpenAI 兼容壳也这么发）→ 档位。
 *
 * ⚠️ `type:'disabled'` 返回 null（等于「不干预」）：不少客户端每个请求都带
 * 一段 disabled，把它翻成 'none' 会让不支持该档位的上游直接 400。
 * 真要关思考，直接用 `reasoning_effort:'none'`，原值透传。
 */
export function thinkingEffort(body) {
  const t = body?.thinking;
  if (!t || typeof t !== 'object') return null;
  if (t.type !== 'enabled') return null;
  return effortFromBudget(t.budget_tokens) || 'high';
}

/**
 * 把客户端写的档位对齐到上游目录声明的原始值。
 *
 * - `HIGH` → `high`：大小写不同不该变成 400；
 * - `high` 落到菜单里的 `max`：同义档位（high/deep 同族）互相认；
 * - 认不出来就**原样返回**，不猜、不拦 —— 菜单可能不全，
 *   客户端也可能在用上游默认值，拦下来只会把能用的请求变成 400。
 *
 * @param {string} value 客户端写的值
 * @param {string[]} declared 目录声明可选值（原始大小写）
 * @returns {string} 最终下发给渠道的值
 */
export function normalizeEffortAgainstMenu(value, declared) {
  if (typeof value !== 'string' || !value.trim()) return value;
  const raw = value.trim();
  if (!Array.isArray(declared) || declared.length === 0) return raw;

  const exact = declared.find((v) => String(v).toLowerCase() === raw.toLowerCase());
  if (exact) return exact;

  const level = effortLevel(raw);
  if (!level) return raw;
  const same = declared.find((v) => effortLevel(String(v)) === level);
  return same || raw;
}

/**
 * 档位 → max_tokens 预算。
 *
 * @param {string} value 档位原文
 * @param {object} opts
 * @param {number} [opts.modelMaxOutput] 模型目录声明的输出上限
 * @param {boolean} [opts.alwaysThinking] 思考不可关闭
 * @param {number} [opts.requested] 客户端显式给的 max_tokens（优先级最高）
 * @returns {number|null} 需要写入的 max_tokens；null 表示不改
 */
export function budgetForEffort(value, opts = {}) {
  const level = effortLevel(value);
  if (!level) return null;

  const requested = Number(opts.requested);
  const modelMax = Number(opts.modelMaxOutput);
  const capacity = Number.isFinite(requested) && requested > 0 ? requested : Number.POSITIVE_INFINITY;

  // 声明的输出上限优先；没有上限时用档位自己的天花板。
  const ceiling =
    level === 'light' ? 2048 : level === 'balanced' ? 8192 : Number.POSITIVE_INFINITY;
  const limit =
    Number.isFinite(modelMax) && modelMax > 0 ? Math.min(ceiling, modelMax) : ceiling;

  let budget = Math.min(limit, capacity);
  if (opts.alwaysThinking) budget *= ALWAYS_THINKING_FACTOR;
  if (!Number.isFinite(budget)) return null;
  return Math.max(MIN_BUDGET, Math.trunc(budget));
}

/** 设置项 → 是否给无档位模型套预算阶梯（默认关）。 */
export function effortBudgetEnabled(settings) {
  return settings?.effortBudget === true;
}
