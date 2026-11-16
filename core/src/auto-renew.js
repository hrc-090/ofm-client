/**
 * 渠道凭据后台自动续期 —— 对照上游 channel pack 的续期纪律与本地
 * auto-checkin.js 的调度纪律。
 *
 * 为什么需要它：本地原本只有「请求前按需续期」(credential.js, 60s 余量) 与
 * 「401 强制续期」(dispatch.js)。App 长时间不用时，access_token 与
 * refresh_token 会一起过期（Trae 实测 336h，Qoder/Cline 只有 1h），回来就
 * 只剩「需重新登录」。上游作为常驻插件用 `refreshLocked` 在后台保持凭据活性，
 * 这里补上同一层，但**不做任何绕过风控的动作**：刷新失败就如实标 needsLogin。
 *
 * 调度纪律（逐条对齐 auto-checkin.js）：
 *  - `enabled !== false` 判定（旧文档 / 脏数据按打开）；
 *  - 独立状态文件 `auto-renew.json`，读盘失败回落默认值，写盘 tmp + rename 原子替换；
 *  - 启动延迟默认 8s，**0 合法**（绝不写 Number(env) || 默认值）；
 *  - 周期巡检 + 失败退避下限，退避按账号记，不拖累其它账号；
 *  - `inflight` 在飞去重（手动触发与定时可能同时想跑）；
 *  - unref 定时器，不阻止进程退出；
 *  - 日志/状态只含账号 id、渠道、结果与有效期，**绝不含凭据值**。
 *
 * 续期判定纪律（对齐上游 trae.ts / trae-adapter.ts）：
 *  - 过期时间用 credential-expiry.js 统一解析（秒/毫秒/ISO/JWT exp 兜底）；
 *  - 无法解析过期时间 → 不打扰（永久 token 或未知格式）；
 *  - 只续「距过期 < aheadMs」的账号；aheadMs 必须 >= tickMs，
 *    才能保证过期前至少被扫到一次；
 *  - 跳过停用账号、已标 needsLogin 的账号、免登录与无刷新端点渠道；
 *  - force 刷新走 credential.js 的单账号锁（对应 Go 端 refreshLocked），
 *    并发请求与定时巡检不会重复打上游、不会轮换竞争；
 *  - 传输失败沿用旧凭据（不标终态）+ 短退避；AUTH 失败才标 needsLogin。
 */
import fs from 'node:fs';
import path from 'node:path';
import { credentialExpiresAtMs, describeExpiry } from './credential-expiry.js';
import { Codes } from './errors.js';

export const AUTO_RENEW_FILE = 'auto-renew.json';
const SCHEMA = 'ofm/auto-renew/v1';
const MAX_CHANNEL_ENTRIES = 64;

/** 启动延迟：早于自动签到的 30s，让凭据先续上，签到再用新凭据。 */
export const AUTO_RENEW_DELAY_MS = 8_000;
/** 巡检间隔 30 分钟。扫描本身只读本地分片，命中窗口才发上游请求。 */
export const AUTO_RENEW_TICK_MS = 30 * 60 * 1000;
/** 提前窗口 45 分钟（> 巡检间隔）：保证任何账号过期前至少被扫到一次。 */
export const AUTO_RENEW_AHEAD_MS = 45 * 60 * 1000;
/** 单账号失败退避下限 5 分钟，拦住巡检被调小后高频打上游。 */
export const AUTO_RENEW_RETRY_MS = 5 * 60 * 1000;

export const AUTO_RENEW_DELAY_ENV = 'OFM_AUTO_RENEW_DELAY_MS';
export const AUTO_RENEW_TICK_ENV = 'OFM_AUTO_RENEW_TICK_MS';
export const AUTO_RENEW_AHEAD_ENV = 'OFM_AUTO_RENEW_AHEAD_MS';

export const DEFAULT_AUTO_RENEW = {
  enabled: true,
  lastAt: 0,
  lastResult: '',
  channels: [],
  accounts: {}
};

function envMs(env, key, fallback) {
  const raw = env?.[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function autoRenewDelayMs(env = process.env) {
  return envMs(env, AUTO_RENEW_DELAY_ENV, AUTO_RENEW_DELAY_MS);
}
export function autoRenewTickMs(env = process.env) {
  return envMs(env, AUTO_RENEW_TICK_ENV, AUTO_RENEW_TICK_MS);
}
export function autoRenewAheadMs(env = process.env) {
  return envMs(env, AUTO_RENEW_AHEAD_ENV, AUTO_RENEW_AHEAD_MS);
}

/** 归一化磁盘脏数据：非法值一律回落，不抛错（后台任务不能因脏文件崩）。 */
export function sanitizeAutoRenew(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_AUTO_RENEW, accounts: {} };
  const ms = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const channels = Array.isArray(raw.channels)
    ? raw.channels
        .filter((e) => e && typeof e === 'object' && typeof e.provider === 'string' && typeof e.text === 'string')
        .slice(0, MAX_CHANNEL_ENTRIES)
        .map((e) => ({ provider: e.provider.slice(0, 40), text: e.text.slice(0, 160), outcome: String(e.outcome || '') }))
    : [];
  const accounts = {};
  if (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
    for (const [id, v] of Object.entries(raw.accounts)) {
      if (!v || typeof v !== 'object') continue;
      accounts[String(id).slice(0, 120)] = {
        lastAt: ms(v.lastAt),
        lastOkAt: ms(v.lastOkAt),
        lastFailAt: ms(v.lastFailAt),
        outcome: typeof v.outcome === 'string' ? v.outcome.slice(0, 40) : ''
      };
    }
  }
  return {
    enabled: raw.enabled !== false,
    lastAt: ms(raw.lastAt),
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult.slice(0, 300) : '',
    channels,
    accounts
  };
}

/** 独立状态文件：读失败回落，写 tmp + rename 原子替换。 */
export function createAutoRenewStore(dataDir, log = console) {
  const file = path.join(dataDir, AUTO_RENEW_FILE);
  return {
    load() {
      try {
        return sanitizeAutoRenew(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        return { ...DEFAULT_AUTO_RENEW, accounts: {} };
      }
    },
    save(doc) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, ...doc }, null, 2), { mode: 0o600 });
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

/** 账号尾号：状态里不暴露昵称/手机号，只给一个稳定短标识。 */
function accountTag(account) {
  const raw = String(account.id || account.credentialRef || '');
  return raw.length <= 6 ? raw : `…${raw.slice(-4)}`;
}

const TOKEN_KEYS = ['access_token', 'token', 'zcode_jwt', 'security_oauth_token', 'xhx_token'];

/**
 * 是否真的续上了：比较凭据**内容**，不比较对象引用。
 *
 * 不能用 `next === cred`：部分渠道的 credential() 会包装返回值（例如 TRAE 用
 * repairTraeCredential 补 machine_id/device_id，返回新对象），即使只是传输失败
 * 沿用旧凭据，引用也不相等 → 会被误判成「续期成功」，掩盖真实故障。
 * 判据只看实质进展：访问令牌换了，或过期时间往后推了。补齐设备字段不算。
 */
function renewSucceeded(before, after) {
  if (!after || typeof after !== 'object') return false;
  for (const k of TOKEN_KEYS) {
    const a = before?.[k];
    const b = after[k];
    if (typeof a === 'string' && typeof b === 'string' && a !== b) return true;
  }
  const bExp = credentialExpiresAtMs(before);
  const aExp = credentialExpiresAtMs(after);
  if (bExp !== undefined && aExp !== undefined && aExp > bExp + 1000) return true;
  return false;
}

/**
 * @param {object} deps
 *  store        Store 实例（读账号/凭据）
 *  registry     createRegistry 实例（判断渠道可续性）
 *  stateStore   createAutoRenewStore 实例（可注入 mock）
 *  now          时钟注入
 *  env          环境变量（读 delay/tick/ahead）
 *  delayMs/tickMs/aheadMs/retryMs  直接覆盖（测试用）
 *  schedule/scheduleTick/warn/record  定时器与日志注入
 */
export function createAutoRenew(deps) {
  const {
    store,
    registry,
    stateStore,
    now = () => Date.now(),
    env = process.env,
    delayMs,
    tickMs,
    aheadMs,
    retryMs = AUTO_RENEW_RETRY_MS,
    schedule = defaultSchedule,
    scheduleTick = defaultScheduleTick,
    warn = () => {},
    record = () => {}
  } = deps;

  let doc = stateStore.load();
  let running = false;
  let inflight = null;
  let pending = null;
  let tick = null;
  let lastAttemptAt = doc.lastAt;

  const delay = () => delayMs ?? autoRenewDelayMs(env);
  const interval = () => tickMs ?? autoRenewTickMs(env);
  const ahead = () => aheadMs ?? autoRenewAheadMs(env);

  function state() {
    return {
      enabled: doc.enabled,
      running,
      lastAt: doc.lastAt,
      lastResult: doc.lastResult,
      // 下一次周期巡检的预估时刻；未启动/无巡检时用 0 表示未知
      nextAt: tick !== null && lastAttemptAt > 0 ? lastAttemptAt + interval() : 0,
      aheadMs: ahead(),
      tickMs: interval(),
      channels: doc.channels.map((e) => ({ ...e })),
      accounts: Object.fromEntries(Object.entries(doc.accounts).map(([k, v]) => [k, { ...v }]))
    };
  }

  function persist(next) {
    doc = next;
    try {
      stateStore.save(doc);
    } catch (e) {
      warn(`自动续期状态写入失败（本轮结果可能丢失）: ${e?.message || String(e)}`);
    }
  }

  function emit(extra) {
    try {
      record({ source: 'auto-renew', ...extra });
    } catch {
      /* 日志是旁路，绝不影响续期主流程 */
    }
  }

  /** 判断某账号本轮是否该尝试续期；返回 { skip, reason } 或 { skip:false, cred, expMs }。 */
  function classify(account) {
    if (account?.enabled === false) return { skip: true, reason: '已停用' };
    if (account?.needsLogin === true) return { skip: true, reason: '需重新登录' };
    if (!account?.credentialRef) return { skip: true, reason: '无凭据' };

    let channel;
    try {
      channel = registry.get(account.provider);
    } catch {
      return { skip: true, reason: '未知渠道' };
    }
    if (channel.renewable === false || channel.requiresAccount === false) {
      return { skip: true, reason: '无需续期' };
    }

    // 失败退避：只对「非终态」失败生效，AUTH 已标 needsLogin 会被上面拦住
    const rec = doc.accounts[account.id];
    if (rec?.lastFailAt > 0 && now() - rec.lastFailAt < retryMs) {
      return { skip: true, reason: '失败退避中' };
    }

    let cred;
    try {
      cred = store.readCredential(account.credentialRef);
    } catch {
      return { skip: true, reason: '凭据读取失败' };
    }
    if (!cred || typeof cred !== 'object') return { skip: true, reason: '凭据缺失' };

    const expMs = credentialExpiresAtMs(cred);
    if (expMs === undefined) return { skip: true, reason: '无过期时间' };
    if (expMs - now() >= ahead()) return { skip: true, reason: `未到窗口（${describeExpiry(cred, now())}）` };
    return { skip: false, channel, cred, expMs };
  }

  async function performRun(trigger = 'schedule') {
    lastAttemptAt = now();
    const startedAt = now();
    emit({ type: 'run', level: 'info', outcome: 'started', trigger, message: '开始一轮自动续期' });

    const accounts = Array.isArray(store?.settings?.accounts) ? store.settings.accounts : [];
    const channels = [];
    const nextAccounts = { ...doc.accounts };
    let ok = 0;
    let unchanged = 0;
    let authFailed = 0;
    let errored = 0;
    let skipped = 0;

    for (const account of accounts) {
      const tag = accountTag(account);
      const t0 = now();
      const put = (outcome, text, level = 'info') => {
        channels.push({ provider: account.provider, text: `[${tag}] ${text}`, outcome });
        emit({ type: 'account', accountId: account.id, provider: account.provider, outcome, message: text, level, ms: now() - t0 });
      };

      const c = classify(account);
      if (c.skip) {
        skipped += 1;
        put('skipped', c.reason);
        continue;
      }

      try {
        // force 刷新走 credential.js 的单账号锁；同一账号并发只发一次上游请求
        const next = await c.channel.credential(store, account, { force: true });
        const rec = { ...(nextAccounts[account.id] || {}), lastAt: now() };
        if (!renewSucceeded(c.cred, next)) {
          // 凭据内容没推进：可能是 ensureCredential 对 TRANSPORT/TIMEOUT 沿用旧凭据，
          // 也可能是渠道只补了设备字段。不标 needsLogin、不判终态，只做短退避。
          unchanged += 1;
          rec.outcome = 'unchanged';
          rec.lastFailAt = now();
          put('unchanged', `沿用旧凭据（网络未通或暂不可续），${describeExpiry(c.cred, now())}`, 'warn');
        } else {
          ok += 1;
          rec.outcome = 'ok';
          rec.lastOkAt = now();
          rec.lastFailAt = 0;
          const newExp = credentialExpiresAtMs(next);
          put('ok', `已续期，${newExp === undefined ? '有效期未知' : describeExpiry(next, now())}`, 'ok');
        }
        nextAccounts[account.id] = rec;
      } catch (e) {
        const code = e?.code;
        const rec = { ...(nextAccounts[account.id] || {}), lastAt: now(), lastFailAt: now() };
        if (code === Codes.AUTH) {
          authFailed += 1;
          rec.outcome = 'auth-failed';
          put('auth-failed', '凭据已失效，需重新登录', 'error');
        } else {
          errored += 1;
          rec.outcome = 'error';
          put('error', `续期失败：${String(e?.message || e).slice(0, 90)}`, 'error');
        }
        nextAccounts[account.id] = rec;
      }
    }

    const parts = [];
    if (ok) parts.push(`续期 ${ok}`);
    if (unchanged) parts.push(`待重试 ${unchanged}`);
    if (authFailed) parts.push(`需重登 ${authFailed}`);
    if (errored) parts.push(`失败 ${errored}`);
    if (skipped) parts.push(`跳过 ${skipped}`);
    const result = parts.length ? parts.join(' / ') : '本轮无账号';

    persist({
      ...doc,
      lastAt: now(),
      lastResult: result,
      channels,
      accounts: nextAccounts
    });
    warn(`自动续期完成：${result}`);
    emit({
      type: 'run',
      level: authFailed > 0 || errored > 0 ? 'warn' : 'ok',
      outcome: 'finished',
      trigger,
      counts: { ok, unchanged, authFailed, errored, skipped },
      ms: now() - startedAt,
      message: result
    });
    return { ok, unchanged, authFailed, errored, skipped, result };
  }

  function runIfDue(trigger = 'schedule') {
    if (inflight !== null) return inflight;
    if (!doc.enabled) return Promise.resolve(null);
    running = true;
    const task = performRun(trigger)
      .catch((e) => {
        warn(`自动续期异常: ${e?.message || String(e)}`);
        return null;
      })
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
      // 打开时立刻尝试一轮；不 await，一轮可能串行打多个上游
      if (enabled) void runIfDue('toggle');
      return state();
    },
    runIfDue,
    start() {
      if (pending !== null || tick !== null) return;
      const ms = delay();
      const fire = () => {
        pending = null;
        void runIfDue('startup');
      };
      // 0 合法 = 立刻跑（0 是 falsy，绝不能被 || 换成默认延迟）
      if (ms <= 0) fire();
      else pending = schedule(fire, ms);

      const every = interval();
      if (every > 0) {
        tick = scheduleTick(() => void runIfDue('tick'), every);
      }
    },
    stop() {
      pending?.cancel?.();
      pending = null;
      tick?.cancel?.();
      tick = null;
    }
  };
}
