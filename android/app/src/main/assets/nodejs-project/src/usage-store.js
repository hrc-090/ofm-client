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
 *
 * 统计口径对齐上游「数据看板」：
 *  - 流式响应头已经发出 200，业务失败由 handler 显式写 rec.ok=false，
 *    不能再靠 statusCode 判断（否则断流 / EMPTY_REPLY 全被算成成功）；
 *  - 输出速度逐次采样、按总 token / 总生成窗口加权，**绝不平均每条的 tok/s**
 *    （一条 10tok/10ms 的小请求会把算术平均抬到失真的数值）；
 *  - 没有有效生成窗口（单大帧 / 纯思考静默 / 无 usage）时速度留空，
 *    看板显示「—」，不把思考耗时折算进输出速度。
 */
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 17 周热力图需要的窗口，也是 summary 的上限 */
export const MAX_SUMMARY_DAYS = 119;
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

/**
 * 一条记录能否贡献速度样本。
 * 至少两个正文片段才存在「生成窗口」：单帧把整段答案一次吐出来的模型，
 * 以及思考静默 60s 后直接空停的模型，都没有可测的时间窗，宁可留空。
 */
export function isSpeedSample(e) {
  if (!e || e.ok === false) return false;
  const genMs = e.genMs == null ? null : int(e.genMs);
  return genMs != null && genMs > 0 && int(e.outTok) > 0 && int(e.deltas) >= 2;
}

/**
 * 能除以生成窗口的输出 token 数。
 *
 * 有些模型把从未流式下发的思考也算进 completion_tokens：实测一次 422 输出里
 * 有 291 是 reasoning，而思考帧一个都没到。那 291 个 token 是在窗口起点之前
 * 产生的，把它算进分母会得到 349 tok/s 这种假速度（真实答案只有 108）。
 *
 * 规则：**没有流式思考帧**时，分子减掉 reasoning；有思考帧时窗口覆盖了它，
 * 全额计入。
 */
export function speedTokens(e) {
  const out = int(e?.outTok);
  if (e?.sawReasoning === true) return out;
  return Math.max(0, out - int(e?.reasonTok));
}

/**
 * 业务失败时由 handler 显式写进 rec。
 *
 * 流式响应头已经 writeHead(200)，catch 里再怎么写错误帧，res.statusCode
 * 依然是 200 —— 只靠状态码会把断流 / EMPTY_REPLY / 上游 502 全算成成功。
 * 这里把 ok/code/status/truncated 直接钉在 rec 上，attach 的 finish 会优先采信。
 *
 * @param {object} rec      res.ofmUsage
 * @param {object} err      normalizeError 的结果（含 code / status）
 * @param {object} opts     truncated：已流出过正文的半截流
 */
export function markUsageFailed(rec, err, { truncated = false } = {}) {
  if (!rec) return;
  rec.ok = false;
  if (err?.code) rec.code = String(err.code).slice(0, 40);
  if (err?.status) rec.status = Number(err.status) || 502;
  if (truncated) rec.truncated = true;
}

function normalize(entry, now) {
  const provider = str(entry.provider, 32);
  const firstMs = entry.firstMs == null ? null : int(entry.firstMs, 0);
  const genMs = entry.genMs == null ? null : int(entry.genMs, 0);
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
    ...(genMs == null ? {} : { genMs }),
    deltas: int(entry.deltas, 0),
    stream: entry.stream === true,
    inTok: int(entry.inTok, 0),
    outTok: int(entry.outTok, 0),
    // 思考 token 与「本轮是否真的流过思考帧」：速度分子要靠它们剔除
    // 上游算了但没下发的那部分（见 speedTokens）。
    ...(int(entry.reasonTok) > 0 ? { reasonTok: int(entry.reasonTok) } : {}),
    // 省 Token：这次请求被 RTK 压缩掉的字节数（只记节省，不记内容）
    ...(int(entry.savedBytes) > 0 ? { savedBytes: int(entry.savedBytes) } : {}),
    ...(int(entry.savedHits) > 0 ? { savedHits: int(entry.savedHits) } : {}),
    ...(entry.sawReasoning === true ? { sawReasoning: true } : {}),
    cachedTok: int(entry.cachedTok, 0),
    // 稀疏标记：只有上游真的上报过缓存字段才写 true。
    // 缺省 = 未上报（或旧版本落盘的记录），summary 里用 cachedTok>0 兼容反推。
    ...(entry.cacheSeen === true ? { cacheSeen: true } : {}),
    ...(entry.truncated === true ? { truncated: true } : {}),
    ...(entry.noUsage === true ? { noUsage: true } : {}),
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
  return {
    day, requests: 0, ok: 0, failed: 0,
    inTok: 0, outTok: 0, cachedTok: 0, tok: 0,
    truncated: 0,
    savedBytes: 0,
    speedOutTok: 0, speedGenMs: 0, speedSamples: 0
  };
}

/** 把内部累计量折算成对外字段，隐藏分子分母。 */
function publicDay(b) {
  const { speedOutTok, speedGenMs, speedSamples, ...rest } = b;
  return {
    ...rest,
    speedTokPerSec: speedGenMs ? Math.round((speedOutTok * 1000 * 10) / speedGenMs) / 10 : null,
    speedSamples
  };
}

export function createUsageStore({
  dir,
  log = null,
  // 17 周热力图要有数据可画；单日文件仍有 maxFileBytes 上限保护。
  retentionDays = 120,
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
      firstAt: 0,
      lastAt: 0
    };
    res.once('finish', () => {
      // 流式响应头已经 writeHead(200)，handler 在 catch 里写的 ok=false 才是
      // 业务真值。没有显式标记（非流式 / 外层 sendJson）时才回退到状态码。
      if (rec.ok !== false && rec.ok !== true) {
        rec.ok = res.statusCode >= 200 && res.statusCode < 300;
      }
      rec.status = rec.status || res.statusCode;
      rec.ms = now() - rec.ts;
      if (!rec.ok && !rec.code) rec.code = `HTTP_${rec.status}`;
      if (rec.firstAt) {
        if (!rec.firstMs) rec.firstMs = rec.firstAt - rec.ts;
        if (rec.lastAt && rec.lastAt > rec.firstAt) rec.genMs = rec.lastAt - rec.firstAt;
      }
      record(rec);
    });
    res.ofmUsage = rec;
    return rec;
  }

  /** 近 N 天聚合。按天逐文件流式读，不把整套历史读进内存。 */
  async function summary({ days = 7 } = {}) {
    const n = Math.min(MAX_SUMMARY_DAYS, Math.max(1, Math.floor(Number(days) || 7)));
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
    const byAccount = new Map();
    const byCode = new Map();
    const byUa = new Map();
    const totals = {
      requests: 0, ok: 0, failed: 0,
      inTok: 0, outTok: 0, cachedTok: 0,
      msSum: 0, okMsSum: 0, okMsCount: 0,
      firstSum: 0, firstCount: 0,
      cacheInTok: 0, cacheReportedReqs: 0,
      speedOutTok: 0, speedGenMs: 0, speedSamples: 0,
      truncated: 0, noUsage: 0, savedBytes: 0
    };

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
        const inTok = int(e.inTok);
        const outTok = int(e.outTok);
        const cachedTok = int(e.cachedTok);
        const ms = int(e.ms);
        const firstMs = e.firstMs == null ? null : int(e.firstMs);
        const genMs = e.genMs == null ? null : int(e.genMs);
        const speedOk = isSpeedSample(e);

        bucket.requests += 1;
        bucket.ok += failed ? 0 : 1;
        bucket.failed += failed;
        bucket.inTok += inTok;
        bucket.outTok += outTok;
        bucket.cachedTok += cachedTok;
        bucket.tok += inTok + outTok;
        if (e.truncated === true) bucket.truncated += 1;
        if (e.savedBytes) bucket.savedBytes += int(e.savedBytes);
        if (speedOk) {
          bucket.speedOutTok += speedTokens(e);
          bucket.speedGenMs += genMs;
          bucket.speedSamples += 1;
        }

        totals.requests += 1;
        totals.ok += failed ? 0 : 1;
        totals.failed += failed;
        totals.inTok += inTok;
        totals.outTok += outTok;
        totals.cachedTok += cachedTok;
        // 命中率的分母只算「上游上报过缓存字段」的请求，否则没上报的请求
        // 会把命中率稀释成接近 0 —— 那正是「缓存命中一直是零」的一半原因。
        // 旧记录没有 cacheSeen 标记，用 cachedTok>0 兼容反推。
        const cacheReported = e.cacheSeen === true || cachedTok > 0;
        if (cacheReported) {
          totals.cacheInTok += inTok;
          totals.cacheReportedReqs += 1;
        }
        // 平均耗时只统计成功请求：一次 75s 超时的失败不该把「平均耗时」
        // 拉到几十秒，那反映的是故障而不是日常体验。
        totals.msSum += ms;
        if (!failed) {
          totals.okMsSum += ms;
          totals.okMsCount += 1;
        }
        if (firstMs != null) {
          totals.firstSum += firstMs;
          totals.firstCount += 1;
        }
        if (speedOk) {
          totals.speedOutTok += speedTokens(e);
          totals.speedGenMs += genMs;
          totals.speedSamples += 1;
        }
        if (e.truncated === true) totals.truncated += 1;
        if (e.savedBytes) totals.savedBytes += int(e.savedBytes);
        if (e.noUsage === true) totals.noUsage += 1;
        if (failed && e.code) {
          const code = str(e.code, 40);
          byCode.set(code, (byCode.get(code) || 0) + 1);
        }

        const mk = `${e.provider || '?'}/${e.model || '?'}`;
        const mm = byModel.get(mk) || {
          model: mk, requests: 0, ok: 0, failed: 0, inTok: 0, outTok: 0, cachedTok: 0,
          msSum: 0, okMsCount: 0, firstSum: 0, firstCount: 0,
          speedOutTok: 0, speedGenMs: 0, speedSamples: 0
        };
        mm.requests += 1;
        mm.ok += failed ? 0 : 1;
        mm.failed += failed;
        mm.inTok += inTok;
        mm.outTok += outTok;
        mm.cachedTok += cachedTok;
        if (!failed) {
          mm.msSum += ms;
          mm.okMsCount += 1;
        }
        if (firstMs != null) {
          mm.firstSum += firstMs;
          mm.firstCount += 1;
        }
        if (speedOk) {
          mm.speedOutTok += speedTokens(e);
          mm.speedGenMs += genMs;
          mm.speedSamples += 1;
        }
        byModel.set(mk, mm);

        const pk = e.provider || '?';
        const pm = byProvider.get(pk) || { provider: pk, requests: 0, ok: 0, inTok: 0, outTok: 0 };
        pm.requests += 1;
        pm.ok += failed ? 0 : 1;
        pm.inTok += inTok;
        pm.outTok += outTok;
        byProvider.set(pk, pm);

        // 账号透视：rec.account 已脱敏成「渠道#尾4位」，可直接展示。
        const ak = e.account || '';
        if (ak) {
          const am = byAccount.get(ak) || { account: ak, requests: 0, ok: 0, inTok: 0, outTok: 0 };
          am.requests += 1;
          am.ok += failed ? 0 : 1;
          am.inTok += inTok;
          am.outTok += outTok;
          byAccount.set(ak, am);
        }

        const uk = e.ua || 'other';
        byUa.set(uk, (byUa.get(uk) || 0) + 1);
      }
    }

    const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
    const speedOf = (o) => (o.speedGenMs ? round((o.speedOutTok * 1000) / o.speedGenMs) : null);
    const models = [...byModel.values()]
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10)
      .map((m) => ({
        model: m.model,
        requests: m.requests,
        ok: m.ok,
        failed: m.failed,
        successRate: m.requests ? round((m.ok / m.requests) * 100) : null,
        inTok: m.inTok,
        outTok: m.outTok,
        cachedTok: m.cachedTok,
        avgFirstMs: m.firstCount ? Math.round(m.firstSum / m.firstCount) : null,
        avgMs: m.okMsCount ? Math.round(m.msSum / m.okMsCount) : null,
        speedTokPerSec: speedOf(m),
        speedSamples: m.speedSamples
      }));

    return {
      days: n,
      retentionDays,
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
        avgMs: totals.okMsCount ? Math.round(totals.okMsSum / totals.okMsCount) : null,
        avgMsAll: totals.requests ? Math.round(totals.msSum / totals.requests) : null,
        avgFirstMs: totals.firstCount ? Math.round(totals.firstSum / totals.firstCount) : null,
        firstSamples: totals.firstCount,
        // 加权速度：总输出 token / 总生成窗口，不是每条 tok/s 的算术平均。
        speedTokPerSec: speedOf(totals),
        speedSamples: totals.speedSamples,
        truncated: totals.truncated,
        noUsage: totals.noUsage,
        // 省 Token 累计节省的字节数（RTK 压缩工具输出的结果）
        savedBytes: totals.savedBytes,
        savedTokens: Math.round(totals.savedBytes / 4)
      },
      byDay: buckets.map(publicDay),
      byModel: models,
      byProvider: [...byProvider.values()].sort((a, b) => b.requests - a.requests),
      byAccount: [...byAccount.values()].sort((a, b) => b.requests - a.requests).slice(0, 10),
      byCode: [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      byUa: [...byUa.entries()].map(([ua, count]) => ({ ua, count })).sort((a, b) => b.count - a.count)
    };
  }

  /** 最近明细，倒序。按天分片倒序读，读够就停，不再只盯最近 3 个文件。 */
  async function recent({ limit = 100, days = 0 } = {}) {
    const want = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const window = Math.min(MAX_SUMMARY_DAYS, Math.max(0, Math.floor(Number(days) || 0)));
    // 与 summary 对齐：days=N 表示「含今天在内 N 个自然日」，
    // 所以 cutoff 是 N-1 天前，而不是 N 天前（后者会多算一天）。
    const cutoff = window ? dayKey(now() - (window - 1) * DAY_MS) : null;
    const out = [];
    const files = listFiles().reverse();
    for (const file of files) {
      if (cutoff && path.basename(file, '.jsonl') < cutoff) break;
      for (const line of linesOf(file)) {
        try {
          out.push(JSON.parse(line));
        } catch {
          /* 跳过半行 */
        }
      }
      if (out.length >= want) break;
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
