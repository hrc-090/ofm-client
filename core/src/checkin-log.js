/**
 * 签到日志：按天分片 JSONL，一条 = 一个可直接展示的事件。
 *
 * 目标是回答「今天到底签没签到、卡在哪一层」，所以记录：
 *  - 一轮自动签到的触发（启动 / 跨天巡检 / 开关）、逐渠道结果、是否记入今日；
 *  - 手动签到逐账号的 outcome 与错误原因；
 *  - 状态 / 余额查询失败（真机上最常见的「静默查不到」）。
 *
 * 三条硬约束：
 *  1) **绝不落凭据**：所有文本过 sanitizeMessage，账号只留「渠道#尾 4 位」；
 *  2) 写失败 / 脏数据绝不影响签到本身，全部 try/catch，失败只 warn；
 *  3) 只追加、只删整天分片，单日文件超上限就停写，别把手机存储写满。
 *
 * 为什么自己一份而不是塞进 usage-store：用量日志是「每次转发请求一行」，
 * 语义、保留期、展示位置都不同；混在一起排查签到时会翻不到有效信息。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dayKey, maskAccount } from './usage-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LEVELS = new Set(['info', 'ok', 'warn', 'error']);
const TYPES = new Set(['run', 'channel', 'account', 'query']);
const SOURCES = new Set(['auto', 'manual']);
const OUTCOMES = new Set([
  'claimed', 'already-claimed', 'inactive', 'failed', 'skipped', 'excluded', 'empty', 'started', 'finished'
]);

/**
 * 错误文案可能来自上游响应体，里面偶尔夹 token / 回调链接。
 * 先去 Bearer / key=value 形式，再把超长疑似 token/JWT 整串打码，最后截断。
 * 注意：宁可把错误码打码，也不能把凭据写进日志。
 */
export function sanitizeMessage(raw, max = 240) {
  let s = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***');
  s = s.replace(
    /(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|token|secret|password|cookie|jwt|session|code)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}["']?/gi,
    '$1=***'
  );
  s = s.replace(/\b[A-Za-z0-9._~+/=-]{40,}\b/g, '***');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s.slice(0, Math.max(1, Math.min(500, Math.floor(Number(max) || 240))));
}

const int = (v, fallback = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const clip = (v, max) => sanitizeMessage(v, max);

const OUTCOME_LABEL = {
  claimed: '领取成功',
  'already-claimed': '今天已领',
  inactive: '未开启',
  failed: '失败',
  skipped: '跳过',
  excluded: '需手动',
  empty: '无可领',
  started: '开始',
  finished: '结束'
};
const SOURCE_LABEL = { auto: '自动', manual: '手动' };
// 与 App 端 checkinSourceLabel 逐字对齐，纯文本报告才不会出现 startup/app 这种内部词
const TRIGGER_LABEL = {
  startup: '启动', tick: '巡检', toggle: '开关', app: 'App', schedule: '排定'
};
const TYPE_LABEL = { run: '本轮', channel: '渠道', account: '账号', query: '查询' };

export function formatCheckinLogLine(e) {
  const d = new Date(int(e.ts));
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const source = SOURCE_LABEL[e.source] || e.source || '?';
  const trigger = e.trigger ? `/${TRIGGER_LABEL[e.trigger] || e.trigger}` : '';
  const type = TYPE_LABEL[e.type] || e.type || '?';
  const who = [e.provider, e.account].filter(Boolean).join('/');
  const outcome = OUTCOME_LABEL[e.outcome] || '';
  const head = outcome ? `${outcome}：` : '';
  const ms = e.ms ? ` (${int(e.ms)}ms)` : '';
  const marked = typeof e.markedToday === 'boolean' ? ` [${e.markedToday ? '已记入今日' : '未记入今日，会重试'}]` : '';
  return `[${stamp}] [${source}${trigger}] [${type}]${who ? ` [${who}]` : ''} ${head}${e.message || ''}${marked}${ms}`;
}

/** 字段归一化：任何脏数据都收敛成有限枚举与短字符串，绝不抛错。 */
export function normalizeCheckinEntry(entry = {}, now = () => Date.now()) {
  const source = SOURCES.has(entry.source) ? entry.source : 'manual';
  const provider = clip(entry.provider, 32);
  const out = {
    ts: int(entry.ts, now()),
    source,
    type: TYPES.has(entry.type) ? entry.type : 'run',
    level: LEVELS.has(entry.level) ? entry.level : 'info',
    message: sanitizeMessage(entry.message, 240),
    ms: int(entry.ms, 0)
  };
  if (entry.runId) out.runId = clip(entry.runId, 40);
  if (entry.trigger) out.trigger = clip(entry.trigger, 24);
  if (provider) out.provider = provider;
  // ⚠️ 调用方传的是完整 accountId，这里统一打成「渠道#尾4位」
  if (entry.account) out.account = maskAccount(provider, entry.account);
  if (OUTCOMES.has(entry.outcome)) out.outcome = entry.outcome;
  if (typeof entry.markedToday === 'boolean') out.markedToday = entry.markedToday;
  if (entry.counts && typeof entry.counts === 'object') {
    out.counts = {
      claimed: int(entry.counts.claimed),
      alreadyClaimed: int(entry.counts.alreadyClaimed),
      failed: int(entry.counts.failed),
      inactive: int(entry.counts.inactive),
      skipped: int(entry.counts.skipped)
    };
  }
  return out;
}

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

export function createCheckinLog({
  dir,
  log = null,
  now = () => Date.now(),
  retentionDays = 30,
  maxFileBytes = 8 * 1024 * 1024,
  flushDelayMs = 60
} = {}) {
  if (!dir) throw new Error('checkin-log 需要 dir');
  const disabledDays = new Set();
  let queue = [];
  let timer = null;
  let written = 0;
  let dropped = 0;

  const fileOf = (day) => path.join(dir, `${day}.jsonl`);
  const listFiles = () => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  };

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
          log?.warn?.(`签到日志 ${day} 已达单日上限（${maxFileBytes} 字节），今日不再写入`);
          continue;
        }
        fs.appendFileSync(file, text, { mode: 0o600 });
        written += 1;
      } catch (e) {
        dropped += 1;
        log?.warn?.(`写签到日志失败: ${sanitizeMessage(e?.message, 120)}`);
      }
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, flushDelayMs);
    if (timer.unref) timer.unref();
  }

  function record(entry = {}) {
    try {
      queue.push(normalizeCheckinEntry(entry, now));
      if (queue.length >= 200) flush();
      else schedule();
    } catch (e) {
      dropped += 1;
      log?.warn?.(`记录签到日志失败: ${sanitizeMessage(e?.message, 120)}`);
    }
  }

  /** 读取前先 flush：用户点完签到立刻刷新，日志不能还是空的。 */
  function allRecent({ limit = 100 } = {}) {
    flush();
    const want = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const out = [];
    for (const file of listFiles().slice(-3).reverse()) {
      for (const line of linesOf(file)) {
        try {
          out.push(JSON.parse(line));
        } catch {
          /* 半行（进程被杀）跳过 */
        }
      }
      if (out.length >= want * 3) break;
    }
    return out.sort((a, b) => int(b.ts) - int(a.ts)).slice(0, want);
  }

  async function recent({ limit = 100 } = {}) {
    return allRecent({ limit });
  }

  /** 窗口内轻量统计，供界面显示「今日成功 X / 失败 Y」。 */
  async function summary({ days = 1 } = {}) {
    const n = Math.min(30, Math.max(1, Math.floor(Number(days) || 1)));
    const cutoff = dayKey(now() - (n - 1) * DAY_MS);
    const s = { days: n, entries: 0, runs: 0, claimed: 0, failed: 0, skipped: 0, lastRunAt: null, lastClaimAt: null };
    for (const file of listFiles()) {
      if (path.basename(file, '.jsonl') < cutoff) continue;
      for (const line of linesOf(file)) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        s.entries += 1;
        if (e.outcome === 'finished') s.runs += 1;
        if (e.outcome === 'claimed') {
          s.claimed += 1;
          s.lastClaimAt = Math.max(s.lastClaimAt || 0, int(e.ts)) || null;
        }
        if (e.level === 'error' || e.outcome === 'failed') s.failed += 1;
        if (e.outcome === 'skipped' || e.outcome === 'excluded' || e.outcome === 'inactive' || e.outcome === 'empty') s.skipped += 1;
        if (e.type === 'run') s.lastRunAt = Math.max(s.lastRunAt || 0, int(e.ts)) || null;
      }
    }
    return s;
  }

  /** 纯文本报告：App「复制日志」直接拿它，粘给开发者就能排查。 */
  async function text({ limit = 200 } = {}) {
    const entries = allRecent({ limit });
    const stat = await summary({ days: 1 });
    const d = new Date(now());
    const p = (x) => String(x).padStart(2, '0');
    const head = [
      'OFM 签到日志（本机时间）',
      `生成时间：${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
      `今日：轮次 ${stat.runs} · 领取成功 ${stat.claimed} · 失败 ${stat.failed} · 跳过 ${stat.skipped}`,
      `以下为最近 ${entries.length} 条（倒序，已脱敏，不含任何凭据）`,
      '────────────────────────────'
    ];
    const body = entries.length ? entries.map(formatCheckinLogLine) : ['（暂无签到记录）'];
    return `${head.join('\n')}\n${body.join('\n')}\n`;
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

  function prune() {
    const cutoff = dayKey(now() - retentionDays * DAY_MS);
    let removed = 0;
    for (const file of listFiles()) {
      if (path.basename(file, '.jsonl') < cutoff) {
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
    record,
    recent,
    summary,
    text,
    clear,
    prune,
    flush,
    stats: () => ({ queued: queue.length, written, dropped, files: listFiles().length })
  };
}
