/**
 * 搜索服务门面：配置读写、Key 存取、引擎装配、读取链。
 *
 * 对外的两件事：
 *  - `search({query,count})`：回退链搜索，返回真正生效的源与结果；
 *  - `read({url})`：自定义读取 → 本地静态抓取 → keenable 兜底。
 */
import { normalizeWebSearch, maskKey, engineLabel } from './config.js';
import { createRunner } from './runner.js';
import { createSearchLog } from './log.js';
import { searchBing } from './engines/bing.js';
import { searchMcp, fetchViaMcp } from './engines/mcp-keyless.js';
import { searchAnySearch } from './engines/anysearch.js';
import { customSearch, customRead } from './engines/custom.js';
import { readLocal } from './read.js';
import { assertSafeUrl, assertResolvedSafe } from './ssrf.js';
import { wrapUntrusted } from './sanitize.js';
import { isSelfEndpoint, SelfLoopError, lanAddresses } from './self-ref.js';

const KEY_REF = 'web-search';

export function createSearchService({
  store,
  log = console,
  now = () => Date.now(),
  // 测试注入：允许读本机 mock server。生产默认 false，硬拦私网。
  allowPrivate = false,
  selfPort = 18900
}) {
  // 真实监听端口可能在 listen 时才确定（18900 被占用会降到随机端口），
  // 先给初值，main.js 起服务后回填 —— 否则自环判定会用错端口。
  let selfPortNow = Number(selfPort) || 18900;
  const searchLog = createSearchLog({ now });

  const getConfig = () => normalizeWebSearch(store.settings.webSearch);
  const readKeys = () => {
    const v = store.readCredential(KEY_REF);
    return { search: String(v?.search || ''), read: String(v?.read || '') };
  };

  async function runCustomSearch({ query, count, config, timeoutMs }) {
    const cfg = config.search;
    if (!cfg.url) throw new Error('未配置自定义搜索');
    // 指向本机自己 → 直接跳过：不拦会变成「服务调用自己」的嵌套请求
    if (isSelfEndpoint(cfg.url, { selfPort: selfPortNow })) throw new SelfLoopError(cfg.url, selfPortNow);
    const keys = readKeys();
    return customSearch(cfg, { query, count, apiKey: keys.search, timeoutMs });
  }

  const engines = {
    custom: runCustomSearch,
    bing: ({ query, count, timeoutMs }) => searchBing({ query, count, timeoutMs }),
    keenable: ({ query, count, timeoutMs }) => searchMcp('keenable', { query, count, timeoutMs }),
    exa: ({ query, count, timeoutMs }) => searchMcp('exa', { query, count, timeoutMs }),
    parallel: ({ query, count, timeoutMs }) => searchMcp('parallel', { query, count, timeoutMs }),
    anysearch: ({ query, count, timeoutMs }) => searchAnySearch({ query, count, timeoutMs })
  };

  const runner = createRunner({
    getConfig,
    engines,
    log: searchLog,
    now,
    // 自定义接口没填、或填成了本机自己 → 不进回退链（不是失败，是不该参与）
    isAvailable: (id, cfg) => (id === 'custom' ? Boolean(cfg.search.url) && !isSelfEndpoint(cfg.search.url, { selfPort: selfPortNow }) : true)
  });

  async function search(input = {}) {
    return runner.search(input);
  }

  /**
   * 读取一条网页。链：自定义读取 → 本地静态抓取 → keenable 兜底。
   * @returns {Promise<{url:string, final_url:string, title:string, text:string, truncated:boolean, provider:string}>}
   */
  async function read({ url, maxChars } = {}) {
    const config = getConfig();
    if (!config.enabled) {
      const e = new Error('网页搜索未开启：在 App 的「网页搜索与读取」里打开');
      e.status = 503;
      e.code = 'SEARCH_DISABLED';
      throw e;
    }
    const target = String(url || '').trim();
    if (!target) {
      const e = new Error('缺少 url');
      e.status = 400;
      e.code = 'INVALID_REQUEST';
      throw e;
    }

    assertSafeUrl(target, { allowPrivate, selfPort: selfPortNow });
    if (!allowPrivate) await assertResolvedSafe(target);

    const limit = Math.max(1000, Math.min(100000, Number(maxChars) || config.readMaxChars));
    const tries = [];
    let lastError = null;

    const custom = config.read;
    if (custom.url && isSelfEndpoint(custom.url, { selfPort: selfPortNow })) {
      // 同搜索侧：自己读自己没意义，跳过不记录失败（否则试读报告里全是噪音）
      tries.push('自定义读取指向本机自己（已跳过）');
    } else if (custom.url) {
      const t0 = Date.now();
      try {
        const keys = readKeys();
        const r = await customRead(custom, { url: target, maxChars: limit, apiKey: keys.read, timeoutMs: 15000 });
        searchLog.record({ kind: 'read', ok: true, query: target, provider: 'custom', ms: Date.now() - t0, count: r.text.length });
        return { url: target, final_url: r.final_url || target, title: r.title || '', text: r.text, truncated: r.truncated, provider: 'custom' };
      } catch (e) {
        lastError = e;
        tries.push(`自定义读取失败（${String(e.message || e).slice(0, 60)}）`);
      }
    }

    const tLocal = Date.now();
    try {
      const r = await readLocal(target, { maxChars: limit, timeoutMs: 12000 });
      searchLog.record({ kind: 'read', ok: true, query: target, provider: 'local', ms: Date.now() - tLocal, count: r.text.length });
      return { url: target, final_url: r.final_url, title: r.title, text: r.text, truncated: r.truncated, provider: 'local' };
    } catch (e) {
      lastError = e;
      tries.push(`本地抓取失败（${String(e.message || e).slice(0, 60)}）`);
    }

    if (config.engineOrder.includes('keenable') && !config.disabledEngines.includes('keenable')) {
      const tMcp = Date.now();
      try {
        const r = await fetchViaMcp(target, { timeoutMs: 25000 });
        if (r.text && r.text.length > 200) {
          searchLog.record({ kind: 'read', ok: true, query: target, provider: 'keenable', ms: Date.now() - tMcp, count: r.text.length });
          return {
            url: target,
            final_url: r.url || target,
            title: r.title || '',
            text: r.text.slice(0, limit),
            truncated: r.text.length > limit,
            provider: 'keenable'
          };
        }
        tries.push('keenable 正文过短');
      } catch (e) {
        lastError = e;
        tries.push(`keenable 兜底失败（${String(e.message || e).slice(0, 60)}）`);
      }
    }

    const err = new Error(`读取失败：${tries.join('；')}`);
    err.status = 502;
    err.code = 'READ_FAILED';
    err.cause = lastError;
    searchLog.record({ kind: 'read', ok: false, query: target, provider: '', count: 0, failure: tries.join('；').slice(0, 160) });
    throw err;
  }

  /** 给 MCP 用：正文包一层不可信边界 */
  function readForModel(input) {
    return read(input).then((r) => ({ ...r, text: wrapUntrusted(r.text) }));
  }

  function publicConfig() {
    const cfg = getConfig();
    const keys = readKeys();
    const port = selfPortNow;
    return {
      ...cfg,
      keys: { search: maskKey(keys.search), read: maskKey(keys.read) },
      hasKeys: { search: Boolean(keys.search), read: Boolean(keys.read) },
      engineLabels: Object.fromEntries(cfg.engineOrder.map((id) => [id, engineLabel(id)])),
      // 第三方该填哪个地址：同机用 local，另一台设备用 lan
      endpoints: {
        local: `http://127.0.0.1:${port}`,
        lan: lanAddresses().map((ip) => `http://${ip}:${port}`),
        search: `http://127.0.0.1:${port}/v1/search`,
        read: `http://127.0.0.1:${port}/v1/read`,
        mcp: `http://127.0.0.1:${port}/mcp`,
        // 第三方多半要填 API Key，直接给出本机当前值，省得用户去别处找
        apiKey: String(store.settings?.forward?.key || '')
      },
      // 配了却会被跳过的东西，摊开给界面提示
      warnings: [
        ...(isSelfEndpoint(cfg.search.url, { selfPort: selfPortNow }) ? ['自定义搜索指向了本机自己，已忽略'] : []),
        ...(isSelfEndpoint(cfg.read.url, { selfPort: selfPortNow }) ? ['自定义读取指向了本机自己，已忽略'] : [])
      ],
      runtime: runner.state(),
      log: searchLog.summary()
    };
  }

  function saveConfig(patch) {
    const current = getConfig();
    const merged = { ...current, ...(patch || {}) };
    if (patch && patch.search) merged.search = { ...current.search, ...patch.search };
    if (patch && patch.read) merged.read = { ...current.read, ...patch.read };
    const next = normalizeWebSearch(merged);
    store.update((s) => {
      s.webSearch = next;
    });
    return publicConfig();
  }

  function setKeys(input = {}) {
    const current = readKeys();
    const next = {
      search: typeof input.search === 'string' ? input.search.trim() : current.search,
      read: typeof input.read === 'string' ? input.read.trim() : current.read
    };
    store.writeCredential(KEY_REF, next);
    return publicConfig();
  }

  return {
    search,
    read,
    setSelfPort: (p) => {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0) selfPortNow = n;
    },
    readForModel,
    getConfig,
    publicConfig,
    saveConfig,
    setKeys,
    log: searchLog,
    state: () => runner.state(),
    resetRuntime: () => runner.resetRuntime()
  };
}
