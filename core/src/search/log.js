/**
 * 搜索日志：内存环形 200 条，只记「哪一层失败」，不记正文、不记 Key。
 *
 * 真机排查「开了搜索却搜不到」时，第一件事就是看最近几次的 source/耗时/失败类，
 * 落盘没必要（也会带隐私），进程内够用。
 */
const MAX = 200;

export function createSearchLog({ limit = MAX, now = () => Date.now() } = {}) {
  const entries = [];

  function record(entry) {
    const row = {
      at: now(),
      kind: entry.kind || 'search',
      ok: entry.ok !== false,
      query: String(entry.query || '').slice(0, 60),
      provider: entry.provider || '',
      ms: Number(entry.ms) || 0,
      count: Number(entry.count) || 0,
      cached: entry.cached === true,
      note: String(entry.note || '').slice(0, 200),
      failure: entry.failure || ''
    };
    entries.push(row);
    while (entries.length > limit) entries.shift();
    return row;
  }

  return {
    record,
    recent({ n = 50 } = {}) {
      return entries.slice(-Math.max(1, Math.min(limit, n))).reverse();
    },
    clear() {
      const n = entries.length;
      entries.length = 0;
      return n;
    },
    summary() {
      const byProvider = {};
      let ok = 0;
      for (const e of entries) {
        if (e.ok) ok += 1;
        const k = e.provider || e.failure || 'unknown';
        byProvider[k] = (byProvider[k] || 0) + 1;
      }
      return { total: entries.length, ok, failed: entries.length - ok, byProvider };
    }
  };
}
