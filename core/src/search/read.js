/**
 * 本地静态抓取（读取回退）。
 *
 * 只做一件事：把 HTML 变干净正文。实测对服务端渲染的站足够好
 * （人民网 30ms/9133 字、MDN 917ms/71532 字），前端渲染站只能拿到壳——
 * 那种情况才值得调 keenable 兜底。
 *
 * 明确不做：JS 渲染、样式计算、阅读模式打分。手机端跑不动，也没必要。
 */
import { fetchText } from './http-text.js';
import { decodeEntities, stripBrokenChars, truncateChars, cleanText } from './sanitize.js';

const DROP_BLOCKS =
  /<(script|style|noscript|svg|iframe|form|nav|footer|aside|template|canvas)\b[\s\S]*?<\/\1>/gi;

function pickRegion(html) {
  // 多个 <article> 时取文本最长的那个（列表页常见「一条一块」）
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]);
  if (articles.length) {
    const best = articles.reduce((a, b) => (a.length >= b.length ? a : b));
    if (best.length > 400) return best;
  }
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (main && main[1].length > 400) return main[1];
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return body ? body[1] : html;
}

function titleOf(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og) return cleanText(decodeEntities(og[1]));
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return t ? cleanText(decodeEntities(t[1])) : '';
}

export function extractReadable(html, { maxChars = 20000 } = {}) {
  const src = String(html || '');
  const title = titleOf(src);
  let body = src.replace(/<!--[\s\S]*?-->/g, ' ').replace(DROP_BLOCKS, ' ');
  body = pickRegion(body);

  body = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|blockquote|pre|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');

  const text = stripBrokenChars(decodeEntities(body))
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length >= 2)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = text.length > maxChars;
  return { title, text: truncateChars(text, maxChars), truncated };
}

export async function readLocal(url, { maxChars = 20000, timeoutMs = 12000, signal = null } = {}) {
  const res = await fetchText(url, {
    headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
    timeoutMs,
    maxBytes: 3 * 1024 * 1024,
    signal
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`读取失败 HTTP ${res.status}`);
  const ct = String(res.headers['content-type'] || '').toLowerCase();
  if (ct && !ct.includes('html') && !ct.includes('text/plain') && !ct.includes('xml')) {
    throw new Error(`不是网页（${ct.split(';')[0]}）`);
  }
  const { title, text, truncated } = extractReadable(res.text, { maxChars });
  if (!text || text.length < 40) throw new Error('没抓到正文（可能是前端渲染页面）');
  return { title, text, final_url: res.finalUrl, truncated, bytes: res.bytes };
}
