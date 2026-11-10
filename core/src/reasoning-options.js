/**
 * 思考档位归一化（跨渠道共用）。
 *
 * 各渠道模型目录声明档位的字段和形状都不一样：
 *  - TRAE：reasoning_effort_config.options = [{ effort, name }] 或 ['low', ...]
 *  - Qoder：efforts = ['xhigh', 'high', 'low', 'max', 'medium']（静态目录）
 *  - MiniMax：effort_options = ['default', 'low', 'medium', ...]
 *  - 也可能直接给对象字典 { light: 'Light', high: { name: 'High' } }
 *
 * 统一归成 { value, label }，由 /api/models 与 /v1/models 的 reasoning_options
 * 下发，App 直接渲染成可选芯片。`value` **原样透传、绝不映射**：
 * 不做 low→medium 这类猜测，也不猜上游缺省值；解析不出来就丢掉该档，
 * 宁可不显示，也不下发一个上游不认识的值（会变成 400 或被静默忽略）。
 */
const VALUE_KEYS = [
  'effort', 'value', 'level', 'id', 'key', 'slug',
  'reasoning_effort', 'effort_level', 'name'
];
const LABEL_KEYS = [
  'name', 'label', 'title', 'text',
  'displayName', 'display_name', 'displayLabel', 'display'
];

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export function normalizeReasoningOptions(options) {
  let list = options;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    // 对象字典：key 一律当 value，值当 label（也可能是带 name 的对象）
    list = Object.entries(list).map(([key, val]) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? { value: key, ...val }
        : { value: key, label: typeof val === 'string' ? val : key }
    );
  }
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();
  for (const o of list) {
    let value;
    let label;
    if (typeof o === 'string') {
      value = o;
      label = o;
    } else if (o && typeof o === 'object') {
      value = pick(o, VALUE_KEYS);
      label = pick(o, LABEL_KEYS) ?? value;
    }
    if (typeof value !== 'string' || !value.trim()) continue;
    const v = value.trim().slice(0, 32);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, label: String(label ?? v).trim().slice(0, 32) || v });
  }
  return out;
}
