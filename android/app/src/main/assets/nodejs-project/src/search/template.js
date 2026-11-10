/**
 * 请求模板与响应字段映射（对齐截图里「请求模板与响应字段」那一栏）。
 *
 * 占位符（搜索）：{{query}} {{query_json}} {{count}}
 * 占位符（读取）：{{url}} {{raw_url}} {{url_json}}
 *
 * 约定：
 *  - `{{query}}` 原样替换（URL 里请自己 encode，或者用 query_json）；
 *  - `{{query_json}}` 是**转义后的字符串内容，不带外层引号**——
 *    模板里写成 `{"query":"{{query_json}}"}`，这样和主流客户端的自定义搜索写法一致；
 *  - 未知占位符原样保留，不悄悄替换成空串（否则用户把模板写错了根本看不出来）。
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderTemplate(template, vars) {
  return String(template == null ? '' : template).replace(PLACEHOLDER, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] == null ? '' : vars[key]) : whole
  );
}

/** JSON 字符串内容转义（去掉外层引号） */
export function jsonEscape(value) {
  const raw = JSON.stringify(String(value == null ? '' : value));
  return raw.slice(1, -1);
}

/** JSON 字符串字面量（带外层引号） */
export function jsonQuote(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

/**
 * 把 `data.web.results[].title` / `[0].name` / `a.b[2].c` 切成路径片段。
 * `[]` 表示「对数组里每一项继续走后面的路径」，结果会被摊平。
 */
function tokens(path) {
  const out = [];
  for (const part of String(path).split('.')) {
    if (!part) continue;
    const m = /^([^[\]]*)((?:\[\d*\])*)$/.exec(part);
    if (!m) {
      out.push({ key: part });
      continue;
    }
    if (m[1]) out.push({ key: m[1] });
    for (const idx of m[2].match(/\[(\d*)\]/g) || []) {
      const inner = idx.slice(1, -1);
      out.push({ index: inner === '' ? '*' : Number(inner) });
    }
  }
  return out;
}

function walk(value, parts, depth = 0) {
  if (depth >= parts.length) return value;
  if (value == null) return undefined;
  const part = parts[depth];
  if (part.key != null) {
    if (typeof value !== 'object') return undefined;
    return walk(value[part.key], parts, depth + 1);
  }
  if (part.index === '*') {
    if (!Array.isArray(value)) return undefined;
    const out = [];
    for (const item of value) {
      const r = walk(item, parts, depth + 1);
      if (Array.isArray(r)) out.push(...r);
      else if (r !== undefined) out.push(r);
    }
    return out;
  }
  if (!Array.isArray(value)) return undefined;
  return walk(value[part.index], parts, depth + 1);
}

/** 按路径取值；空路径返回原对象 */
export function pickPath(root, path) {
  const p = String(path || '').trim();
  if (!p || p === '$' || p === '.') return root;
  return walk(root, tokens(p));
}

const AUTO_LIST_KEYS = [
  'results',
  'data.results',
  'data.web.results',
  'data.web',
  'web.results',
  'webPages.value',
  'items',
  'data.items',
  'organic',
  'data',
  'list'
];

/**
 * 取结果数组：
 *  - 用户填了 resultsPath 就严格按它取；
 *  - 没填就按常见字段嗅探（只认数组，别把对象当列表）。
 */
export function pickList(root, resultsPath) {
  const configured = String(resultsPath || '').trim();
  if (configured) {
    const v = pickPath(root, configured);
    return Array.isArray(v) ? v : [];
  }
  if (Array.isArray(root)) return root;
  for (const key of AUTO_LIST_KEYS) {
    const v = pickPath(root, key);
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

/** 从任意结果项里取一个字符串字段 */
export function pickString(item, path) {
  if (item == null) return '';
  const p = String(path || '').trim();
  const v = p ? pickPath(item, p) : item;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') {
    // 有些上游把标题包成 { text: "..." } / { value: "..." }
    for (const k of ['text', 'value', 'title', 'name', 'url']) {
      if (typeof v[k] === 'string') return v[k];
    }
  }
  return '';
}
