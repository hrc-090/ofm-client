/**
 * 本机 API 服务（对照上游 src/forward.js 的契约）。
 *
 * 两条通道：
 *  - `/v1/*`  + `/health`：给 DSH / ChatBox / OpenAI SDK / Claude Code 用，靠 API Key 鉴权；
 *  - `/api/*`：给 App 自己的界面用，靠进程内随机 uiToken 鉴权（防止同机其它 App 读走 Key）。
 *
 * 只监听回环地址。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store, keyMatches, generateApiKey, defaultApiKey } from './store.js';
import { createRegistry, splitModelId } from './registry.js';
import { decorateDisplayName, resolveModelId } from './model-label.js';
import { createModelService, chatStream } from './dispatch.js';
import { normalizeChatBody } from './convert/openai-chat.js';
import { anthropicToInternal, AnthropicStreamWriter, toAnthropicMessage, countAnthropicTokens } from './convert/anthropic.js';
import { responsesToInternal, ResponsesStreamWriter, toResponsesObject } from './convert/responses.js';
import { aggregateDeltas } from './openai-compat.js';
import { OfmError, Codes, openAiErrorBody, normalizeError } from './errors.js';
import { createLoginManager } from './login-manager.js';
import {
  setBrowserTarget,
  resolveCallbackTarget,
  normalizeCallbackUrl,
  getCallbackServerState
} from './browser-callback.js';
import { estimateTokens, contentToText } from './canonical.js';
import { withTimeout } from './util.js';
import { createCreditsService } from './credits/index.js';
import { createAutoCheckin, createAutoCheckinStore } from './credits/auto-checkin.js';
import { listCapabilities } from './credits/capability.js';
import { runNetworkDiagnose } from './net-diagnose.js';
import { describeCa } from './ca-bundle.js';
import { describeAccounts } from './account-diagnose.js';
import { repairStoredCredentials } from './credential-repair.js';
import { createUsageStore, markUsageFailed } from './usage-store.js';
import { publicUsage, readCacheTokens, sanitizeUsage } from './usage-cache.js';
import { createCheckinLog } from './checkin-log.js';
import { createSearchService } from './search/index.js';
import { createMcpServer } from './mcp/server.js';
import { takeModelEffort } from './effort.js';
import { deferStreamResponse } from './deferred-response.js';
import { createToolWire } from './tool-wire.js';
import { compressOutbound, injectPrompts } from './token-saver/index.js';
import { raccoonLoginPage } from './channels/raccoon/login-page.js';
import { RACCOON_LOGIN_TARGET } from './channels/raccoon/index.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15000;
/** 入口猜测模型名的最长等待：目录刷新不该让对话请求排队 */
const MODEL_RESOLVE_TIMEOUT_MS = 3000;
const VERSION = '0.2.0';

const CORS = {
  'access-control-allow-origin': '*',
  // 第三方 SDK 会带 x-stainless-* / x-ofm-* 等自定义头，列白名单容易漏，直接放开
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'x-request-id',
  'access-control-max-age': '600'
};

export function createApp({
  dataDir,
  log = console,
  uiToken = crypto.randomBytes(24).toString('base64url'),
  registry = createRegistry(), // 可注入：验收测试用 mock 渠道，不联网
  networkDiagnose = runNetworkDiagnose, // 可注入：自检验收不碰真实网络
  accountDiagnose = null, // 可注入；默认读本机账号/凭据（脱敏，不发网络请求）
  // 验收脚本要把 mock 服务放在 127.0.0.1，得放开内网读取；生产默认 false
  allowPrivateSearch = false
}) {
  const store = new Store(dataDir);
  // 存量凭据自愈：旧版登录链路把 TRAE 的 machine_id / device_id 写丢了，
  // 网络再好也会「模型远端拉取失败」+ 账号体检 incomplete。启动时补一次并写回，
  // 用户不必重新登录。幂等、纯本地、不发网络请求、不含任何凭据值。
  const startupRepair = repairStoredCredentials(store, { log });
  // 用量记录：只存统计（token / 耗时 / 状态），不存任何请求或响应正文。
  const usageStore = createUsageStore({ dir: path.join(dataDir, 'usage'), log });
  usageStore.prune(); // 启动清一次超过保留期的分片
  // 签到日志：与用量分片分开存。真机上「今天为什么没领到」靠它逐层还原，
  // 里面只有渠道/账号尾号/结果/脱敏错误文案，绝不写凭据。
  const checkinLog = createCheckinLog({ dir: path.join(dataDir, 'checkin-log'), log });
  checkinLog.prune();
  // 网页搜索与读取：/v1/search、/v1/read、/mcp 三个出口共用一套回退链。
  // 默认关闭，开关在 App 的「网页搜索与读取」页；关闭时端点回 503。
  const search = createSearchService({
    store,
    log,
    selfPort: Number(store.settings.forward.port) || 18900,
    allowPrivate: allowPrivateSearch
  });
  const mcp = createMcpServer({ searchService: search, version: VERSION });
  const modelService = createModelService({ registry, store, log });
  const logins = createLoginManager({
    store,
    registry,
    settings: store.settings,
    log,
    // 登录成功后立刻失效缓存并异步预热：不用手动刷新，App 与第三方
    // 下一次 /v1/models 就能拿到这个渠道的模型（以前要等 5 分钟 TTL 过期）。
    onAccountReady: () => {
      modelService.invalidate();
      Promise.resolve().then(() => modelService.listAll({ force: true })).catch(() => {});
    }
  });

  /** 把各渠道的目录状态翻译成一句人能看懂的提示（不含任何凭据）。 */
  function modelsHint(list, diagnostics) {
    if (list.length > 0) {
      const fb = diagnostics.filter((d) => d.source === 'fallback');
      if (fb.length === 0) return '';
      // ⚠️ 以前这里只说「远端拉取失败」，把真实原因吞了，真机上根本没法排查。
      // 现在把脱敏后的 warning 一并带回，并指向「网络自检」。
      const detail = fb
        .map((d) => `${d.provider}${d.warning ? `（${d.warning}）` : ''}`)
        .join('、');
      return `以下渠道显示的是兜底目录（远端拉取失败）：${detail}；点「网络自检」查原因，恢复后点「重新拉取」`.slice(0, 300);
    }
    const failed = diagnostics.filter((d) => d.warning);
    if (failed.length > 0) {
      return `模型目录拉取失败：${failed.map((d) => `${d.provider} ${d.warning}`).join('；').slice(0, 240)}`;
    }
    return '没有已登录账号；在 App 里连接渠道后会自动刷新，第三方用固定 Key 访问 /v1/models';
  }

  /**
   * 客户端有时把「显示名」当 model 回传（`[TRAE] Seed-Code`、URL 编码过的装饰 id、
   * 甚至只给模型名），下游 `splitModelId` 就会 400，表现出来就是聊到一半断掉。
   * 这里先做零网络代价的清洗；只有确实不含 `provider/model` 结构时才查一次目录
   * （5 分钟缓存），且**仅唯一命中才替换**——歧义宁可原样放行让下游报清晰的错，
   * 也不猜一个可能错的渠道。
   */
  async function normalizeModelInput(raw) {
    if (typeof raw !== 'string') return raw;
    const s = resolveModelId(raw);
    if (!s || s.includes('/')) return s;

    const pick = (list) => {
      const hit = list.filter((m) => m.model === s || resolveModelId(m.display_name || '') === s);
      // 同名模型出现在多个渠道时故意不猜：猜错渠道会把请求送到错误上游，
      // 比一个清晰的 400 更难查。
      return hit.length === 1 ? hit[0].id : s;
    };

    // ① 先查本地目录快照（零网络、瞬时）。绝大多数情况这里就命中。
    const quick = pick(modelService.peek());
    if (quick !== s) return quick;

    // ② 冷启动才去拉目录，但**必须带超时**：listAll 串行遍历所有渠道，
    //    任一家上游卡住就会把这次对话拖到客户端超时（表现为「流着流着断了」）。
    //    超时就放弃猜测、原样返回，让下游报清晰的 400，而不是让连接干等。
    try {
      const list = await withTimeout(modelService.listAll(), MODEL_RESOLVE_TIMEOUT_MS, '解析模型名');
      return pick(list);
    } catch {
      return s;
    }
  }

  /** 改 Key 后同步 runtime.json，App 的 monitor 会据此刷新界面显示的 Key */
  function syncRuntimeKey(key) {
    try {
      const p = path.join(dataDir, 'runtime.json');
      if (!fs.existsSync(p)) return;
      const r = JSON.parse(fs.readFileSync(p, 'utf8'));
      r.key = key;
      fs.writeFileSync(p, JSON.stringify(r, null, 2), { mode: 0o600 });
    } catch {
      /* 非致命：下次启动会写到正确值 */
    }
  }
  const credits = createCreditsService({ store, registry, log });
  const autoCheckin = createAutoCheckin({
    credits,
    store: createAutoCheckinStore(dataDir, log),
    // 自动签到的每一轮都进签到日志；日志写失败不影响签到
    record: (e) => checkinLog.record(e),
    warn: (m) => log?.warn?.(`[auto-checkin] ${m}`)
  });
  /**
   * 对话链路自检：用一条最小真实对话把「选号 → 上游 HTTP → 响应形状 →
   * SSE 帧数 → 解析出的正文」逐层打亮。第三方反馈「接入 API 无回复」时，
   * 靠这份报告就能判断是网络/账号/上游状态/帧格式里的哪一层，不用猜。
   * 注意：会真的向上游发一条消息，消耗一次额度（界面上有提示）。
   */
  async function runChatDiagnose(input = {}) {
    const t0 = Date.now();
    const trace = {
      provider: null, modelId: null, channel: null,
      accountCount: 0, accountId: null, url: null,
      httpStatus: null, contentType: null, shape: null,
      frames: 0, validFrames: 0, contentDeltas: 0, text: '', sample: '',
      wantText: true // 自检要展示正文样本；普通请求不开，避免累积全文
    };
    const report = {
      ok: false,
      summary: '',
      model: null,
      note: '本次自检会向上游发送一条 hi 测试消息（消耗一次真实额度）',
      error: null,
      firstDeltaMs: null,
      totalMs: 0,
      trace: null
    };

    let model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
    if (!model) {
      let list = [];
      try { list = await modelService.listAll({ force: false }); } catch { /* 目录失败也能继续诊断 */ }
      model = list.find((m) => !m.fallback)?.id || list[0]?.id || null;
    }
    report.model = model;
    if (!model) {
      report.error = { code: 'NO_MODEL', message: '模型目录为空：先在 App 里连接渠道，再点「重新拉取」' };
      report.summary = `对话无回复：${report.error.message}`;
      report.totalMs = Date.now() - t0;
      report.trace = publicTrace(trace);
      return report;
    }

    const internal = {
      model,
      messages: [{ role: 'user', content: String(input.prompt || defaultProbePrompt(input)).slice(0, 200) }],
      stream: false,
      // 工具探针：只有显式要才发 tools。不支持工具的上游会忽略它、正常回文本，
      // 不会让自检变红；支持的话报告里能看到「上游回了 tool_calls」。
      tools: input.probeTools ? [PROBE_TOOL] : undefined,
      toolChoice: input.probeTools ? 'auto' : undefined,
      // 自检不发 max_tokens：留空 = 用模型默认上限（32000）。发一个小值会把
      // 思考型模型的预算全耗在 reasoning 上，最后没有正文，反而误判成链路故障。
      maxTokens: undefined, temperature: undefined, topP: undefined, stop: undefined,
      reasoningEffort: undefined, user: undefined, parallelToolCalls: undefined
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 75000);
    let firstDeltaMs = null;
    let sawContent = 0;
    let sawTool = 0;
    try {
      for await (const d of chatStream({ registry, store, settings: store.settings, req: internal, signal: ctrl.signal, trace })) {
        if (d.type === 'credential') continue;
        if (d.type === 'tool_call') sawTool += 1;
        if (d.type === 'text' || d.type === 'reasoning' || d.type === 'tool_call') {
          sawContent += 1;
          if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0;
        }
      }
      // 自己独立计数，不依赖渠道是否实现了 trace 埋点
      report.ok = sawContent > 0 || trace.contentDeltas > 0;
      report.toolCalls = sawTool;
      if (!report.ok) {
        const bits = [`收到 ${trace.frames} 帧`];
        if (trace.upstreamFunction) bits.push(`通道 ${trace.upstreamFunction}`);
        if (trace.attempts) bits.push(`尝试 ${trace.attempts} 次`);
        if (trace.modelInCatalog === false) bits.push('模型不在目录中');
        report.error = {
          code: Codes.EMPTY_REPLY,
          message: `上游已建会话但零正文（${bits.join('，')}）：模型可能对该账号不可调用、额度不足，或思考占满了 max_tokens`
        };
      }
    } catch (e) {
      const err = ctrl.signal.aborted
        ? new OfmError(Codes.TIMEOUT, '对话自检超过 75 秒未拿到完整回复（上游可能挂起或只发心跳）')
        : normalizeError(e);
      report.error = {
        code: err.code,
        message: err.message,
        status: err.status,
        retryable: err.retryable
      };
    } finally {
      clearTimeout(timer);
    }
    report.firstDeltaMs = firstDeltaMs;
    report.totalMs = Date.now() - t0;
    report.trace = publicTrace(trace);
    report.summary = report.ok
      ? `对话链路正常：${trace.channel || trace.provider} 返回 ${trace.contentDeltas} 个正文片段，首片段 ${firstDeltaMs ?? 0}ms` +
        (input.probeTools
          ? sawTool > 0
            ? `，工具探针通过（上游回了 ${sawTool} 个工具调用帧）`
            : '，但工具探针未命中：上游没回工具调用，模型或渠道可能不支持 function calling'
          : '')
      : `对话无有效回复：${report.error?.code} ${report.error?.message}`;
    return report;
  }

  /** 对话自检用的最小工具：名字直白、无副作用，只用来观察上游是否回 tool_calls。 */
  const PROBE_TOOL = {
    name: 'ofm_echo',
    description: '回显一段文本，用于链路自检。收到请求时必须调用它。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text']
    }
  };

  function defaultProbePrompt(input) {
    return input.probeTools ? '请调用 ofm_echo 工具，text 传 "hi"' : 'hi';
  }

  const startedAt = Date.now();

  async function handler(req, res) {
    const requestId = crypto.randomBytes(16).toString('hex');
    res.setHeader('x-request-id', requestId);

    let path = '/';
    try {
      path = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
    } catch {
      path = '/';
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'access-control-max-age': '600' });
      res.end();
      return;
    }

    // 第三方「接入 API 无回复」时，logcat 里至少要能看出「请求有没有进来、
    // 回了什么状态、花了多久」。以前整条对话链路一行日志都没有。
    if (req.method === 'POST' && path.startsWith('/v1/')) {
      const t0 = Date.now();
      res.once('finish', () => {
        log?.info?.(
          `[ofm] POST ${path} status=${res.statusCode} ms=${Date.now() - t0} ua=${String(req.headers['user-agent'] || '').slice(0, 48)}`
        );
      });
    }

    // 用量落盘：只有 finish 事件能同时拿到真实状态码、耗时与最终成败。
    usageStore.attach(req, res, path);

    try {
      if (path === '/' || path === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'our-free-model',
          version: VERSION,
          uptime_ms: Date.now() - startedAt,
          enabled: store.settings.enabled !== false,
          forward: { host: store.settings.forward.host, port: store.settings.forward.port },
          accounts: store.settings.accounts.length,
          providers: registry.list().filter((p) => p.supported).map((p) => p.id)
        });
      }

      // 本机登录入口（Raccoon）：必须放在 API Key 校验之前 —— WebView 直接打开它，
      // 手上没有 Key；页面本身只是过渡 + 跳官网，不含任何机密。
      if (req.method === 'GET' && (path === '/raccoon/login' || path === '/login/raccoon')) {
        const html = raccoonLoginPage({ target: RACCOON_LOGIN_TARGET });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          'cache-control': 'no-store',
          // 允许页内跳转，不允许被别的站点套壳
          'x-content-type-options': 'nosniff'
        });
        res.end(html);
        return;
      }

      if (path.startsWith('/api/')) return await handleApi(req, res, path);

      if (!checkApiKey(req)) {
        return sendJson(res, 401, {
          error: { message: 'missing or invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' }
        });
      }

      if (store.settings.enabled === false) {
        throw new OfmError(Codes.UNSUPPORTED, '本机 API 已在 App 内关闭', { status: 503 });
      }

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        const list = await modelService.listAll({ force: req.url.includes('refresh=1') });
        const diagnostics = modelService.diagnostics();
        // ⚠️ `id` 永远是真实的 `${provider}/${model}`，**不做任何装饰**。
        //    它同时是路由键，一旦拼上 `[渠道] :: ` 之类的前缀：
        //      - 客户端会把它原样显示成第二行，用户看到的就是一条脏串；
        //      - 请求带回来还得反解，多一层随时可能失配的转换。
        //    渠道名只进 `display_name`（第一行），?channel=0 可整行去掉。
        //    请求入口仍保留对旧装饰 id 的反解，兼容客户端缓存的旧列表。
        const q = new URL(req.url, 'http://x').searchParams;
        const withChannel = q.get('channel') !== '0';
        const data = list.map((m) => ({
          ...m,
          id: m.id,
          display_name: withChannel
            ? decorateDisplayName(m.display_name, m.provider_name)
            : m.display_name,
          real_id: m.id
        }));
        return sendJson(res, 200, {
          object: 'list',
          data,
          // 附加字段；标准 OpenAI 客户端忽略，App 与排障用
          ...(list.length ? {} : { hint: modelsHint(list, diagnostics) }),
          diagnostics
        });
      }

      // 搜索 / 读取的 GET 形态：给只会拼 URL 的客户端（部分自定义搜索框只填地址）
      if (req.method === 'GET' && (path === '/v1/search' || path === '/search')) {
        const q = new URL(req.url, 'http://x').searchParams;
        return await handleSearch(res, {
          query: q.get('q') || q.get('query'),
          count: q.get('count'),
          time_range: q.get('time_range')
        });
      }
      if (req.method === 'GET' && (path === '/v1/read' || path === '/read')) {
        const q = new URL(req.url, 'http://x').searchParams;
        return await handleRead(res, { url: q.get('url'), max_chars: q.get('max_chars') });
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        if (path === '/v1/chat/completions' || path === '/chat/completions') {
          return await handleChatCompletions(req, res, body);
        }
        if (path === '/v1/responses' || path === '/responses') {
          return await handleResponses(req, res, body);
        }
        if (path === '/v1/messages') {
          return await handleAnthropic(req, res, body);
        }
        if (path === '/v1/messages/count_tokens') {
          return sendJson(res, 200, { input_tokens: countAnthropicTokens(body) });
        }
        // ── 网页搜索 / 读取 / MCP（M33）──
        if (path === '/v1/search' || path === '/search') {
          return await handleSearch(res, body);
        }
        if (path === '/v1/read' || path === '/read') {
          return await handleRead(res, body);
        }
        if (path === '/mcp') {
          return await handleMcp(req, res, body);
        }
      }

      return sendJson(res, 404, { error: { message: `未知路径 ${path}`, type: 'invalid_request_error' } });
    } catch (e) {
      const err = normalizeError(e);
      // 非流式失败：sendJson 会带上真实状态码，但 rec.code 只有 HTTP_xxx，
      // 补上 EMPTY_REPLY / TIMEOUT 这类语义码，看板才能按原因分组。
      if (res.ofmUsage && res.ofmUsage.ok !== false) {
        res.ofmUsage.code = err.code || res.ofmUsage.code;
      }
      if (res.headersSent) {
        // 走到这里说明是内部没兜住的异常且响应头已发（200），显式钉失败。
        markUsageFailed(res.ofmUsage, err, { truncated: true });
        try {
          res.end();
        } catch {
          /* noop */
        }
        return;
      }
      const status = err.status || 500;
      sendJson(res, status, openAiErrorBody(err), {
        ...(err.retryAfterMs ? { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } : {})
      });
    }
  }

  function checkApiKey(req) {
    const expected = store.settings.forward.key;
    const header = String(req.headers.authorization || '');
    let presented = '';
    if (header.toLowerCase().startsWith('bearer ')) presented = header.slice(7).trim();
    else if (typeof req.headers['x-api-key'] === 'string') presented = req.headers['x-api-key'].trim();
    else if (typeof req.headers['x-goog-api-key'] === 'string') presented = req.headers['x-goog-api-key'].trim();
    else {
      try {
        presented = new URL(req.url, 'http://127.0.0.1').searchParams.get('key') || '';
      } catch {
        presented = '';
      }
    }
    return keyMatches(expected, presented);
  }

  function checkUi(req) {
    const provided = String(req.headers['x-ofm-ui-token'] || '');
    if (provided && keyMatches(uiToken, provided)) return true;
    return checkApiKey(req); // App 也可以用 API Key 调管理接口
  }

  const CLAIM_OUTCOME = {
    claimed: 'claimed',
    'already-claimed': 'already-claimed',
    inactive: 'inactive',
    failed: 'failed',
    skipped: 'skipped'
  };
  const CLAIM_LABEL = {
    claimed: '领取成功',
    'already-claimed': '今天已领',
    inactive: '签到活动未开启',
    failed: '失败',
    skipped: '跳过'
  };

  /**
   * 手动签到 / 状态 / 余额的日志包装。
   * claim 记全（逐账号 + 本轮汇总，用户点一次才有一条，不会刷屏）；
   * status / balances 成功不记（页面会反复拉），只把「查不到 / 报错」留下 ——
   * 这正是真机上排查「余额查询失败」时唯一能拿到的线索。
   */
  async function tracedCheckin(kind, provider, fn) {
    const t0 = Date.now();
    const base = {
      runId: `manual-${t0.toString(36)}-${kind}`,
      source: 'manual',
      trigger: 'app',
      provider: provider || ''
    };
    const emit = (extra) => checkinLog.record({ ...base, ...extra });
    let result;
    try {
      result = await fn();
    } catch (e) {
      emit({
        type: 'run', level: 'error', outcome: 'failed',
        message: `接口异常：${e?.message || String(e)}`, ms: Date.now() - t0
      });
      throw e;
    }
    const ms = Date.now() - t0;
    if (result?.ok === false) {
      const errText = typeof result.error === 'string'
        ? result.error
        : typeof result.error?.message === 'string' ? result.error.message : '调用失败';
      emit({ type: 'run', level: 'error', outcome: 'failed', message: errText, ms });
      return result;
    }
    const value = result?.value || {};
    if (kind === 'claim') {
      for (const row of Array.isArray(value.results) ? value.results : []) {
        const o = row?.outcome || {};
        const k = typeof o.kind === 'string' ? o.kind : 'failed';
        const outcome = CLAIM_OUTCOME[k] || 'empty';
        const gain = k === 'claimed' && o.credit > 0
          ? `+${o.credit}${o.unit === 'token' ? 'Token' : '积分'}`
          : '';
        emit({
          type: 'account',
          level: outcome === 'claimed' ? 'ok' : outcome === 'failed' || outcome === 'empty' ? 'error' : 'warn',
          outcome,
          account: row?.accountId,
          message: [CLAIM_LABEL[k] || k, o.message, gain].filter(Boolean).join(' · '),
          ms
        });
      }
      const s = value.summary || {};
      const parts = [];
      if (s.claimed) parts.push(`${s.claimed} 个领取成功`);
      if (s.alreadyClaimed) parts.push(`${s.alreadyClaimed} 个今天已领`);
      if (s.failed) parts.push(`${s.failed} 个失败`);
      if (s.inactive) parts.push(`${s.inactive} 个未开启`);
      emit({
        type: 'run',
        level: s.failed > 0 ? 'warn' : 'ok',
        outcome: 'finished',
        counts: {
          claimed: s.claimed || 0,
          alreadyClaimed: s.alreadyClaimed || 0,
          failed: s.failed || 0,
          inactive: s.inactive || 0,
          skipped: 0
        },
        ms,
        message: parts.length ? parts.join('，') : '没有需要领取的账号'
      });
      return result;
    }
    if (kind === 'balances' && Array.isArray(value.accounts)) {
      for (const row of value.accounts) {
        if (row?.balance != null) continue;
        emit({
          type: 'query',
          level: 'error',
          outcome: 'failed',
          account: row?.accountId,
          message: `余额查询失败：${row?.error || '未返回余额'}`,
          ms
        });
      }
    }
    return result;
  }

  async function handleApi(req, res, path) {
    if (!checkUi(req)) {
      return sendJson(res, 401, { error: { message: 'missing or invalid ui token', type: 'invalid_request_error' } });
    }

    if (req.method === 'GET' && path === '/api/status') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        enabled: store.settings.enabled !== false,
        forward: store.settings.forward,
        uiToken,
        accounts: store.settings.accounts.map(publicAccount),
        providers: registry.list(),
        creditCapabilities: listCapabilities(),
        qoderMachineConfigured: Boolean(
          store.settings.credits?.qoderMachine?.token && store.settings.credits?.qoderMachine?.type
        ),
        callback: getCallbackServerState(),
        network: { ca: describeCa() },
        // 按模型保存的默认思考档位：客户端不传 reasoning_effort 时才生效
        modelEffort: store.settings.modelEffort || {},
        // 省 Token 设置（App 设置页据此渲染开关）
        tokenSaver: store.settings.tokenSaver,
        effortBudget: store.settings.effortBudget === true,
        uptime_ms: Date.now() - startedAt
      });
    }

    if (req.method === 'GET' && path === '/api/providers') {
      return sendJson(res, 200, { data: registry.list() });
    }

    if (req.method === 'GET' && path === '/api/accounts') {
      return sendJson(res, 200, { data: store.settings.accounts.map(publicAccount) });
    }

    if (req.method === 'POST' && path === '/api/accounts') {
      const body = await readJson(req);
      const result = await logins.start(body.provider);
      // 渠道可以返回相对登录入口（Raccoon 的 /raccoon/login 由本机服务自己出），
      // 这里补成完整地址再交给 App —— App 只认 http(s)。
      if (result && typeof result.loginUrl === 'string' && result.loginUrl.startsWith('/')) {
        const host = req.headers.host || '127.0.0.1';
        result.loginUrl = `http://${host}${result.loginUrl}`;
      }
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && path === '/api/login/poll') {
      const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('accountId');
      const r = await logins.poll(id);
      return sendJson(res, 200, { ...r, account: r.account ? publicAccount(r.account) : undefined });
    }

    // 用系统默认浏览器登录前，先登记本次会话；18080 端口收到回调时据此找 accountId
    if (req.method === 'POST' && path === '/api/login/browser-target') {
      const body = await readJson(req);
      setBrowserTarget(body.accountId || null);
      return sendJson(res, 200, { ok: true });
    }

    // 粘贴回调链接完成登录：不依赖 18080 端口。
    // 适用：授权在电脑浏览器完成、App 切后台被回收、端口被占用/监听失败。
    // 业务失败统一用 HTTP 200 + {ok:false,error}，App 端好读；绝不打印 URL 内容。
    if (req.method === 'POST' && path === '/api/login/complete') {
      const body = await readJson(req);
      const url = normalizeCallbackUrl(body.url);
      if (!url) return sendJson(res, 200, { ok: false, error: '请先粘贴浏览器地址栏里的完整回调链接' });

      const id = resolveCallbackTarget(logins, body.accountId || null);
      if (!id) {
        return sendJson(res, 200, {
          ok: false,
          error: '没有待完成的登录会话（App 可能重启过）。请回到渠道重新点「连接」，再粘贴链接。'
        });
      }
      try {
        const r = await logins.completeCallback(id, url);
        // 成功清掉 browser target，避免后续误匹配
        setBrowserTarget(null);
        return sendJson(res, 200, { ok: true, success: true, account: publicAccount(r.account), accountId: id });
      } catch (e) {
        const msg = e?.message || String(e);
        log?.warn?.(`[ofm] 粘贴回调未完成：${msg}`);
        return sendJson(res, 200, { ok: false, error: msg, accountId: id });
      }
    }

    if (req.method === 'POST' && path === '/api/login/sms/send') {
      const body = await readJson(req);
      return sendJson(res, 200, await logins.smsSend(body.accountId, body.phone));
    }

    if (req.method === 'POST' && path === '/api/login/sms/verify') {
      const body = await readJson(req);
      const r = await logins.smsVerify(body.accountId, body);
      return sendJson(res, 200, { ...r, account: publicAccount(r.account) });
    }

    // ── 签到 / 领取积分（说明书 §2）──
    // 沿用同一个回环服务 + checkUi 鉴权，不进任何局域网中继白名单。
    // 业务失败用 { ok:false, error } 表达（HTTP 200），自动签到据此判 skipped/出错。
    if (req.method === 'GET' && path === '/api/checkin/capabilities') {
      return sendJson(res, 200, { ok: true, value: { capabilities: listCapabilities() } });
    }

    if (req.method === 'POST' && path === '/api/checkin/status') {
      const body = await readJson(req);
      return sendJson(res, 200, await tracedCheckin('status', body.provider, () => credits.status(body.provider)));
    }

    if (req.method === 'POST' && path === '/api/checkin/claim') {
      const body = await readJson(req);
      return sendJson(res, 200, await tracedCheckin('claim', body.provider, () => credits.claim(body.provider)));
    }

    if (req.method === 'POST' && path === '/api/checkin/balances') {
      const body = await readJson(req);
      return sendJson(res, 200, await tracedCheckin('balances', body.provider, () => credits.balances(body.provider, { force: body.force === true })));
    }

    if (req.method === 'POST' && path === '/api/checkin/auto') {
      const body = await readJson(req);
      let s;
      if (typeof body.enabled === 'boolean') s = await autoCheckin.setEnabled(body.enabled);
      else if (body.dismiss === true) s = await autoCheckin.dismiss();
      else s = autoCheckin.state(); // 三个字段都省略 = 只读
      return sendJson(res, 200, { ok: true, value: { autoCheckin: s } });
    }

    // ── 签到日志（排查用）──
    // format=text 给「复制日志」按钮用：纯文本、倒序、已脱敏，粘给开发者即可。
    if (req.method === 'GET' && path === '/api/checkin/log') {
      const u = new URL(req.url, 'http://127.0.0.1');
      const limit = Number(u.searchParams.get('limit') || 100);
      if (u.searchParams.get('format') === 'text') {
        const bytes = Buffer.from(await checkinLog.text({ limit }), 'utf8');
        res.writeHead(200, {
          ...CORS,
          'content-type': 'text/plain; charset=utf-8',
          'content-length': bytes.length,
          'cache-control': 'no-store'
        });
        res.end(bytes);
        return;
      }
      return sendJson(res, 200, {
        ok: true,
        value: {
          entries: await checkinLog.recent({ limit }),
          summary: await checkinLog.summary({ days: 1 })
        }
      });
    }

    if (req.method === 'DELETE' && path === '/api/checkin/log') {
      return sendJson(res, 200, { ok: true, removed: checkinLog.clear() });
    }

    // 出站网络自检：真机上「模型远端拉取失败」与「余额查询失败」常常同源，
    // 分步测 DNS / TCP / TLS / HTTPS，把每层错误码带回界面（全程不带凭据）。
    // 同时附带账号/凭据体检：网络全通过却仍失败时，另一个变量就是「有没有可用账号」。
    if (req.method === 'GET' && path === '/api/network/diagnose') {
      const u = new URL(req.url, 'http://127.0.0.1');
      const hosts = u.searchParams.getAll('host');
      const result = await networkDiagnose({ hosts });
      // 点自检时也补一次：覆盖「启动后刚登录」或旧版残留的账号，
      // 让报告里的账号状态直接反映修复后的结果（幂等，无变更不写盘）。
      const repairNow = repairStoredCredentials(store, { log });
      // 合并启动时那次的结果：否则用户重启后再点自检，repaired 会是 0，
      // 报告里就看不到「已帮你补齐、不用重登」这行提示了。
      const merge = (a, b) => [...new Set([...(a || []), ...(b || [])])];
      const repairedAccounts = merge(startupRepair.accounts, repairNow.accounts);
      const repair = {
        scanned: repairNow.scanned,
        // 用去重后的账号数，重复点自检不会把同一个账号反复计数
        repaired: repairedAccounts.length,
        repairedNow: repairNow.repaired,
        added: merge(startupRepair.added, repairNow.added),
        accounts: repairedAccounts,
        needsRelogin: merge(startupRepair.needsRelogin, repairNow.needsRelogin)
      };
      let accounts;
      try {
        accounts = accountDiagnose
          ? accountDiagnose()
          : describeAccounts({ store, nowMs: Date.now() });
      } catch (e) {
        accounts = { count: 0, usable: 0, accounts: [], hint: `账号体检失败：${String(e?.message || e).slice(0, 120)}` };
      }
      return sendJson(res, 200, { ...result, accounts, credentialRepair: repair });
    }

    // 对话链路自检：第三方「接入 API 无回复」时逐层定位。可选 body.model 指定模型。
    if (req.method === 'POST' && path === '/api/chat/diagnose') {
      const body = await readJson(req);
      if (body.model) body.model = await normalizeModelInput(body.model);
      return sendJson(res, 200, await runChatDiagnose(body));
    }

    // ── 用量看板 ──
    // 只读本机 JSONL，不改上游请求；聚合在 Node 侧做，App 只拿结果。
    if (req.method === 'GET' && path === '/api/usage/summary') {
      const days = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('days') || 7);
      return sendJson(res, 200, { ok: true, value: await usageStore.summary({ days }) });
    }

    if (req.method === 'GET' && path === '/api/usage/log') {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams;
      const limit = Number(q.get('limit') || 100);
      const days = Number(q.get('days') || 0);
      return sendJson(res, 200, { ok: true, value: { entries: await usageStore.recent({ limit, days }) } });
    }

    if (req.method === 'DELETE' && path === '/api/usage') {
      return sendJson(res, 200, { ok: true, removed: usageStore.clear() });
    }

    // ── 网页搜索与读取（M33）──
    // 配置与 Key 分开取：GET 只回尾号，POST 时才接受明文 Key。
    if (path === '/api/search/config') {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, value: search.publicConfig() });
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (body && body.keys) search.setKeys(body.keys);
        if (body && body.config) search.saveConfig(body.config);
        else if (body && !body.keys) search.saveConfig(body);
        return sendJson(res, 200, { ok: true, value: search.publicConfig() });
      }
    }

    // 「试搜」：跑一次真实查询，把生效源、耗时、回退说明一并带回界面
    if (req.method === 'POST' && path === '/api/search/test') {
      const body = await readJson(req);
      try {
        const r = await search.search({ query: body.query, count: body.count });
        return sendJson(res, 200, {
          ok: true,
          value: { provider: r.provider, note: r.note || '', cached: r.cached === true, ms: r.ms || 0, results: r.results }
        });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e), code: e.code || '' });
      }
    }

    // 「试读」：抓一个 URL，回字数、耗时与来源，方便判断是静态抓取还是兜底成功
    if (req.method === 'POST' && path === '/api/search/read') {
      const body = await readJson(req);
      try {
        const t0 = Date.now();
        const r = await search.read({ url: body.url, maxChars: body.max_chars });
        return sendJson(res, 200, {
          ok: true,
          value: {
            url: r.url,
            final_url: r.final_url,
            title: r.title,
            provider: r.provider,
            chars: r.text.length,
            truncated: r.truncated === true,
            ms: Date.now() - t0,
            sample: r.text.slice(0, 400)
          }
        });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e), code: e.code || '' });
      }
    }

    if (path === '/api/search/log') {
      if (req.method === 'GET') {
        const n = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('limit') || 50);
        return sendJson(res, 200, { ok: true, value: { entries: search.log.recent({ n }), summary: search.log.summary() } });
      }
      if (req.method === 'DELETE') {
        return sendJson(res, 200, { ok: true, removed: search.log.clear() });
      }
    }

    if (req.method === 'GET' && path === '/api/models') {
      const data = await modelService.listAll({ force: new URL(req.url, 'http://127.0.0.1').searchParams.get('refresh') === '1' });
      const diagnostics = modelService.diagnostics();
      const hint = modelsHint(data, diagnostics);
      return sendJson(res, 200, {
        object: 'list',
        data,
        diagnostics,
        ...(hint ? { hint } : {})
      });
    }

    if (req.method === 'POST' && path === '/api/models/disable') {
      const body = await readJson(req);
      store.update((s) => {
        s.disabledModels = s.disabledModels || {};
        s.disabledModels[body.provider] = s.disabledModels[body.provider] || {};
        if (body.disabled) s.disabledModels[body.provider][body.model] = true;
        else delete s.disabledModels[body.provider][body.model];
      });
      modelService.invalidate(body.provider);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/settings') {
      const body = await readJson(req);
      store.update((s) => {
        if (typeof body.enabled === 'boolean') s.enabled = body.enabled;
        if (typeof body.defaultMaxTokens === 'number') s.defaultMaxTokens = body.defaultMaxTokens;
        // 思考档位：{ "trae/X": "high" }；value 为 null / 空串表示清除该模型的默认档位
        if (body.modelEffort && typeof body.modelEffort === 'object' && !Array.isArray(body.modelEffort)) {
          s.modelEffort = { ...(s.modelEffort || {}) };
          for (const [key, value] of Object.entries(body.modelEffort)) {
            if (!key) continue;
            if (value === null || value === '') delete s.modelEffort[key];
            else if (typeof value === 'string') s.modelEffort[key] = value.slice(0, 32);
          }
        }
        // 省 Token：RTK 压缩与提示词瘦身开关（键白名单在 store 的 load 里再收一次）
        const ts = body.tokenSaver;
        if (ts && typeof ts === 'object' && !Array.isArray(ts)) {
          const prev = s.tokenSaver || {};
          s.tokenSaver = {
            rtk: typeof ts.rtk === 'boolean' ? ts.rtk : prev.rtk !== false,
            caveman: typeof ts.caveman === 'string' ? ts.caveman.slice(0, 24) : prev.caveman || 'off',
            ponytail: typeof ts.ponytail === 'string' ? ts.ponytail.slice(0, 24) : prev.ponytail || 'off'
          };
        }
        if (typeof body.effortBudget === 'boolean') s.effortBudget = body.effortBudget;
        // Qoder machine 头：Android 拿不到官方 UMID，允许用户在设置里手工粘贴。
        // 空串 = 清除（回到不带这两个头的保守降级）。
        const qm = body.credits?.qoderMachine;
        if (qm && typeof qm === 'object' && !Array.isArray(qm)) {
          s.credits = {
            ...(s.credits || {}),
            qoderMachine: {
              token: typeof qm.token === 'string' ? qm.token.trim() : '',
              type: typeof qm.type === 'string' ? qm.type.trim() : ''
            }
          };
        }
      });
      const qm = store.settings.credits?.qoderMachine;
      return sendJson(res, 200, {
        ok: true,
        enabled: store.settings.enabled,
        qoderMachineConfigured: Boolean(qm?.token && qm?.type),
        tokenSaver: store.settings.tokenSaver,
        effortBudget: store.settings.effortBudget === true
      });
    }

    // 设成用户自己想要的固定 Key（落盘，不再自动变化）
    if (req.method === 'POST' && path === '/api/settings/key') {
      const body = await readJson(req);
      // 留空 = 恢复固定默认值（清数据/重装后也是这个值，第三方不用改配置）
      const raw = String(body.key ?? '').trim();
      let key;
      try {
        key = store.setApiKey(raw || defaultApiKey());
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message });
      }
      syncRuntimeKey(key);
      return sendJson(res, 200, { ok: true, key });
    }

    if (req.method === 'POST' && path === '/api/settings/key/rotate') {
      const key = generateApiKey();
      store.update((s) => {
        s.forward.key = key;
      });
      syncRuntimeKey(key);
      return sendJson(res, 200, { key });
    }

    const m = /^\/api\/accounts\/([^/]+)(\/callback|\/refresh|\/cookie)?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = m[2];

      if (req.method === 'POST' && action === '/callback') {
        const body = await readJson(req);
        const r = await logins.completeCallback(id, body.url);
        return sendJson(res, 200, { ...r, account: publicAccount(r.account) });
      }

      if (req.method === 'POST' && action === '/cookie') {
        const body = await readJson(req);
        const r = await logins.cookie(id, body.cookie || body.token || '');
        return sendJson(res, 200, { ...r, account: publicAccount(r.account) });
      }

      if (req.method === 'POST' && action === '/refresh') {
        const account = store.findAccount(id);
        if (!account) throw new OfmError(Codes.INVALID_REQUEST, '账号不存在', { status: 404 });
        const channel = registry.get(account.provider);
        const cred = await channel.credential(store, account, { force: true });
        return sendJson(res, 200, { ok: true, expires_at: cred.expires_at || cred.expire_time });
      }

      if (req.method === 'PATCH' && !action) {
        const body = await readJson(req);
        store.update((s) => {
          const a = s.accounts.find((x) => x.id === id);
          if (!a) return;
          if (typeof body.enabled === 'boolean') a.enabled = body.enabled;
          if (typeof body.nickname === 'string' && body.nickname.trim()) a.nickname = body.nickname.trim();
        });
        return sendJson(res, 200, { ok: true, account: publicAccount(store.findAccount(id)) });
      }

      if (req.method === 'DELETE' && !action) {
        logins.cancel(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    return sendJson(res, 404, { error: { message: `未知管理接口 ${path}`, type: 'invalid_request_error' } });
  }

  /* ── 网页搜索 / 读取 / MCP（M33） ── */

  /** 搜索层的错误自带 status；这里转成 OfmError 才能保留状态码（normalizeError 会丢它） */
  function toSearchError(e) {
    if (e instanceof OfmError) return e;
    const status = Number(e && e.status) || 502;
    const code = status === 400 ? Codes.INVALID_REQUEST : status === 503 ? Codes.UNSUPPORTED : Codes.UPSTREAM;
    return new OfmError(code, String((e && e.message) || e), { status, detail: e && e.code });
  }

  /**
   * POST/GET /v1/search
   * 响应形状 = 主流「自定义搜索」的 results 数组 + 我们的元信息（provider/note/cached）。
   * note 必须透出去：用户得知道这次结果来自回退源，而不是首选源。
   */
  async function handleSearch(res, body = {}) {
    try {
      const r = await search.search({
        query: body.query,
        count: body.count,
        timeRange: body.time_range || body.timeRange || ''
      });
      return sendJson(res, 200, {
        object: 'search.results',
        provider: r.provider,
        note: r.note || '',
        cached: r.cached === true,
        ms: r.ms || 0,
        results: r.results
      });
    } catch (e) {
      throw toSearchError(e);
    }
  }

  /** POST/GET /v1/read：返回正文纯文本，长文按 readMaxChars 截断 */
  async function handleRead(res, body = {}) {
    try {
      const r = await search.read({ url: body.url, maxChars: body.max_chars || body.maxChars });
      return sendJson(res, 200, {
        object: 'web.page',
        url: r.url,
        final_url: r.final_url,
        title: r.title,
        text: r.text,
        truncated: r.truncated === true,
        provider: r.provider
      });
    } catch (e) {
      throw toSearchError(e);
    }
  }

  /**
   * POST /mcp：JSON-RPC 2.0 一问一答。
   * 客户端声明 Accept: text/event-stream 时回单帧 SSE —— 有些老 MCP 客户端只认这个。
   */
  async function handleMcp(req, res, body) {
    const payload = await mcp.handle(body);
    if (payload == null) {
      res.writeHead(202, { ...CORS, 'content-length': '0' });
      res.end();
      return;
    }
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/event-stream')) {
      const bytes = Buffer.from(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, 'utf8');
      res.writeHead(200, {
        ...CORS,
        'content-type': 'text/event-stream; charset=utf-8',
        'content-length': bytes.length,
        'cache-control': 'no-store'
      });
      res.end(bytes);
      return;
    }
    return sendJson(res, 200, payload);
  }

  async function handleChatCompletions(req, res, body) {
    // 第三方可能把档位写在模型名尾部：`provider/model(high)`。
    // 先剥下来（只认已知档位），再走模型名归一化，否则会被当成模型不存在。
    takeModelEffort(body);
    // 客户端可能把模型显示名/装饰 id 直接回传，先归一化再校验
    body.model = await normalizeModelInput(body.model);
    if (!body.model) throw new OfmError(Codes.INVALID_REQUEST, '缺少 model', { status: 400 });
    // 省 Token：先压工具输出（只改 tool 结果，fail-open），再注入提示词瘦身
    const saver = compressOutbound(body, 'chat', store.settings);
    const internal = { ...normalizeChatBody(body), model: body.model };
    injectPrompts(internal, store.settings);
    const ctx = makeCtx(req, res);
    const rec = res.ofmUsage || null;
    if (rec) {
      rec.model = body.model;
      rec.stream = internal.stream === true;
      if (saver.saved > 0) {
        rec.savedBytes = saver.saved;
        rec.savedHits = saver.hits.length;
      }
    }

    if (!internal.stream) {
      const agg = await collect(internal, ctx);
      applyUsageRecord(rec, ctx.trace, agg.usage);
      // 非流式同样要过 decoy 过滤：模型可能去调一个调用方从没声明过的
      // 指纹占位工具，原样返回就是「无法执行的 tool_calls」。
      const wire = createToolWire(internal.tools);
      agg.toolCalls = (agg.toolCalls || []).filter((tc) => wire.executable(tc.name));
      if (agg.toolCalls.length === 0 && agg.finishReason === 'tool_calls') agg.finishReason = 'stop';
      return sendJson(res, 200, openAiCompletion({ id: chatId(), model: body.model, ...agg }));
    }

    const id = chatId();
    const created = Math.floor(Date.now() / 1000);
    // 延迟提交响应头：首帧正文之前失败，仍能返回真实的 4xx/5xx，
    // 而不是 200 + 一条错误帧（第三方 SDK 的重试逻辑全依赖真实状态码）。
    const staged = deferStreamResponse(res, SSE_HEARTBEAT_MS);
    res = staged.response;
    startSse(res);
    const hb = startHeartbeat(res);
    let finishReason = 'stop';
    let usage = null;
    let sentRole = false;
    const toolWire = createToolWire(internal.tools);
    // 未提交时失败：不在本层写任何东西，交给外层按真实状态码回包
    let earlyError = null;

    const chunk = (delta, finish = null, extra = {}) =>
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra
      })}\n\n`;

    try {
      res.write(chunk({ role: 'assistant', content: '' }));
      sentRole = true;

      for await (const d of chatStream({ registry, store, settings: store.settings, req: internal, signal: ctx.signal, trace: ctx.trace })) {
        if (d.type === 'credential') continue;
        hb.kick();
        // 首个正文帧到达：这时才把响应头发出去，失败窗口到此结束
        if (d.type === 'text' || d.type === 'reasoning' || d.type === 'tool_call') staged.commit();
        // 首片段耗时：流式体验的核心指标，比总耗时更能反映「卡不卡」
        if (rec && d.type === 'reasoning') rec.reasonDeltas = (rec.reasonDeltas || 0) + 1;
        if (rec && (d.type === 'text' || d.type === 'reasoning' || d.type === 'tool_call')) {
          const t = Date.now();
          if (!rec.firstAt) rec.firstAt = t;
          // 每个正文帧都推进窗口末端；只有 >=2 帧才存在可测的生成时间窗，
          // 单大帧 / 纯思考静默的模型不会凭空造出一个速度。
          rec.lastAt = t;
        }
        if (d.type === 'text') res.write(chunk({ content: d.text }));
        else if (d.type === 'reasoning') res.write(chunk({ reasoning_content: d.text }));
        else if (d.type === 'tool_call') {
          // index 连续编号、decoy 抑制、name 未到的参数先挂起 —— 见 tool-wire.js
          const action = toolWire.admit(d);
          if (action.kind === 'open') {
            const call = {
              index: action.index,
              type: 'function',
              function: { name: action.name, arguments: action.args || '' }
            };
            if (action.id) call.id = action.id;
            res.write(chunk({ tool_calls: [call] }));
          } else if (action.kind === 'args') {
            // 只有参数增量的帧：按 OpenAI 增量形状发，不带空的 function.name
            res.write(chunk({ tool_calls: [{ index: action.index, function: { arguments: action.args } }] }));
          }
        } else if (d.type === 'usage') usage = d.usage;
        else if (d.type === 'finish') finishReason = d.reason;
      }

      res.write(chunk({}, toolWire.count > 0 && finishReason === 'stop' ? 'tool_calls' : finishReason, usage ? { usage: publicUsage(usage) } : {}));
      res.write('data: [DONE]\n\n');
      applyUsageRecord(rec, ctx.trace, usage);
    } catch (e) {
      // 失败也必须记一条：失败率与错误码是用量看板最有价值的部分
      applyUsageRecord(rec, ctx.trace, usage);
      const err = normalizeError(e);
      if (!staged.committed) {
        // 响应头还没发出去：这一轮可以像普通请求一样失败，外层直接回
        // err.status（401/429/502…）。绝不能在这里写 end()，那会提交 200。
        staged.dispose();
        earlyError = err;
        throw err;
      }
      // 流式的 200 响应头已经发出，这里必须显式钉住失败，否则成功率永远虚高。
      markUsageFailed(rec, err, { truncated: !!rec?.firstAt });
      // 严格按 choices[0].delta 解析的客户端会忽略裸 error 帧 —— 只发它
      // 就表现为「无回复」。先补一段看得见的 assistant 正文，再给结构化错误帧。
      try { res.write(chunk({ content: `[OFM 错误] ${err.message}` }, 'stop')); } catch { /* noop */ }
      res.write(`data: ${JSON.stringify(openAiErrorBody(err))}\n\n`);
      res.write('data: [DONE]\n\n');
    } finally {
      hb.stop();
      // throw 的路径不能 end()：end 会 commit 缓冲里的 200 头
      if (!earlyError) res.end();
    }
  }

  async function handleAnthropic(req, res, body) {
    takeModelEffort(body);
    body.model = await normalizeModelInput(body.model);
    if (!body.model) throw new OfmError(Codes.INVALID_REQUEST, '缺少 model', { status: 400 });
    const saver = compressOutbound(body, 'messages', store.settings);
    const internal = { ...anthropicToInternal(body), model: body.model };
    injectPrompts(internal, store.settings);
    const ctx = makeCtx(req, res);
    const rec = res.ofmUsage || null;
    if (rec) {
      rec.model = body.model;
      rec.stream = internal.stream === true;
      if (saver.saved > 0) {
        rec.savedBytes = saver.saved;
        rec.savedHits = saver.hits.length;
      }
    }
    // 客户端没要 thinking 就别下发 thinking 块（Anthropic 客户端对未请求的块很敏感）
    const wantThinking = body.thinking?.type === 'enabled';

    if (!internal.stream) {
      const agg = await collect(internal, ctx);
      applyUsageRecord(rec, ctx.trace, agg.usage);
      if (!wantThinking) agg.reasoning = '';
      return sendJson(res, 200, toAnthropicMessage({ id: `msg_${crypto.randomBytes(8).toString('hex')}`, model: body.model, ...agg }));
    }

    const staged = deferStreamResponse(res, SSE_HEARTBEAT_MS);
    res = staged.response;
    startSse(res);
    const hb = startHeartbeat(res);
    const estimated = internal.messages.reduce(
      (n, m) => n + 4 + estimateTokens(typeof m.content === 'string' ? m.content : contentToText(m.content)),
      0
    );
    const writer = new AnthropicStreamWriter({
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      model: body.model,
      usage: { prompt_tokens: estimated }
    });

    let usage = null;
    let finishReason = 'stop';
    let sawTool = false;
    let earlyError = null;
    try {
      res.write(writer.start());
      for await (const d of chatStream({ registry, store, settings: store.settings, req: internal, signal: ctx.signal, trace: ctx.trace })) {
        if (d.type === 'credential') continue;
        hb.kick();
        if (rec && d.type === 'reasoning') rec.reasonDeltas = (rec.reasonDeltas || 0) + 1;
        if (rec && (d.type === 'text' || d.type === 'reasoning' || d.type === 'tool_call')) {
          const t = Date.now();
          if (!rec.firstAt) rec.firstAt = t;
          // 每个正文帧都推进窗口末端；只有 >=2 帧才存在可测的生成时间窗，
          // 单大帧 / 纯思考静默的模型不会凭空造出一个速度。
          rec.lastAt = t;
        }
        if (d.type === 'usage') {
          usage = d.usage;
          continue;
        }
        if (d.type === 'finish') {
          finishReason = d.reason;
          continue;
        }
        if (d.type === 'tool_call') sawTool = true;
        if (d.type === 'reasoning' && !wantThinking) continue;
        // 首个真正下发的正文帧：提交响应头
        if (d.type === 'text' || d.type === 'reasoning' || d.type === 'tool_call') staged.commit();
        res.write(writer.delta(d));
      }
      // 上游 done 帧常把 tool_calls 也报成 stop；Claude Code 靠 stop_reason
      // 决定要不要继续跑工具，报错成 end_turn 就会直接停在工具调用前。
      res.write(writer.finish({
        finishReason: sawTool && finishReason === 'stop' ? 'tool_calls' : finishReason,
        usage
      }));
      applyUsageRecord(rec, ctx.trace, usage);
    } catch (e) {
      applyUsageRecord(rec, ctx.trace, usage);
      const err = normalizeError(e);
      if (!staged.committed) {
        staged.dispose();
        earlyError = err;
        throw err;
      }
      // 流式的 200 响应头已经发出，这里必须显式钉住失败，否则成功率永远虚高。
      // firstAt 有值 = 已经吐过正文，属于「半截流」，单独标记便于看板区分。
      markUsageFailed(rec, err, { truncated: !!rec?.firstAt });
      try { res.write(writer.delta({ type: 'text', text: `[OFM 错误] ${err.message}` })); } catch { /* noop */ }
      res.write(writer.error(err));
    } finally {
      hb.stop();
      if (!earlyError) res.end();
    }
  }

  async function handleResponses(req, res, body) {
    takeModelEffort(body);
    body.model = await normalizeModelInput(body.model);
    const saver = compressOutbound(body, 'responses', store.settings);
    const internal = { ...responsesToInternal(body), model: body.model };
    injectPrompts(internal, store.settings);
    const ctx = makeCtx(req, res);
    const rec = res.ofmUsage || null;
    if (rec) {
      rec.model = body.model;
      rec.stream = internal.stream === true;
      if (saver.saved > 0) {
        rec.savedBytes = saver.saved;
        rec.savedHits = saver.hits.length;
      }
    }

    if (!internal.stream) {
      const agg = await collect(internal, ctx);
      applyUsageRecord(rec, ctx.trace, agg.usage);
      return sendJson(res, 200, toResponsesObject({ id: `resp_${crypto.randomBytes(8).toString('hex')}`, model: body.model, ...agg }));
    }

    const staged = deferStreamResponse(res, SSE_HEARTBEAT_MS);
    res = staged.response;
    startSse(res);
    const hb = startHeartbeat(res);
    const writer = new ResponsesStreamWriter({ id: `resp_${crypto.randomBytes(8).toString('hex')}`, model: body.model });
    const respWire = createToolWire(internal.tools);
    let usage = null;
    let finishReason = 'stop';
    let sawTool = false;
    let earlyError = null;
    try {
      res.write(writer.start());
      for await (const d of chatStream({ registry, store, settings: store.settings, req: internal, signal: ctx.signal, trace: ctx.trace })) {
        if (d.type === 'credential') continue;
        hb.kick();
        if (rec && d.type === 'reasoning') rec.reasonDeltas = (rec.reasonDeltas || 0) + 1;
        if (rec && (d.type === 'text' || d.type === 'reasoning' || d.type === 'tool_call')) {
          const t = Date.now();
          if (!rec.firstAt) rec.firstAt = t;
          // 每个正文帧都推进窗口末端；只有 >=2 帧才存在可测的生成时间窗，
          // 单大帧 / 纯思考静默的模型不会凭空造出一个速度。
          rec.lastAt = t;
        }
        if (d.type === 'usage') {
          usage = d.usage;
          continue;
        }
        if (d.type === 'finish') {
          finishReason = d.reason;
          continue;
        }
        if (d.type === 'tool_call') {
          // Responses 每个工具调用是一条完整 item，没有 index 重排问题；
          // 这里只挡 decoy —— 未在调用方 tools 里声明的指纹占位工具。
          if (d.name && !respWire.executable(d.name)) continue;
          sawTool = true;
        }
        // 首个真正下发的正文帧：提交响应头
        if (d.type === 'text' || d.type === 'reasoning' || d.type === 'tool_call') staged.commit();
        res.write(writer.delta(d));
      }
      res.write(writer.finish({
        finishReason: sawTool && finishReason === 'stop' ? 'tool_calls' : finishReason,
        usage
      }));
      applyUsageRecord(rec, ctx.trace, usage);
    } catch (e) {
      applyUsageRecord(rec, ctx.trace, usage);
      const err = normalizeError(e);
      if (!staged.committed) {
        staged.dispose();
        earlyError = err;
        throw err;
      }
      // 流式的 200 响应头已经发出，这里必须显式钉住失败，否则成功率永远虚高。
      // firstAt 有值 = 已经吐过正文，属于「半截流」，单独标记便于看板区分。
      markUsageFailed(rec, err, { truncated: !!rec?.firstAt });
      try { res.write(writer.delta({ type: 'text', text: `[OFM 错误] ${err.message}` })); } catch { /* noop */ }
      res.write(writer.error(err));
    } finally {
      hb.stop();
      if (!earlyError) res.end();
    }
  }

  async function collect(internal, ctx) {
    const deltas = [];
    for await (const d of chatStream({ registry, store, settings: store.settings, req: internal, signal: ctx.signal, trace: ctx.trace })) {
      if (d.type !== 'credential') deltas.push(d);
    }
    return aggregateDeltas(deltas);
  }

  function makeCtx(req, res) {
    const controller = new AbortController();
    // ⚠️ 判据必须挂在 res 上，不能用 req.complete：
    //    POST 的请求体一读完 req.complete 就恒为 true，客户端在流式响应中途
    //    断开时这个判据永远不成立 → 上游不会被取消，继续白烧额度写死连接。
    //    res 正常结束会把 writableEnded 置 true，此时 close 事件不算异常断开。
    //
    // 三路合并（对齐上游）：非流式端点要等上游完成才发响应头，客户端在这之前
    // 断开时，res 的 close 在 Linux 上有时来得很晚；req 的 aborted 与 socket
    // 的 close 更早。三条信号共享同一个幂等 abort，谁先到都能立刻取消上游。
    const abort = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    const onResClose = () => {
      if (!res.writableEnded) abort();
    };
    const socket = req.socket;
    res.on('close', onResClose);
    req.once('aborted', abort);
    if (socket) socket.once('close', abort);
    // ⚠️ 只信 req.aborted / socket.destroyed：Node 在**请求体读完后**就会把
    //    IncomingMessage 标记为 destroyed，用 req.destroyed 当判据会在请求
    //    一开始就取消上游（表现为每条对话都 "aborted"）。
    if (req.aborted === true || socket?.destroyed === true) abort();
    // 轻量 trace：dispatch 往里写 provider / 账号 / delta 数供用量记录使用。
    // 只有对话自检才会开 wantText（累积正文），普通请求不存内容。
    return { signal: controller.signal, trace: {} };
  }

  const server = http.createServer(handler);
  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* noop */
    }
  });

  return {
    server,
    store,
    registry,
    modelService,
    logins,
    credits,
    autoCheckin,
    checkinLog,
    search,
    mcp,
    uiToken,
    handler
  };
}

/* ───────────── 渲染与工具 ───────────── */

const chatId = () => `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;

/**
 * 把 trace 与上游 usage 合进一条用量记录。
 * 字段名同时兼容 OpenAI（prompt_tokens）与 Anthropic（input_tokens）。
 * 只取数字与短字符串，绝不碰正文。
 */
function applyUsageRecord(rec, trace, usage) {
  if (!rec) return;
  if (trace?.provider) rec.provider = trace.provider;
  if (trace?.accountId) rec.account = trace.accountId;
  if (trace?.contentDeltas != null) rec.deltas = trace.contentDeltas;
  // 模型 id 可能有多级（`kilo-auto/free`），不能按第一个 `/` 切：
  // trace.modelId 已经是去掉 provider 前缀后的完整 id，直接用它。
  let model = String(trace?.modelId || '');
  if (!model) {
    model = String(rec.model || '');
    const provider = String(trace?.provider || '');
    if (provider && model.startsWith(`${provider}/`)) model = model.slice(provider.length + 1);
  }
  if (model) rec.model = model;
  if (!usage) {
    // 有正文流出但上游没给 usage：这一条的 0/0 是「未知」而不是「没消耗」，
    // 看板据此显示「N 次上游未报 token」，与真正失败 / 空回复区分开。
    if (Number(rec.deltas) > 0) rec.noUsage = true;
    return;
  }
  const pick = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return Math.round(n);
    }
    return 0;
  };
  // 装不进上下文窗口的输入侧用量不可信：上游偶发把 totalTokens 报得远超窗口，
  // 据此做软预算会误判「上下文超限」。输出侧保留，供速度统计使用。
  const trusted = trace?.contextWindow ? sanitizeUsage(usage, trace.contextWindow) : usage;
  if (!trusted) {
    if (Number(rec.deltas) > 0) rec.noUsage = true;
    return;
  }
  usage = trusted;
  rec.inTok = pick(usage.prompt_tokens, usage.input_tokens);
  rec.outTok = pick(usage.completion_tokens, usage.output_tokens);
  // 归一化层已把各家命名统一到 cached_tokens，这里再兜底读一次全部已知命名：
  // 即使某个渠道直接吐原始 usage（未经归一化），命中数也不会漏。
  // reported=false = 上游根本没上报缓存字段，记 cacheSeen 让看板区分「未上报」与「上报了 0」。
  const { hit, reported } = readCacheTokens(usage);
  rec.cachedTok = hit;
  rec.cacheSeen = reported;
  // 思考 token：上游算了但可能从未流式下发。速度口径要剔除这部分（usage-store.speedTokens）。
  const reason = pick(
    usage.completion_tokens_details?.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.reasoning_tokens
  );
  if (reason > 0) rec.reasonTok = reason;
  rec.sawReasoning = Number(rec.reasonDeltas) > 0;
}

function openAiCompletion({ id, model, text, reasoning, toolCalls, finishReason, usage }) {
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments || '{}' }
    }));
  }
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: usage ? publicUsage(usage) : usage
  };
}

function startSse(res) {
  res.writeHead(200, {
    ...CORS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);
}

/**
 * 每 15s 无条件发一个注释帧，防止中间层在长思考（无数据帧）期间断连。
 * ⚠️ 刻意不做「活跃就跳过」的抑制：注释帧极廉价，而漏发一次就可能被
 *    反代判超时断开，代价不对等。
 */
function startHeartbeat(res) {
  let last = Date.now();
  const timer = setInterval(() => {
    try {
      res.write(':\n\n');
      last = Date.now();
    } catch {
      /* noop */
    }
  }, SSE_HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  return {
    /** 标记「刚写过数据」，目前只用于排障时看出流是否活跃 */
    kick() {
      last = Date.now();
    },
    stop() {
      clearInterval(timer);
    }
  };
}

function sendJson(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS,
    ...extra,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new OfmError(Codes.INVALID_REQUEST, '请求体过大', { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new OfmError(Codes.INVALID_REQUEST, '请求体不是合法 JSON', { status: 400 });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OfmError(Codes.INVALID_REQUEST, '请求体必须是 JSON 对象', { status: 400 });
  }
  return value;
}

function publicAccount(a) {
  if (!a) return a;
  const { credentialRef, ...rest } = a;
  return rest;
}

/** 诊断样本只给排障用，绝不能把 token / JWT / 完整回复内容带出去。 */
function sanitizeForReport(s) {
  return String(s || '')
    .replace(/Cloud-IDE-JWT\s+\S+/gi, 'Cloud-IDE-JWT ***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9_-]{20,}/g, '***')
    .replace(/(access_token|refresh_token|userJwt|token)"?\s*[:=]\s*"?[^",\s}]+/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
}

function publicTrace(t) {
  return {
    provider: t.provider,
    modelId: t.modelId,
    channel: t.channel,
    accountCount: t.accountCount,
    accountId: t.accountId,
    url: t.url,
    httpStatus: t.httpStatus,
    contentType: t.contentType,
    shape: t.shape,
    frames: t.frames,
    validFrames: t.validFrames,
    contentDeltas: t.contentDeltas,
    attempts: t.attempts,
    emptyAttempts: t.emptyAttempts,
    upstreamFunction: t.upstreamFunction,
    modelInCatalog: t.modelInCatalog,
    modelMaxOutputTokens: t.modelMaxOutputTokens,
    request: t.request,
    textLength: (t.text || '').length,
    textSample: sanitizeForReport((t.text || '').slice(0, 120)),
    sample: sanitizeForReport(t.sample)
  };
}
