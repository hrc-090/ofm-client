/**
 * 回退链 + 失败分类 + 冷却 + 缓存。
 *
 * 这四块才是「一堆不稳定的免费源」能变成可用功能的原因（dsh-free-search 的真正价值），
 * 引擎本身反而简单。口径尽量对齐上游项目，避免以后对照源码时两套语义：
 *
 *  quota       402 / 额度耗尽        → 冷却 45min
 *  auth        401 / 403 / key 无效   → 会话级（进程重启即恢复）
 *  bot-wall    captcha / 反爬        → 冷却 60s
 *  transient   429 / 5xx / 超时 / 断连 → 冷却 60s
 *  invalid-response 解析失败 / 0 结果 → 不冷却（是插件侧问题，不惩罚源）
 *  unknown     其余                  → 不冷却
 */
import { engineLabel } from './config.js';
import { shapeResults } from './sanitize.js';

const COOLDOWN_MS = {
  quota: 45 * 60 * 1000,
  auth: Number.POSITIVE_INFINITY,
  'bot-wall': 60 * 1000,
  transient: 60 * 1000,
  'invalid-response': 0,
  // 配置填错（指向本机自己）：跳过，但既不冷却也不惩罚这个源
  'self-loop': 0,
  unknown: 0
};

const CLASS_LABEL = {
  quota: '额度耗尽',
  auth: '鉴权失败',
  'bot-wall': '被反爬拦截',
  transient: '临时故障',
  'invalid-response': '无有效结果',
  'self-loop': '填成了本机地址（已跳过）',
  unknown: '未知错误'
};

export function classifyFailure(error) {
  const msg = String((error && (error.message || error.code)) || error || '');
  const status = Number(error && error.status) || 0;
  // 这条必须最先判：它的文案里带「地址」等词，落到后面的正则会被误分类
  if (error && error.code === 'SELF_LOOP') return 'self-loop';
  if (status === 402 || /402|NO_MORE_CREDITS|quota|insufficient credit|payment required/i.test(msg)) return 'quota';
  if (status === 401 || status === 403 || /401|403|unauthor|forbidden|invalid api key|not configured/i.test(msg)) return 'auth';
  if (/captcha|unusual traffic|robot check|anti-bot|验证码|被反爬/i.test(msg)) return 'bot-wall';
  if (status === 429 || /429|5\d\d|timeout|timed out|aborted|ECONN|ENOTFOUND|EAI_AGAIN|socket|fetch failed|network/i.test(msg)) {
    return 'transient';
  }
  if (/0 results|0 usable|empty|not json|非 JSON|parse|malformed|解析/i.test(msg)) return 'invalid-response';
  return 'unknown';
}

export function createRunner({ getConfig, engines, log = null, now = () => Date.now(), isAvailable = null }) {
  const cooldowns = new Map(); // engineId -> { until, cls }
  const cache = new Map(); // key -> { value, exp }
  const CACHE_MAX = 50;

  function cacheKey(query, count, cfg) {
    return `${query}\u0000${count}\u0000${cfg.engineOrder.join(',')}\u0000${cfg.disabledEngines.join(',')}`;
  }

  function readCache(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.exp <= now()) {
      cache.delete(key);
      return null;
    }
    // LRU：命中后挪到末尾
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }

  function writeCache(key, value, ttlMin, fellBack) {
    if (!ttlMin || ttlMin <= 0) return;
    // 回退命中的条目 TTL 只有 1/5：它本身是「次优源」的结果，别缓存太久
    const ttl = fellBack ? Math.max(1, ttlMin / 5) : ttlMin;
    cache.set(key, { value, exp: now() + ttl * 60000 });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function cooldownOf(id) {
    const cd = cooldowns.get(id);
    if (!cd) return null;
    if (cd.until <= now()) {
      cooldowns.delete(id);
      return null;
    }
    return cd;
  }

  function applyCooldown(id, cls) {
    const ms = COOLDOWN_MS[cls] || 0;
    if (!ms) {
      cooldowns.delete(id);
      return;
    }
    cooldowns.set(id, { until: now() + ms, cls });
  }

  /**
   * @returns {Promise<{provider:string, results:Array, note:string, cached:boolean, ms:number}>}
   */
  async function search({ query, count, timeRange = '' } = {}) {
    const cfg = getConfig();
    if (!cfg.enabled) {
      const e = new Error('网页搜索未开启：在 App 的「网页搜索与读取」里打开');
      e.status = 503;
      e.code = 'SEARCH_DISABLED';
      throw e;
    }
    const q = String(query || '').trim();
    if (!q) {
      const e = new Error('缺少 query');
      e.status = 400;
      e.code = 'INVALID_REQUEST';
      throw e;
    }
    const n = Math.max(1, Math.min(cfg.maxResults, Number(count) || cfg.maxResults));
    const key = cacheKey(q, n, cfg);
    const cached = readCache(key);
    if (cached) {
      log?.record({ kind: 'search', ok: true, query: q, provider: cached.provider, ms: 0, count: cached.results.length, cached: true, note: '缓存命中' });
      return { ...cached, cached: true, ms: 0 };
    }

    const deadline = now() + cfg.budgetMs;
    // isAvailable 让「配置层面就不该参与」的引擎直接不进链：
    // 比如自定义接口填成了本机自己 —— 进链只会每次搜索都留一句失败说明。
    const chain = cfg.engineOrder.filter(
      (id) => !cfg.disabledEngines.includes(id) && engines[id] && (!isAvailable || isAvailable(id, cfg))
    );
    const failures = [];
    let lastError = null;
    const t0 = now();

    for (let i = 0; i < chain.length; i += 1) {
      const id = chain[i];
      const remain = deadline - now();
      if (remain < 800) {
        failures.push('总预算用尽');
        break;
      }

      const cd = cooldownOf(id);
      if (cd) {
        failures.push(`${engineLabel(id)} 冷却中`);
        continue;
      }

      try {
        const r = await engines[id]({
          query: q,
          count: n,
          timeRange,
          config: cfg,
          // 单个源最多 20s，且不能超过总预算
          timeoutMs: Math.max(1000, Math.min(20000, remain))
        });
        const sources = Array.isArray(r && r.sources) ? r.sources : [];
        if (!sources.length) {
          const e = new Error('returned 0 results');
          e.code = 'EMPTY';
          throw e;
        }
        const results = shapeResults(sources, n);
        if (!results.length) {
          const e = new Error('returned 0 usable results');
          e.code = 'EMPTY';
          throw e;
        }
        cooldowns.delete(id);
        const fellBack = failures.length > 0;
        const note = fellBack ? `Note: ${failures.join('、')}，已改用 ${engineLabel(id)}。` : '';
        const value = { provider: id, results, note };
        writeCache(key, value, cfg.cacheTtlMin, fellBack);
        const ms = now() - t0;
        log?.record({ kind: 'search', ok: true, query: q, provider: id, ms, count: results.length, note, cached: false });
        return { ...value, cached: false, ms };
      } catch (e) {
        lastError = e;
        const cls = classifyFailure(e);
        applyCooldown(id, cls);
        failures.push(`${engineLabel(id)} ${CLASS_LABEL[cls] || cls}`);
        const ms = now() - t0;
        log?.record({
          kind: 'search',
          ok: false,
          query: q,
          provider: id,
          ms,
          count: 0,
          failure: `${cls}: ${String(e.message || e).slice(0, 120)}`
        });
      }
    }

    const err = new Error(
      `所有搜索源都不可用（${failures.join('；') || '没有可用引擎'}）` +
        (lastError ? `：${String(lastError.message || lastError).slice(0, 120)}` : '')
    );
    err.status = 502;
    err.code = 'SEARCH_ALL_FAILED';
    throw err;
  }

  /** 自检 / 调试用：把链路和冷却状态摊开 */
  function state() {
    const cfg = getConfig();
    return {
      enabled: cfg.enabled,
      chain: cfg.engineOrder.map((id) => ({
        id,
        label: engineLabel(id),
        disabled: cfg.disabledEngines.includes(id),
        cooling: Boolean(cooldownOf(id)),
        until: cooldownOf(id)?.until || 0
      })),
      cacheSize: cache.size,
      budgetMs: cfg.budgetMs
    };
  }

  function resetRuntime() {
    cooldowns.clear();
    cache.clear();
  }

  return { search, state, resetRuntime };
}
