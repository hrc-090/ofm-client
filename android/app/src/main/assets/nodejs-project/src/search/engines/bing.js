/**
 * Bing HTML 抓取（cn.bing.com）。
 *
 * 实测：这是国内网络下最快最稳的一个源（130–220ms / 10 条），
 * 但有两个必须处理的细节，否则结果直接脏掉：
 *  1. `href` 是 `bing.com/ck/a?...&u=a1<base64url>`，不解码客户端只会拿到跳转链；
 *  2. 摘要里混着 `&ensp;` `&#0183;`（`&middot;` 的十进制写法），不先解码就是乱码。
 */
import { fetchText } from '../http-text.js';
import { decodeEntities, cleanText } from '../sanitize.js';

function decodeBingLink(href) {
  const raw = String(href || '');
  if (!raw) return '';
  if (!/[?&]u=a1/.test(raw)) return raw;
  try {
    const u = new URL(raw, 'https://www.bing.com');
    const token = u.searchParams.get('u') || '';
    if (!token.startsWith('a1')) return raw;
    const b64 = token.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const out = Buffer.from(b64, 'base64').toString('utf8');
    return /^https?:\/\//i.test(out) ? out : raw;
  } catch {
    return raw;
  }
}

/** 标题里不能插空格：Bing 的高亮会把 `<strong>` 塞进词中间，换成空格就成了「上海 天气 预报」 */
function stripTags(html) {
  return cleanText(decodeEntities(String(html || '').replace(/<[^>]*>/g, '')));
}

/** 摘要里要空格：相邻块不分开会粘成一长串 */
function stripTagsSpaced(html) {
  return cleanText(decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')));
}

export function parseBingHtml(html) {
  const blocks = String(html || '').split('<li class="b_algo"').slice(1);
  const items = [];
  for (const block of blocks) {
    const anchor = /<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!anchor) continue;
    const title = stripTags(anchor[2]);
    const url = decodeBingLink(decodeEntities(anchor[1]));
    if (!title || !url) continue;
    const snip =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block) ||
      /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(block) ||
      /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    items.push({
      title,
      url,
      snippet: stripTagsSpaced(snip ? snip[1] : ''),
      published_at: null
    });
  }
  return items;
}

export async function searchBing({ query, count = 8, timeoutMs = 12000, signal = null }) {
  const want = Math.max(1, Math.min(20, Number(count) || 8));
  const items = [];
  // 一页 10 条，要更多就翻一页；不为了 20 条去打第三页（收益低、反爬概率高）
  for (let page = 0; page < 2 && items.length < want; page += 1) {
    const first = page * 10 + 1;
    const url =
      `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans` +
      (first > 1 ? `&first=${first}` : '');
    const res = await fetchText(url, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      signal
    });
    if (res.status !== 200) {
      throw new Error(`bing HTTP ${res.status}`);
    }
    const pageItems = parseBingHtml(res.text);
    if (pageItems.length === 0 && page === 0) {
      // 空 SERP：可能是反爬，也可能是真的没结果；按 0 结果处理，不算失败
      break;
    }
    for (const item of pageItems) {
      if (items.some((x) => x.url === item.url)) continue;
      items.push(item);
    }
    if (pageItems.length < 10) break;
  }
  return { sources: items.slice(0, want), truncated: items.length > want };
}

/** 给验收脚本用的别名：测试要验证 ck 链还原与实体清洗，但不该联网 */
export const parseBingHtmlForTest = parseBingHtml;
