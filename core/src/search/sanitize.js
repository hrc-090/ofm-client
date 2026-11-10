/**
 * 出口统一清洗。
 *
 * 搜索结果是**外部不可信输入**：既可能带 HTML，也可能因为上游按字节截断
 * 留下孤立代理（`"\ud83d"`）——那个坑以前让整段会话 JSON 序列化失败，
 * 之后每个请求都被上游拒。所有出口都必须过这里，一处漏就等于没做。
 */

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  bull: '•',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  deg: '°'
};

export function decodeEntities(input) {
  return String(input == null ? '' : input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return '';
      try {
        return String.fromCodePoint(n);
      } catch {
        return '';
      }
    }
    const v = NAMED[body.toLowerCase()];
    return v == null ? whole : v;
  });
}

/**
 * 去掉孤立代理与零宽/控制字符。
 * 用码点循环而不是正则 —— 正则里的 lookbehind 在旧运行时上不一定有。
 */
export function stripBrokenChars(input) {
  const s = String(input == null ? '' : input);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i += 1;
      }
      // 孤立高代理：直接丢弃
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // 孤立低代理
    if (code === 0xfeff) continue;
    if (code >= 0x200b && code <= 0x200f) continue;
    if (code === 0x2028 || code === 0x2029) {
      out += '\n';
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0x7f) continue;
    out += s[i];
  }
  return out;
}

/** 按码点截断，不会切出半个 emoji */
export function truncateChars(input, max) {
  const s = String(input == null ? '' : input);
  if (!max || s.length <= max) return s;
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join('');
}

const TAG = /<[^>]*>/g;

export function cleanText(input) {
  if (input == null) return '';
  let s = String(input);
  if (s.includes('<') && s.includes('>')) s = s.replace(TAG, ' ');
  s = decodeEntities(s);
  s = stripBrokenChars(s);
  return s.replace(/\s+/g, ' ').trim();
}

/** 摘要统一 300 字符，和 dsh-free-search 的出口口径一致 */
export function snippet(input, max = 300) {
  return truncateChars(cleanText(input), max);
}

/** 结果里的 URL 只保留 http(s)，并去掉明显的跟踪参数 */
const TRACKING = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'msclkid',
  'spm',
  'ref_src',
  'from',
  'share_token',
  'scene'
]);

export function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  const drop = [];
  for (const key of u.searchParams.keys()) if (TRACKING.has(key)) drop.push(key);
  for (const key of drop) u.searchParams.delete(key);
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

/** eTLD+1 的近似：够用的常见后缀表，不引第三方依赖 */
const TWO_LEVEL = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.uk',
  'ac.uk',
  'co.jp',
  'or.jp',
  'co.kr',
  'com.hk',
  'com.tw',
  'com.au',
  'com.sg',
  'com.br'
]);

export function siteOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const last2 = parts.slice(-2).join('.');
    if (TWO_LEVEL.has(last2)) return parts.slice(-3).join('.');
    return last2;
  } catch {
    return '';
  }
}

/**
 * 归一化 + 去重 + 同站限量。
 * - URL 完全相同的只留第一条（上游经常同一篇文章给两个带不同跟踪参数的链接）；
 * - 同一站点最多占 1/3 名额，避免结果页被一家占满（按出现顺序轮转）。
 */
export function shapeResults(items, maxResults = 8) {
  const seen = new Set();
  const cleaned = [];
  for (const item of items || []) {
    const url = normalizeUrl(item && item.url);
    if (!url) continue;
    const key = url.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const title = truncateChars(cleanText(item.title), 200);
    const text = snippet(item.snippet || item.content || '');
    if (!title && !text) continue;
    cleaned.push({
      title: title || url,
      url,
      snippet: text,
      published_at: cleanText(item.published_at || item.publishedAt || '') || null
    });
  }
  if (cleaned.length <= 2) return cleaned.slice(0, maxResults);

  const capPerSite = Math.max(1, Math.ceil(maxResults / 3));
  const perSite = new Map();
  const out = [];
  for (const item of cleaned) {
    if (out.length >= maxResults) break;
    const site = siteOf(item.url) || item.url;
    const used = perSite.get(site) || 0;
    if (used >= capPerSite) continue;
    perSite.set(site, used + 1);
    out.push(item);
  }
  // 同站上限卡掉的名额，用剩下的按顺序补满（宁可多样性差一点，也别少给结果）
  if (out.length < Math.min(maxResults, cleaned.length)) {
    for (const item of cleaned) {
      if (out.length >= maxResults) break;
      if (out.includes(item)) continue;
      out.push(item);
    }
  }
  return out;
}

/** 交给模型的正文包一层边界，并在正文里剥离同名标记防提前闭合 */
export function wrapUntrusted(text) {
  const body = String(text == null ? '' : text)
    .replace(/<\/?untrusted-web-content>/gi, '[removed]')
    .replace(/\u0000/g, '');
  return `<untrusted-web-content>\n${body}\n</untrusted-web-content>`;
}
