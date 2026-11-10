/**
 * 自定义搜索 / 自定义读取：截图里那两块配置的实际执行者。
 *
 * 语义（和主流客户端的「自定义搜索」对齐）：
 *  - URL 里出现 `{{...}}` → 渲染进 URL，按 `method` 发请求（GET 就是拼 query）；
 *  - 否则 POST（或 GET）到固定 URL，body 用模板，默认 `{"query":"{{query_json}}","count":{{count}}}`；
 *  - 填了 API Key 就自动加 `Authorization: Bearer <key>`；
 *  - 结果字段按用户填的路径取，没填就自动嗅探常见结构。
 */
import { fetchText } from '../http-text.js';
import { renderTemplate, jsonEscape, pickList, pickPath, pickString } from '../template.js';
import { cleanText, snippet } from '../sanitize.js';

function headersFor(body, apiKey) {
  const headers = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' };
  const trimmed = String(body || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) headers['content-type'] = 'application/json';
  else if (trimmed) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function asObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('自定义接口返回空响应');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error('自定义接口返回的不是 JSON（检查接口地址 / 鉴权）');
  }
}

export function defaultSearchBody() {
  return '{"query":"{{query_json}}","count":{{count}}}';
}

export function defaultReadBody() {
  return '{"url":"{{raw_url}}"}';
}

function looksJson(body) {
  const t = String(body || '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

export async function customSearch(cfg, { query, count = 8, apiKey = '', timeoutMs = 20000, signal = null }) {
  const method = String(cfg.method || 'POST').toUpperCase();
  const vars = { query, query_json: jsonEscape(query), count };
  let url = String(cfg.url || '').trim();
  if (!url) throw new Error('未填写自定义搜索接口地址');

  let body = null;
  if (url.includes('{{')) {
    url = renderTemplate(url, vars);
  } else if (method === 'GET') {
    const u = new URL(url);
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(count));
    url = u.toString();
  }

  if (method !== 'GET') {
    const tpl = String(cfg.body || '').trim() || defaultSearchBody();
    body = renderTemplate(tpl, vars);
  }

  const res = await fetchText(url, {
    method,
    headers: headersFor(body, apiKey),
    body,
    timeoutMs,
    signal
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`自定义搜索 HTTP ${res.status}`);
  }

  const json = asObject(res.text);
  const list = pickList(json, cfg.resultsPath);
  if (!list.length) {
    // 0 结果不算失败（口径和内置引擎一致），交给上层换下一个源
    return { sources: [], truncated: false };
  }
  const sources = list
    .map((item) => ({
      title: cleanText(pickString(item, cfg.titlePath || 'title')).slice(0, 200),
      url: String(pickString(item, cfg.urlPath || 'url')).trim(),
      snippet: snippet(pickString(item, cfg.snippetPath || 'snippet')),
      published_at: cleanText(pickString(item, cfg.publishedPath || '')) || null
    }))
    .filter((x) => /^https?:\/\//i.test(x.url));
  return { sources: sources.slice(0, count), truncated: sources.length > count };
}

export async function customRead(cfg, { url, maxChars = 20000, apiKey = '', timeoutMs = 20000, signal = null }) {
  const method = String(cfg.method || 'POST').toUpperCase();
  const target = String(cfg.url || '').trim();
  if (!target) throw new Error('未填写自定义读取接口地址');

  const vars = { url, raw_url: url, url_json: jsonEscape(url) };
  let requestUrl = target;
  let body = null;

  if (target.includes('{{')) {
    requestUrl = renderTemplate(target, vars);
  } else if (method === 'GET') {
    const u = new URL(target);
    u.searchParams.set('url', url);
    requestUrl = u.toString();
  }

  if (method !== 'GET') {
    const tpl = String(cfg.body || '').trim() || defaultReadBody();
    body = renderTemplate(tpl, vars);
  }

  const res = await fetchText(requestUrl, {
    method,
    headers: headersFor(body, apiKey),
    body,
    timeoutMs,
    signal
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`自定义读取 HTTP ${res.status}`);

  // 有的接口直接回纯文本，回 JSON 的再按路径取
  const text = String(res.text || '');
  if (!looksJson(text)) {
    const cleaned = cleanText(text);
    if (!cleaned) throw new Error('自定义读取返回空正文');
    return { title: '', text: cleaned.slice(0, maxChars), final_url: url, truncated: cleaned.length > maxChars };
  }

  const json = asObject(text);
  const configured = String(cfg.textPath || '').trim();
  const candidates = configured
    ? [configured]
    : ['text', 'content', 'markdown', 'data.text', 'data.content', 'data.markdown', 'result.text'];
  let content = '';
  let hitPath = '';
  for (const path of candidates) {
    const v = pickPath(json, path);
    if (typeof v === 'string' && v.trim()) {
      content = v;
      hitPath = path;
      break;
    }
  }
  if (!content) throw new Error(`自定义读取响应里找不到正文${configured ? `（字段 ${configured}）` : ''}`);

  const title = cleanText(pickString(json, cfg.titlePath || 'title') || '');
  const finalUrl = String(pickString(json, cfg.finalUrlPath || '') || url);
  return {
    title,
    text: content.slice(0, maxChars),
    final_url: finalUrl,
    truncated: content.length > maxChars,
    field: hitPath
  };
}
