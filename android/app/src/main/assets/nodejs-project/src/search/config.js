/**
 * 网页搜索配置的默认值与归一化。
 *
 * 配置落在 settings.json 的 `webSearch` 块（**不含任何 Key**）；
 * Key 单独进 credentials/web-search.json，沿用 Store 的 0600 约定。
 *
 * 默认关闭：不开就不暴露端点、不产生任何出站请求。
 */

/** 内置引擎 id。顺序即默认回退顺序（custom 在最前：用户填了就用用户的）。 */
export const ENGINE_IDS = ['custom', 'bing', 'keenable', 'exa', 'parallel', 'anysearch'];

/** 各引擎的展示名，给 App 与回退说明（note）用 */
export const ENGINE_LABELS = {
  custom: '自定义接口',
  bing: 'Bing',
  keenable: 'Keenable',
  exa: 'Exa',
  parallel: 'Parallel',
  anysearch: 'AnySearch'
};

export const SEARCH_DEFAULTS = {
  enabled: false,
  engineOrder: [...ENGINE_IDS],
  disabledEngines: [],
  maxResults: 8,
  budgetMs: 30000,
  cacheTtlMin: 5,
  readMaxChars: 20000,
  // 截图上半块「自定义搜索」
  search: {
    method: 'POST',
    url: '',
    body: '',
    resultsPath: '',
    titlePath: 'title',
    urlPath: 'url',
    snippetPath: 'snippet',
    publishedPath: '',
    textPath: '',
    finalUrlPath: ''
  },
  // 截图下半块「自定义读取」
  read: {
    method: 'POST',
    url: '',
    body: '',
    textPath: '',
    titlePath: '',
    finalUrlPath: '',
    resultsPath: '',
    urlPath: '',
    snippetPath: '',
    publishedPath: ''
  }
};

const METHODS = new Set(['GET', 'POST']);

function str(v, max = 2048) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function int(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function endpoint(raw, defaults) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const method = String(src.method || defaults.method).toUpperCase();
  return {
    method: METHODS.has(method) ? method : defaults.method,
    url: str(src.url).trim(),
    body: str(src.body, 8192),
    resultsPath: str(src.resultsPath, 200),
    titlePath: str(src.titlePath, 200) || defaults.titlePath,
    urlPath: str(src.urlPath, 200) || defaults.urlPath,
    snippetPath: str(src.snippetPath, 200) || defaults.snippetPath,
    publishedPath: str(src.publishedPath, 200),
    textPath: str(src.textPath, 200),
    finalUrlPath: str(src.finalUrlPath, 200)
  };
}

/** 配置只按白名单字段落盘，脏值一律回默认——绝不把整块原地存回去。 */
export function normalizeWebSearch(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const order = Array.isArray(src.engineOrder)
    ? src.engineOrder.map((x) => String(x)).filter((x) => ENGINE_IDS.includes(x))
    : [];
  const seen = new Set();
  const engineOrder = [];
  for (const id of order.length ? order : ENGINE_IDS) {
    if (seen.has(id)) continue;
    seen.add(id);
    engineOrder.push(id);
  }
  // 允许用户把某个引擎挤掉，但至少留一个，避免「存完就永远空链」
  for (const id of ENGINE_IDS) if (!seen.has(id) && engineOrder.length === 0) engineOrder.push(id);

  const disabled = Array.isArray(src.disabledEngines)
    ? [...new Set(src.disabledEngines.map((x) => String(x)).filter((x) => ENGINE_IDS.includes(x)))]
    : [];

  const search = endpoint(src.search, SEARCH_DEFAULTS.search);
  const read = endpoint(src.read, SEARCH_DEFAULTS.read);

  return {
    enabled: src.enabled === true,
    engineOrder,
    disabledEngines: disabled,
    maxResults: int(src.maxResults, 1, 20, SEARCH_DEFAULTS.maxResults),
    budgetMs: int(src.budgetMs, 3000, 60000, SEARCH_DEFAULTS.budgetMs),
    cacheTtlMin: int(src.cacheTtlMin, 0, 60, SEARCH_DEFAULTS.cacheTtlMin),
    readMaxChars: int(src.readMaxChars, 1000, 100000, SEARCH_DEFAULTS.readMaxChars),
    search,
    read
  };
}

/** 给 App 的配置视图：Key 只回显尾号，永不回原文 */
export function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}

/** 回退说明：给人看的「为什么不是首选源」 */
export function engineLabel(id) {
  return ENGINE_LABELS[id] || id;
}
