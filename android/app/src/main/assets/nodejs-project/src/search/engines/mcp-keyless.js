/**
 * 三个 keyless 公开 MCP（实测国内网络 25/25 全通）：
 *   exa       mcp.exa.ai/mcp              tool: web_search_exa     5 条
 *   parallel  search.parallel.ai/mcp      tool: web_search        10 条 + 发布日期
 *   keenable  api.keenable.ai/mcp         tool: search_web_pages  10 条（另有 fetch_page_content）
 *
 * 三个坑（都实测过）：
 *  1. 响应**有时是纯 JSON、有时是 SSE**（parallel/keenable 纯 JSON，exa 视 accept 头而定），
 *     两种都要会解；
 *  2. 结果文本**有时是嵌套 JSON、有时是 `Title:/URL:` 纯文本**；
 *  3. keenable 的工具名是 `search_web_pages`，传 `search` 会回 HTTP 200 +
 *     `Unknown tool`（看着像成功，其实是失败）。
 */
import { fetchText } from '../http-text.js';
import { cleanText, snippet } from '../sanitize.js';

export const MCP_ENGINES = {
  exa: {
    url: 'https://mcp.exa.ai/mcp',
    tool: 'web_search_exa',
    buildArgs: (query, count) => ({ query, numResults: Math.max(1, Math.min(10, count)) })
  },
  parallel: {
    url: 'https://search.parallel.ai/mcp',
    tool: 'web_search',
    buildArgs: (query, count) => ({
      objective: query,
      search_queries: [query],
      max_results: Math.max(1, Math.min(20, count))
    })
  },
  keenable: {
    url: 'https://api.keenable.ai/mcp',
    tool: 'search_web_pages',
    buildArgs: (query, count) => ({ query, max_results: Math.max(1, Math.min(20, count)) })
  }
};

/** 解析 JSON 或 SSE，返回 JSON-RPC 对象数组 */
export function parseMcpFrames(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [v];
    } catch {
      /* 落到逐行解析 */
    }
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      /* 忽略非 JSON 帧（心跳 / 注释） */
    }
  }
  return out;
}

function itemsFromJson(value) {
  if (!value || typeof value !== 'object') return [];
  for (const key of ['results', 'data', 'items', 'web', 'organic']) {
    const v = value[key];
    if (Array.isArray(v)) {
      return v.map((x) => ({
        title: x.title || x.name || x.heading || '',
        url: x.url || x.link || x.id || '',
        snippet: Array.isArray(x.excerpts) ? x.excerpts.join(' ') : x.snippet || x.description || x.content || '',
        published_at: x.publish_date || x.published_at || x.publishedAt || null
      }));
    }
  }
  return [];
}

/**
 * 纯文本结果格式：exa 是 `Title:/URL:/Published:/Highlights:`，
 * keenable 是 `Title:/URL:/Acquired:/Snippets:` —— 字段名不一样，必须宽松匹配，
 * 否则标题会退化成 URL（真机上看就是一列裸链接）。
 */
function itemsFromText(text) {
  const out = [];
  const blocks = String(text || '').split(/\n(?=Title:\s*)/);
  for (const block of blocks) {
    const titleM = /^Title:\s*(.+)$/m.exec(block);
    const urlM = /^(?:URL|Url|url|Link):\s*(\S+)$/m.exec(block);
    if (!urlM) continue;
    const dateM = /^(?:Published|Acquired|Updated|Date):\s*(.+)$/im.exec(block);
    const snipM = /^(?:Highlights|Snippets|Snippet|Text|Description|Summary|Content):\s*([\s\S]*)$/im.exec(block);
    out.push({
      title: titleM ? titleM[1].trim() : urlM[1].trim(),
      url: urlM[1].trim(),
      snippet: cleanText(snipM ? snipM[1] : '').slice(0, 300),
      published_at: dateM ? dateM[1].trim() : null
    });
  }
  if (out.length) return out;
  // 兜底：只有 URL 列表时也别丢（标题用 URL 顶）
  const urls = [...String(text || '').matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((x) => x[0]);
  return urls.slice(0, 10).map((u) => ({ title: u, url: u, snippet: '', published_at: null }));
}

/** 把 tools/call 的返回拆成 { error, contents } */
export function readMcpResult(text) {
  const frames = parseMcpFrames(text);
  const contents = [];
  let error = '';
  for (const frame of frames) {
    if (frame && frame.error) {
      error = String(frame.error.message || frame.error);
      continue;
    }
    const result = frame && frame.result;
    if (!result) continue;
    if (result.isError) error = String((result.content || []).map((c) => c.text).join(' ') || 'tool error');
    for (const c of result.content || []) {
      if (c && typeof c.text === 'string' && c.text) contents.push(c.text);
    }
  }
  return { error, contents };
}

export function itemsFromContents(contents) {
  const out = [];
  for (const text of contents) {
    const trimmed = String(text || '').trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const items = Array.isArray(parsed) ? itemsFromJson({ results: parsed }) : itemsFromJson(parsed);
        if (items.length) {
          out.push(...items);
          continue;
        }
      } catch {
        /* 不是 JSON，走文本解析 */
      }
    }
    out.push(...itemsFromText(trimmed));
  }
  return out;
}

export async function callMcpTool(engineId, tool, args, { timeoutMs = 15000, signal = null } = {}) {
  const def = MCP_ENGINES[engineId];
  if (!def) throw new Error(`未知 MCP 引擎 ${engineId}`);
  const res = await fetchText(def.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: tool, arguments: args }
    }),
    timeoutMs,
    signal
  });
  if (res.status !== 200) throw new Error(`${engineId} HTTP ${res.status}`);
  const parsed = readMcpResult(res.text);
  if (parsed.error) throw new Error(`${engineId} 返回错误：${parsed.error.slice(0, 120)}`);
  return parsed;
}

export async function searchMcp(engineId, { query, count = 8, timeoutMs = 15000, signal = null }) {
  const def = MCP_ENGINES[engineId];
  if (!def) throw new Error(`未知 MCP 引擎 ${engineId}`);
  const { contents } = await callMcpTool(engineId, def.tool, def.buildArgs(query, count), { timeoutMs, signal });
  const items = itemsFromContents(contents);
  if (items.length === 0) throw new Error(`${engineId} returned 0 results`);
  const sources = items
    .map((x) => ({
      title: cleanText(x.title).slice(0, 200),
      url: String(x.url || '').trim(),
      snippet: snippet(x.snippet || ''),
      published_at: x.published_at || null
    }))
    .filter((x) => /^https?:\/\//i.test(x.url));
  return { sources: sources.slice(0, count), truncated: sources.length > count };
}

/** 读取兜底：keenable 的 fetch_page_content（静态抓取拿不到正文时才用） */
export async function fetchViaMcp(url, { timeoutMs = 25000, signal = null } = {}) {
  const { contents } = await callMcpTool('keenable', 'fetch_page_content', { url }, { timeoutMs, signal });
  const text = contents.join('\n').trim();
  if (!text) throw new Error('keenable 未返回正文');
  const titleMatch = /^Title:\s*(.+)$/m.exec(text);
  const urlMatch = /^URL:\s*(\S+)$/m.exec(text);
  const body = text
    .replace(/^Title:\s*.+$/m, '')
    .replace(/^URL:\s*\S+$/m, '')
    .replace(/^!\[[^\]]*\]\([^)]*\)$/gm, '')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .trim();
  return {
    title: titleMatch ? cleanText(titleMatch[1]) : '',
    url: urlMatch ? urlMatch[1] : url,
    text: body
  };
}
