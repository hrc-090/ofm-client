/**
 * AnySearch keyless REST（实测 5/5 全通，中文结果好，但延迟抖动大 1.1–6.7s）。
 * 结果在 `data.results`，不是 OpenAI 那种 `data` 数组。
 */
import { fetchText } from '../http-text.js';
import { cleanText, snippet } from '../sanitize.js';

export async function searchAnySearch({ query, count = 8, timeoutMs = 20000, signal = null }) {
  const res = await fetchText('https://api.anysearch.com/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, max_results: Math.max(1, Math.min(20, count)) }),
    timeoutMs,
    signal
  });
  if (res.status !== 200) throw new Error(`anysearch HTTP ${res.status}`);
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new Error('anysearch 返回非 JSON');
  }
  const list = (json && json.data && json.data.results) || (json && json.results) || [];
  if (!Array.isArray(list) || list.length === 0) throw new Error('anysearch returned 0 results');
  const sources = list
    .map((x) => ({
      title: cleanText(x.title).slice(0, 200),
      url: String(x.url || '').trim(),
      snippet: snippet(x.snippet || x.content || ''),
      published_at: x.published_at || x.publish_date || null
    }))
    .filter((x) => /^https?:\/\//i.test(x.url));
  return { sources: sources.slice(0, count), truncated: sources.length > count };
}
