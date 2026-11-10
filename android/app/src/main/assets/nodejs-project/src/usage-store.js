/**
 * 用量记录：按天分片的 JSONL，**只存统计，不存请求/响应正文**。
 *
 * 三条硬约束（按优先顺序）：
 *  1) 写失败绝不影响请求 —— 全部包在 try/catch 里，失败只 warn；
 *  2) 只删整天分片，从不改写已有行（追加写，进程被杀也不破坏历史）；
 *  3) 单日文件超上限就停写并留一条 warn，避免把手机存储写满。
 *
 * 为什么放在 server 层收口：只有 res 的 finish 事件能同时拿到
 * 真实 HTTP 状态码、耗时和最终是否成功，dispatch 里拿不到。
 */
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRACKED_PATHS = new Set([
  '/v1/chat/completions',
  '/chat/completions',
  '/v1/messages',
  '/v1/responses',
  '/responses'
]);

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** UA 归成有限枚举，避免每个客户端版本各占一行。 */
export function classifyUa(raw) {
  const ua = String(raw || '').toLowerCase();
  if (!ua) return 'other';
  if (ua.includes('claude-cli') || ua.includes('claude-code')) return 'claude-code';
  if (ua.includes('codex')) return 'codex';
  if (ua.includes('anthropic')) return 'anthropic-sdk';
  if (ua.includes('okhttp') || ua.includes('ofm')) return 'ofm-app';
  if (ua.includes('curl')) return 'curl';
  if (ua.includes('openai') || ua.includes('python') || ua.includes('node')) return 'openai-sdk';
  return 'other';
}

/** 账号只留「渠道#尾4位」，足够追责又不落完整 id。 */
export function maskAccount(provider, accountId) {
  if (!accountId) return '';
  const tail = String(accountId).slice(-4);
  return provider ? `${provider}#${tail}` : `#${tail}`;
}

const str = (v, max) => String(v ?? '').slice(0, max);
const int = (v, fallback = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function normalize(entry, now) {
  const provider = str(entry.provider, 32);
  const firstMs = entry.firstMs == null ? null : int(entry.firstMs, 0);
  return {
    ts: int(entry.ts, now()),
    path: str(entry.path, 40),
    ok: entry.ok !== false,
    status: int(entry.status, 0),
    ...(entry.code ? { code: str(entry.code, 40) } : {}),
    provider,
    model: str(entry.model, 96),
    account: entry.account ? maskAccount(provider, entry.account) : '',
    ms: int(entry.ms, 0),
    ...(firstMs == null ? {} : { firstMs }),
    deltas: int(entry.deltas, 0),
    stream: entry.stream === true,
    inTok: int(entry.inTok, 0),
    outTok: int(entry.outTok, 0),
    cachedTok: int(entry.cachedTok, 0),
    // 稀疏标记：只有上游真的上报过缓存字段才写 true。
    // 缺省 = 未上报（或旧版本落盘的记录），summary 里用 cachedTok>0 兼容反推。
    ...(entry.cacheSeen === true ? { cacheSeen: true } : {}),
    ua: classifyUa(entry.ua)
  };
}

/**
 * 逐文件同步读。单文件上限 32MB，手机上读一次几十毫秒；
 * 比 readline 流更简单，也不会因为文件被删/无权限而让 for-await 挂住。
 */
function* linesOf(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (s) yield s;
  }
}

function emptyDay(day) {
  return { day, requests: 0, ok: 0, failed: 0, inTok: 0, outTok: 0, cachedTok: 0 };
}

export function createUsageStore({
  dir,
  log = null,
  retentionDays = 30,
  maxFileBytes = 32 * 1024 * 1024,
  now = () => Date.now(),
  flushDelayMs = 100
} = {}) {
  if (!dir) throw new Error('usage-store 需要 dir');
  const disabledDays = new Set();
  let queue = [];
  let timer = null;
  let written = 0;
  let dropped = 0;

  const fileOf = (day) => path.join(dir, `${day}.jsonl`);

  function listFiles() {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    const byDay = new Map();
    for (const e of batch) {
      const day = dayKey(e.ts);
      if (disabledDays.has(day)) {
        dropped += 1;
        continue;
      }
      byDay.set(day, (byDay.get(day) || '') + `${JSON.stringify(e)}\n`);
    }
    for (const [day, text] of byDay) {
      const file = fileOf(day);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (size + Buffer.byteLength(text) > maxFileBytes) {
          disabledDays.add(day);
          dropped += 1;
          log?.warn?.(`用量日志 ${day} 已达单日上限（${maxFileBytes} 字节），今日不再写入`);
          continue;
        }
        fs.appendFileSync(file, text, { mode: 0o600 });
        written += 1;
      } catch (e) {
        dropped += 1;
        log?.warn?.(`写用量日志失败: ${str(e?.message, 120)}`);
      }
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, flushDelayMs);
    if (timer.unref) timer.unref();
  }

  /** 入队一条用量。字段不合法的按 0 处理，绝不抛错。 */
  function record(entry = {}) {
    try {
      queue.push(normalize(entry, now));
      if (queue.length >= 200) flush();
      else schedule();
    } catch (e) {
      dropped += 1;
      log?.warn?.(`记录用量失败: ${str(e?.message, 120)}`);
    }
  }

  /**
   * 挂到一次出站请求上：返回可写的 rec，finish 时自动落盘。
   * 非对话路径返回 null（管理接口不计入用量）。
   */
  function attach(req, res, routePath) {
    if (req.method !== 'POST' || !TRACKED_PATHS.has(routePath)) return null;
    const rec = {
      ts: now(),
      path: routePath,
      stream: false,
      ua: req.headers['user-agent'] || '',
      firstAt: 0
    };
    res.once('finish', () => {
      rec.status = res.statusCode;
      rec.ok = res.statusCode >= 200 && res.statusCode < 300;
      rec.ms = now() - rec.ts;
      if (!rec.ok && !rec.code) rec.code = `HTTP_${res.statusCode}`;
      if (rec.firstAt && !rec.firstMs) rec.firstMs = rec.firstAt - rec.ts;
      record(rec);
    });
    res.ofmUsage = rec;
    return rec;
  }

  /** 近 N 天聚合。按天逐文件流式读，不把整套历史读进内存。 */
  async function summary({ days = 7 } = {}) {
    const n = Math.min(90, Math.max(1, Math.floor(Number(days) || 7)));
    const buckets = [];
    const base = new Date(now());
    base.setHours(12, 0, 0, 0);
    for (let i = n - 1; i >= 0; i -= 1) {
      const d = new Date(base);
      d.setDate(d.getDate() - i);
      buckets.push(emptyDay(dayKey(d.getTime())));
    }
    const byDay = new Map(buckets.map((b) => [b.day, b]));
    const byModel = new Map();
    const byProvider = new Map();
    const byUa = new Map();
    const totals = { requests: 0, ok: 0, failed: 0, inTok: 0, outTok: 0, cachedTok: 0, msSum: 0, firstSum: 0, firstCount: 0, cacheInTok: 0, cacheReportedReqs: 0 };

    for (const file of listFiles()) {
      const day = path.basename(file, '.jsonl');
      const bucket = byDay.get(day);
      if (!bucket) continue; // 只聚合窗口内的天
      for (const line of linesOf(file)) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue; // 半行（进程被杀）直接跳过
        }
        const failed = e.ok === false ? 1 : 0;
        bucket.requests += 1;
        bucket.ok += failed ? 0 : 1;
        bucket.failed += failed;
        bucket.inTok += int(e.inTok);
        bucket.outTok += int(e.outTok);
        bucket.cachedTok += int(e.cachedTok);

        totals.requests += 1;
        totals.ok += failed ? 0 : 1;
        totals.failed += failed;
        totals.inTok += int(e.inTok);
        totals.outTok += int(e.outTok);
        totals.cachedTok += int(e.cachedTok);
        // 命中率的分母只算「上游上报过缓存字段」的请求，否则没上报的请求
        // 会把命中率稀释成接近 0 —— 那正是「缓存命中一直是零」的一半原因。
        // 旧记录没有 cacheSeen 标记，用 cachedTok>0 兼容反推。
        const cacheReported = e.cacheSeen === true || int(e.cachedTok) > 0;
        if (cacheReported) {
          totals.cacheInTok += int(e.inTok);
          totals.cacheReportedReqs += 1;
        }
        totals.msSum += int(e.ms);
        if (e.firstMs != null) {
          totals.firstSum += int(e.firstMs);
          totals.firstCount += 1;
        }

        const mk = `${e.provider || '?'}/${e.model || '?'}`;
        const mm = byModel.get(mk) || { model: mk, requests: 0, ok: 0, inTok: 0, outTok: 0, firstSum: 0, firstCount: 0 };
        mm.requests += 1;
        mm.ok += failed ? 0 : 1;
        mm.inTok += int(e.inTok);
        mm.outTok += int(e.outTok);
        if (e.firstMs != null) {
          mm.firstSum += int(e.firstMs);
          mm.firstCount += 1;
        }
        byModel.set(mk, mm);

        const pk = e.provider || '?';
        const pm = byProvider.get(pk) || { provider: pk, requests: 0, inTok: 0, outTok: 0 };
        pm.requests += 1;
        pm.inTok += int(e.inTok);
        pm.outTok += int(e.outTok);
        byProvider.set(pk, pm);

        const uk = e.ua || 'other';
        byUa.set(uk, (byUa.get(uk) || 0) + 1);
      }
    }

    const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
    const models = [...byModel.values()]
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10)
      .map((m) => ({
        model: m.model,
        requests: m.requests,
        ok: m.ok,
        inTok: m.inTok,
        outTok: m.outTok,
        avgFirstMs: m.firstCount ? Math.round(m.firstSum / m.firstCount) : null
      }));

    return {
      days: n,
      totals: {
        requests: totals.requests,
        ok: totals.ok,
        failed: totals.failed,
        successRate: totals.requests ? round((totals.ok / totals.requests) * 100) : null,
        inTok: totals.inTok,
        outTok: totals.outTok,
        cachedTok: totals.cachedTok,
        // 上游是否上报过缓存字段：false 时看板显示「—（上游未上报）」，
        // 而不是把「没数据」误显示成「命中 0」。
        cacheReported: totals.cacheReportedReqs > 0,
        cacheReportedReqs: totals.cacheReportedReqs,
        // 命中率 = 命中缓存的输入 token / **上报过缓存的请求**输入 token。
        // Anthropic 的 cache_read_input_tokens 不计入 input_tokens，故夹到 100 防越界。
        cacheHitRate: totals.cacheReportedReqs && totals.cacheInTok
          ? Math.min(100, round((totals.cachedTok / totals.cacheInTok) * 100))
          : null,
        avgMs: totals.requests ? Math.round(totals.msSum / totals.requests) : null,
        avgFirstMs: totals.firstCount ? Math.round(totals.firstSum / totals.firstCount) : null
      },
      byDay: buckets,
      byModel: models,
      byProvider: [...byProvider.values()].sort((a, b) => b.requests - a.requests),
      byUa: [...byUa.entries()].map(([ua, count]) => ({ ua, count })).sort((a, b) => b.count - a.count)
    };
  }

  /** 最近明细，倒序。只看最近 3 个分片，避免翻整套历史。 */
  async function recent({ limit = 100 } = {}) {
    const want = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const out = [];
    const files = listFiles().slice(-3).reverse();
    for (const file of files) {
      for (const line of linesOf(file)) {
        try {
          out.push(JSON.parse(line));
        } catch {
          /* 跳过半行 */
        }
      }
      if (out.length >= want * 3) break;
    }
    return out.sort((a, b) => int(b.ts) - int(a.ts)).slice(0, want);
  }

  function clear() {
    queue = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    let removed = 0;
    for (const file of listFiles()) {
      try {
        fs.unlinkSync(file);
        removed += 1;
      } catch {
        /* 单个文件删不掉不影响其它 */
      }
    }
    disabledDays.clear();
    return removed;
  }

  /** 删掉超过保留期的整天分片。启动时跑一次即可。 */
  function prune() {
    const cutoff = dayKey(now() - retentionDays * DAY_MS);
    let removed = 0;
    for (const file of listFiles()) {
      const day = path.basename(file, '.jsonl');
      if (day < cutoff) {
        try {
          fs.unlinkSync(file);
          removed += 1;
        } catch {
          /* noop */
        }
      }
    }
    return removed;
  }

  return {
    dir,
    attach,
    record,
    summary,
    recent,
    clear,
    prune,
    flush,
    stats: () => ({ queued: queue.length, written, dropped, files: listFiles().length })
  };
}
