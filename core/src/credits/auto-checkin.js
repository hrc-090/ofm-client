/**
 * 自动签到调度 —— 逐条对齐说明书 §4 与上游 auto-checkin.ts。
 *
 * 这是「看起来能用但每天静默漏领」最容易发生的地方，关键纪律：
 *  - `enabled !== false` 判定（旧文档 / 脏数据按打开）；
 *  - `auto-checkin.json` 独立文件，读盘失败回落默认值（不抛错），写盘临时文件 + rename 原子替换；
 *  - 启动延迟默认 30s，**0 合法**（绝不写 Number(env) || 30000）；
 *  - 跨天巡检 2.5h + 失败退避下限 1h；
 *  - `inflight` 在飞去重（setEnabled(true) 与启动排定可能同时想跑）；
 *  - 排除表（zcode）**先于任何上游请求**生效；
 *  - 记账判据 `shouldMarkToday(totals) === totals.coversToday > 0`；
 *  - `dismissedRunAt` 存那一轮的 `lastAt`（新一轮跑完自动回来）；
 *  - 每一轮都往 `record()`（签到日志）打点：触发来源、逐渠道结果、
 *    是否记入今日。回调是可选的，写日志失败绝不影响签到本身。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  utc8DateString,
  autoCheckinDelayMs,
  autoCheckinTickMs,
  AUTO_CHECKIN_TICK_MS,
  AUTO_CHECKIN_RETRY_MS
} from './constants.js';
import {
  emptyRunTotals,
  accumulateRunTotals,
  shouldMarkToday,
  describeRun,
  describeChannel,
  isUnsupportedCheckin
} from './model.js';
import { isAutoCheckinExcluded } from './capability.js';

export const AUTO_CHECKIN_FILE = 'auto-checkin.json';
const SCHEMA = 'channel-pack/auto-checkin/v1';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CHANNEL_ENTRIES = 24;

export const DEFAULT_AUTO_CHECKIN = {
  enabled: true,
  lastDate: '',
  lastResult: '',
  lastAt: 0,
  channels: [],
  dismissedRunAt: 0
};

function sanitizeChannels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.provider !== 'string' || item.provider.length === 0) continue;
    if (typeof item.text !== 'string') continue;
    out.push({ provider: item.provider, text: item.text.slice(0, 120) });
    if (out.length >= MAX_CHANNEL_ENTRIES) break;
  }
  return out;
}

/** 归一化磁盘脏数据：非法值一律回落默认值，不抛错（后台任务不能因脏文件崩）。 */
export function sanitizeAutoCheckin(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_AUTO_CHECKIN };
  const ms = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    // ⚠️ 只有显式 false 才算关闭；'false' / 0 这些非布尔值按打开处理
    enabled: raw.enabled !== false,
    lastDate: typeof raw.lastDate === 'string' && DATE_RE.test(raw.lastDate) ? raw.lastDate : '',
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : '',
    lastAt: ms(raw.lastAt),
    channels: sanitizeChannels(raw.channels),
    dismissedRunAt: ms(raw.dismissedRunAt)
  };
}

/** 独立文件的读写：读失败回落，写用 tmp + rename 原子替换。 */
export function createAutoCheckinStore(dataDir, log = console) {
  const file = path.join(dataDir, AUTO_CHECKIN_FILE);
  return {
    load() {
      try {
        return sanitizeAutoCheckin(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        return { ...DEFAULT_AUTO_CHECKIN };
      }
    },
    save(doc) {
      const payload = { schema: SCHEMA, ...doc };
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return doc;
    }
  };
}

function defaultSchedule(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t.unref) t.unref();
  return { cancel: () => clearTimeout(t) };
}
function defaultScheduleTick(fn, ms) {
  const t = setInterval(fn, ms);
  if (t.unref) t.unref();
  return { cancel: () => clearInterval(t) };
}

/**
 * @param deps
 *  credits      createCreditsService 的实例
 *  store        createAutoCheckinStore 的实例（可注入 mock）
 *  now          时钟注入（测试 Qoder 09:30 / 跨天）
 *  delayMs      启动延迟（覆盖环境变量）
 *  tickMs       巡检间隔
 *  schedule     一次性定时器注入
 *  scheduleTick 周期定时器注入
 *  warn         日志（只打短文案）
 *  record       签到日志打点回调（可选，默认丢弃；文本由日志层脱敏）
 */
export function createAutoCheckin(deps) {
  const {
    credits,
    store,
    now = () => Date.now(),
    env = process.env,
    delayMs,
    tickMs,
    schedule = defaultSchedule,
    scheduleTick = defaultScheduleTick,
    warn = () => {},
    record = () => {}
  } = deps;
  let doc = store.load();
  let running = false;
  /** 在飞去重：setEnabled(true) 与启动排定可能同时想跑。 */
  let inflight = null;
  let pending = null;
  let tick = null;
  // 尝试时刻覆盖「刻意不记 lastDate」的失败轮次，供失败退避判断
  let lastAttemptAt = doc.lastAt;

  const today = () => utc8DateString(now());

  function state() {
    return {
      enabled: doc.enabled,
      lastDate: doc.lastDate,
      ranToday: doc.lastDate !== '' && doc.lastDate === today(),
      running,
      lastResult: doc.lastResult,
      lastAt: doc.lastAt,
      channels: doc.channels.map((e) => ({ ...e })),
      dismissed: doc.lastAt > 0 && doc.dismissedRunAt === doc.lastAt
    };
  }

  function persist(next) {
    doc = next;
    try {
      store.save(doc);
    } catch (e) {
      warn(`自动签到结果写入失败（今天可能重复触发一次）: ${e?.message || String(e)}`);
    }
  }

  async function performRun(trigger = 'schedule') {
    lastAttemptAt = now();
    const startedAt = now();
    const runId = `auto-${startedAt.toString(36)}`;
    const base = { runId, source: 'auto', trigger };
    /** 日志是旁路：写失败 / 回调抛错都不能影响签到主流程。 */
    const emit = (extra) => {
      try {
        record({ ...base, ...extra });
      } catch {
        /* noop */
      }
    };
    const counts = (totals) => ({
      claimed: totals.claimed,
      alreadyClaimed: totals.alreadyClaimed,
      failed: totals.failed + totals.errors,
      inactive: totals.inactive,
      skipped: totals.skipped
    });
    emit({ type: 'run', level: 'info', outcome: 'started', message: '开始一轮自动签到' });

    const totals = emptyRunTotals();
    let providers;
    try {
      providers = credits.providersWithAccounts();
    } catch (e) {
      const message = `读取账号池失败，本次跳过：${e?.message || String(e)}`;
      warn(`自动签到：${message}`);
      emit({ type: 'run', level: 'error', outcome: 'failed', message, markedToday: false, ms: now() - startedAt });
      return; // 不记日期，下次启动重试
    }
    totals.providers = providers.length;
    emit({
      type: 'run',
      level: 'info',
      message: `账号池共 ${providers.length} 个渠道${providers.length ? `：${providers.join('、')}` : '（无账号）'}`
    });
    const channels = [];

    for (const provider of providers) {
      const t0 = now();
      const row = { type: 'channel', provider, ms: 0 };
      const put = (extra) => emit({ ...row, ms: now() - t0, ...extra });
      // ⚠️ 排除表先于任何上游请求：zcode 的代价发生在调用期间（captcha），事后判已太晚
      if (isAutoCheckinExcluded(provider)) {
        totals.skipped += 1;
        channels.push({ provider, text: '需手动签到' });
        put({ level: 'info', outcome: 'excluded', message: '在自动签到排除表中，需手动领取' });
        continue;
      }
      let result;
      try {
        result = await credits.claim(provider);
      } catch (e) {
        totals.errors += 1;
        channels.push({ provider, text: '出错' });
        const message = `调用异常：${e?.message || String(e)}`;
        warn(`自动签到：${provider} 调用异常: ${e?.message || String(e)}`);
        put({ level: 'error', outcome: 'failed', message });
        continue;
      }
      if (!result?.ok) {
        const message =
          typeof result?.error === 'string'
            ? result.error
            : typeof result?.error?.message === 'string'
              ? result.error.message
              : '';
        if (isUnsupportedCheckin(message)) {
          totals.skipped += 1;
          channels.push({ provider, text: '无签到接口' });
          put({ level: 'info', outcome: 'skipped', message: `无签到接口：${message || '该渠道没有每日签到'}` });
        } else {
          totals.errors += 1;
          channels.push({ provider, text: '出错' });
          warn(`自动签到：${provider} 失败: ${message || '未知错误'}`);
          put({ level: 'error', outcome: 'failed', message: `签到失败：${message || '未知错误'}` });
        }
        continue;
      }
      const summary = result.value?.summary;
      if (summary === undefined) {
        channels.push({ provider, text: '无可领' });
        put({ level: 'warn', outcome: 'empty', message: '该渠道没有可领取的内容' });
        continue;
      }
      accumulateRunTotals(totals, summary);
      const text = describeChannel(summary);
      channels.push({ provider, text });
      const outcome = summary.claimed > 0 ? 'claimed' : summary.alreadyClaimed > 0 ? 'already-claimed' : 'empty';
      put({ level: outcome === 'claimed' ? 'ok' : 'info', outcome, message: text });
    }

    if (!shouldMarkToday(totals)) {
      // ⚠️ 刻意不写 lastDate：凭据没续上 / 断网 / 抢在 Qoder 刷新前，
      //    下次启动（或巡检退避后）还要重试，而不是当天就此放弃。
      const text = describeRun(totals);
      warn(`自动签到未记入今日（下次启动会重试）：${text}`);
      emit({
        type: 'run',
        level: 'warn',
        outcome: 'finished',
        markedToday: false,
        counts: counts(totals),
        ms: now() - startedAt,
        message: `${text}；未记入今日，稍后会重试`
      });
      return;
    }
    persist({
      ...doc,
      lastDate: today(),
      lastResult: describeRun(totals),
      lastAt: now(),
      channels,
      // 新一轮跑完清掉上一次「已关闭」标记，否则明天的新结果会被旧标记藏住
      dismissedRunAt: 0
    });
    warn(`自动签到完成（${today()}）：${doc.lastResult}`);
    emit({
      type: 'run',
      level: totals.errors > 0 || totals.failed > 0 ? 'warn' : 'ok',
      outcome: 'finished',
      markedToday: true,
      counts: counts(totals),
      ms: now() - startedAt,
      message: doc.lastResult
    });
  }

  function runIfDue(trigger = 'schedule') {
    if (inflight !== null) return inflight;
    if (!doc.enabled) return Promise.resolve();
    if (doc.lastDate !== '' && doc.lastDate === today()) return Promise.resolve();
    running = true;
    const task = performRun(trigger)
      .catch((e) => warn(`自动签到异常: ${e?.message || String(e)}`))
      .finally(() => {
        running = false;
        inflight = null;
      });
    inflight = task;
    return task;
  }

  return {
    state,
    async setEnabled(enabled) {
      persist({ ...doc, enabled: Boolean(enabled) });
      // 打开开关时立刻尝试一轮（今天已跑过由 runIfDue 内部拦住）。
      // ⚠️ 不 await：一轮要串行打十几个上游，让按钮等它会像卡死。
      if (enabled) void runIfDue('toggle');
      return state();
    },
    async dismiss() {
      // 记「关闭的是哪一轮」（当前 lastAt）：下一轮跑完 lastAt 变了，文字自动回来
      persist({ ...doc, dismissedRunAt: doc.lastAt });
      return state();
    },
    start() {
      if (pending !== null || tick !== null) return;
      const ms = delayMs ?? autoCheckinDelayMs(env);
      const fire = () => {
        pending = null;
        void runIfDue('startup');
      };
      // 延迟为 0 = 立刻跑（0 是 falsy，绝不能被 || 换成 30s）
      if (ms <= 0) fire();
      else pending = schedule(fire, ms);

      // 常驻进程跨天巡检：启动补跑只覆盖「当天第一次启动」，过零点必须还有触发点
      const interval = tickMs ?? (env ? autoCheckinTickMs(env) : AUTO_CHECKIN_TICK_MS);
      if (interval > 0) {
        tick = scheduleTick(() => {
          if (doc.lastDate !== '' && doc.lastDate === today()) return;
          const attemptedToday = lastAttemptAt > 0 && utc8DateString(lastAttemptAt) === today();
          if (attemptedToday && now() - lastAttemptAt < AUTO_CHECKIN_RETRY_MS) return;
          void runIfDue('tick');
        }, interval);
      }
    },
    runIfDue,
    stop() {
      pending?.cancel?.();
      pending = null;
      tick?.cancel?.();
      tick = null;
    }
  };
}
