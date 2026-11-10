/**
 * 渠道调度：选号 → 续期 → 流式对话 → 失败分类重试/换号。
 * 这一层是唯一知道「重试策略」的地方，渠道实现只负责单账号单次请求。
 */
import { OfmError, Codes, normalizeError } from './errors.js';
import { pickAccounts, markUsed, markRateLimited, markNeedsLogin } from './account-pool.js';
import { sleep } from './util.js';
import { splitModelId } from './registry.js';
import { resolveModelId } from './model-label.js';
import { normalizeReasoningOptions } from './reasoning-options.js';

const MAX_ACCOUNTS_PER_REQUEST = 3;
const MAX_QUEUE_WAIT_MS = 180000;

/**
 * @returns {AsyncGenerator<object>} 内部 delta 流
 */
export async function* chatStream({ registry, store, settings, req, signal, trace = null }) {
  // /v1/models 下发的 id 前面带了渠道名，进调度前先还原成 provider/model。
  // 旧客户端传真实 id 时 resolveModelId 原样返回，完全兼容。
  const model = resolveModelId(req.model);
  const { provider, modelId } = splitModelId(model);
  const channel = registry.get(provider);
  const label = channel.displayName || provider;
  req = { ...req, model, modelId, provider };
  // 默认思考档位：**只在客户端没显式传 reasoning_effort 时补**。
  // 绝不覆盖调用方的选择，否则第三方设的 high 会被 App 里的默认值吃掉。
  if (!req.reasoningEffort && settings?.modelEffort) {
    const picked = settings.modelEffort[`${provider}/${modelId}`] || settings.modelEffort[modelId];
    if (typeof picked === 'string' && picked) req = { ...req, reasoningEffort: picked };
  }
  if (trace) Object.assign(trace, { provider, modelId, channel: label });

  if (channel.requiresAccount === false) {
    let content = 0;
    for await (const delta of channel.stream(req, { store, settings, signal, account: null, credential: null, trace })) {
      if (delta.type === 'credential') continue;
      if (isContentDelta(delta)) {
        content += 1;
        if (trace) {
          trace.contentDeltas = (trace.contentDeltas || 0) + 1;
          // 只有对话自检需要正文；普通请求只统计数量，不累积内容（省内存）
          if (trace.wantText && delta.type === 'text') trace.text = (trace.text || '') + String(delta.text || '');
        }
      }
      yield delta;
    }
    // 上游回了响应但一个正文 delta 都没有：绝不能当成功返回空 completion，
    // 否则第三方客户端就是「接入 API 无回复」，且全程没有任何错误可查。
    if (content === 0) throw emptyReplyError(trace);
    return;
  }

  const accounts = pickAccounts(settings, provider, modelId, { providerName: label }).slice(0, MAX_ACCOUNTS_PER_REQUEST);
  let lastError = null;
  if (trace) trace.accountCount = accounts.length;

  for (const account of accounts) {
    let credential;
    try {
      credential = await channel.credential(store, account);
    } catch (e) {
      lastError = normalizeError(e, Codes.AUTH);
      if (lastError.code === Codes.AUTH) continue;
      throw lastError;
    }

    let attempt = 0;
    let emitted = false;

    while (attempt < 3) {
      attempt += 1;
      let content = 0;
      try {
        if (trace) trace.accountId = account.id;
        const stream = channel.stream(req, { store, settings, account, credential, signal, trace });
        for await (const delta of stream) {
          emitted = true;
          if (delta.type === 'credential') {
            credential = delta.credential;
            store.writeCredential(account.credentialRef, credential);
            continue;
          }
          if (isContentDelta(delta)) {
            content += 1;
            if (trace) {
              trace.contentDeltas = (trace.contentDeltas || 0) + 1;
              if (trace.wantText && delta.type === 'text') trace.text = (trace.text || '') + String(delta.text || '');
            }
          }
          yield delta;
        }
        if (content === 0) throw emptyReplyError(trace);
        markUsed(store, account.id);
        return;
      } catch (raw) {
        const err = normalizeError(raw);
        lastError = err;

        if (err.code === Codes.MODEL_QUEUED && !emitted) {
          const waitMs = Math.min(err.retryAfterMs || 30000, MAX_QUEUE_WAIT_MS);
          if (attempt < 3) {
            await sleep(waitMs);
            continue;
          }
        }

        if (err.code === Codes.AUTH && !emitted) {
          try {
            const fresh = await channel.credential(store, account, { force: true });
            credential = fresh;
            if (attempt < 2) continue;
          } catch (e2) {
            markNeedsLogin(store, account.id, true);
          }
          break; // 换下一个账号
        }

        if (err.code === Codes.QUOTA_EXCEEDED && !emitted) {
          // 该账号今天额度用尽：短期限流，直接换号
          markRateLimited(store, account.id, modelId, Date.now() + 5 * 60 * 1000);
          break;
        }

        if ((err.code === Codes.TRANSPORT || err.code === Codes.SERVER) && !emitted && attempt < 2) {
          await sleep(600 * attempt);
          continue;
        }

        throw err;
      }
    }
  }

  throw lastError || new OfmError(Codes.NO_ACCOUNT, `${label} 无可用的已启用账号`, { provider });
}

/** 只有这三类算「有正文」；usage / finish / credential 都不算。 */
function isContentDelta(d) {
  return Boolean(d) && (d.type === 'text' || d.type === 'reasoning' || d.type === 'tool_call');
}

/**
 * 上游 200 且流正常结束，却一个正文 delta 都没解析出来时抛这个错。
 * 以前这里会静默返回空 completion —— 第三方客户端表现为「接入 API 无回复」，
 * 既看不到内容也看不到错误。宁可给一条明确的错误，也不要空白。
 */
function emptyReplyError(trace) {
  const bits = [];
  if (trace?.httpStatus) bits.push(`上游 HTTP ${trace.httpStatus}`);
  if (trace?.frames != null) bits.push(`收到 ${trace.frames} 帧`);
  if (trace?.contentType) bits.push(`content-type=${trace.contentType}`);
  if (trace?.upstreamFunction) bits.push(`通道 ${trace.upstreamFunction}`);
  if (trace?.request?.max_tokens) bits.push(`max_tokens=${trace.request.max_tokens}`);
  if (trace?.attempts > 1) bits.push(`已自动重试 ${trace.attempts - 1} 次`);
  const detail = bits.length ? `（${bits.join('，')}）` : '';
  return new OfmError(
    Codes.EMPTY_REPLY,
    `上游建了会话但没有任何正文${detail}。常见原因：该模型对这个账号不可调用、额度不足，` +
      '或思考过程占满了 max_tokens。先换一个模型再试；点「对话自检」可查看上游原始响应。',
    { status: 502, provider: trace?.provider, retryable: false }
  );
}

/**
 * 模型目录：按 provider 聚合，转成 `${provider}/${model}`，缓存 5 分钟。
 * 某家失败时保留上一次的好结果（避免 UI 一闪变空）。
 */
export function createModelService({ registry, store, log }) {
  const cache = new Map(); // provider -> { at, models, error }
  const diag = new Map(); // provider -> { source, count, warning? }
  const TTL = 5 * 60 * 1000;

  function sanitizeWarning(s) {
    return String(s || '')
      .replace(/Cloud-IDE-JWT\s+\S+/gi, 'Cloud-IDE-JWT ***')
      .replace(/Bearer\s+\S+/gi, 'Bearer ***')
      .replace(/eyJ[A-Za-z0-9_-]{20,}/g, '***')
      .replace(/\s+/g, ' ')
      .slice(0, 200);
  }

  function setDiag(provider, models, warning) {
    diag.set(provider, {
      source: models.some((m) => m && m.fallback === true) ? 'fallback' : 'remote',
      count: models.length,
      ...(warning ? { warning: sanitizeWarning(warning) } : {})
    });
  }

  async function modelsOf(provider, { force = false } = {}) {
    const settings = store.settings;
    const channel = registry.get(provider);
    if (channel.requiresAccount === false) {
      // 无账号渠道的目录也缓存：请求入口要靠它把显示名还原成 provider/model，
      // 每次现拉会让「解析一个名字」变成网络操作。
      const local = cache.get(provider);
      if (!force && local && Date.now() - local.at < TTL && local.models) return local.models;
      const models = (await channel.listModels({ store, settings })) || [];
      cache.set(provider, { at: Date.now(), models });
      // 无账号渠道也可能用兜底目录，失败原因一样要透给界面
      setDiag(provider, models, channel.lastModelWarning);
      return models;
    }
    const accounts = settings.accounts.filter((a) => a.provider === provider && a.enabled !== false);
    if (!accounts.length) {
      diag.set(provider, { source: 'no-account', count: 0 });
      return []; // 无账号 → 空列表，不抛错（§5.0）
    }

    const cached = cache.get(provider);
    if (!force && cached && Date.now() - cached.at < TTL && cached.models) return cached.models;

    let lastError = null;
    for (const account of accounts) {
      try {
        // 公开配置目录（MiniMax /mavis/api/v1/models）不依赖 token：
        // 声明 publicModels 的渠道跳过取凭据，避免 token 过期/续期失败连带拉不到模型。
        const credential = channel.publicModels === true
          ? undefined
          : await channel.credential(store, account);
        const models = await channel.listModels({ store, settings, account, credential });
        cache.set(provider, { at: Date.now(), models });
        // 渠道把远端失败原因挂在这里；非空即表示展示的是兜底目录
        setDiag(provider, models, channel.lastModelWarning);
        return models;
      } catch (e) {
        lastError = e;
        if (log) log.warn(`拉取 ${provider} 模型目录失败: ${e.message}`);
        // 换下一个账号；全部失败再回退缓存
      }
    }
    if (cached?.models) {
      setDiag(provider, cached.models, '远端刷新失败，沿用上次目录');
      return cached.models;
    }
    diag.set(provider, {
      source: 'error',
      count: 0,
      warning: sanitizeWarning(lastError?.message || '未知原因')
    });
    return [];
  }

  return {
    invalidate(provider) {
      if (provider) cache.delete(provider);
      else cache.clear();
    },
    /** 每个渠道最近一次目录状态，供 /api/models 与 /v1/models 附带（第三方忽略）。 */
    diagnostics() {
      return [...diag.entries()].map(([provider, d]) => ({ provider, ...d }));
    },
    async listAll({ force = false } = {}) {
      const settings = store.settings;
      const providers = new Set(
        settings.accounts.filter((a) => a.enabled !== false).map((a) => a.provider)
      );
      for (const ch of registry.list()) if (ch.requiresAccount === false && ch.supported) providers.add(ch.id);

      // 渠道显示名（如「TRAE」）随模型一起下发，App 在模型名前展示。
      // 用 list() 而不是 channels Map：测试里的 registry 桩只有 get/list 两个方法。
      const names = new Map(
        registry.list().map((c) => [c.id, c.displayName || c.name || c.id])
      );
      // 目录安全约束：App 的模型页把 id 直接当 LazyColumn 的 key、把 display_name
      // 原样交给 Text 排版。上游偶尔返回重复目录项或拼接脏串（[渠道] :: id 之类），
      // 重复 key 会让滚动位置恢复错乱，超长文本会把单个 Text 的 StaticLayout
      // 撑到内存溢出 —— 表现正是「一直下滑才闪退」。这里在源头保证：
      // id 唯一、展示文本有上限、可选档位数有上限。
      const MAX_TEXT = 120;
      const MAX_EFFORT = 12;
      const clamp = (v, max = MAX_TEXT) => {
        const s = String(v ?? '');
        return s.length > max ? `${s.slice(0, max - 1)}…` : s;
      };
      const seen = new Set();
      const out = [];
      for (const provider of providers) {
        let models = [];
        try {
          models = await modelsOf(provider, { force });
        } catch {
          models = [];
        }
        const disabled = settings.disabledModels?.[provider] || {};
        for (const m of models) {
          // 空 / 无 id 的脏条目直接丢：否则会生成 `provider/undefined` 这种
          // 既不唯一也没法调用的字符串，还会污染 LazyColumn 的 key 集合。
          if (!m || m.id == null || String(m.id).trim() === '' || disabled[m.id]) continue;
          const id = `${provider}/${m.id}`;
          if (seen.has(id)) continue;   // 同一渠道的重复目录项只保留第一条
          seen.add(id);
          // 各渠道声明档位的字段名不一样：TRAE=reasoningOptions、Qoder=efforts、
          // MiniMax=effort_options。统一归一化，App 才能看到真实的思考档位，
          // 而不是退到 low/medium/high 兜底。
          const reasoningOptions = normalizeReasoningOptions(
            m.reasoningOptions ?? m.efforts ?? m.effortOptions ?? m.effort_options
          );
          out.push({
            id,
            object: 'model',
            created: m.created || 0,
            owned_by: provider,
            provider,
            provider_name: clamp(names.get(provider) || provider, 24),
            model: m.id,
            display_name: clamp(m.displayName || m.id),
            context_window: m.contextWindow,
            supports_images: m.multimodal === true,
            supports_reasoning: m.reasoning === true,
            // 档位值原样来自上游目录，App 只做展示与回填，不做任何映射
            ...(reasoningOptions.length ? { reasoning_options: reasoningOptions.slice(0, MAX_EFFORT) } : {}),
            // 积分消耗倍率（1 = 原价，0.5 = 半价，0 = 免费）。
            // 用 != null 判断：0 是合法值，不能靠真值过滤。
            ...(m.creditsRate != null ? { credits_rate: m.creditsRate } : {}),
            ...(m.originalCreditsRate != null ? { original_credits_rate: m.originalCreditsRate } : {}),
            ...(m.discountEndsAtSec ? { discount_ends_at: m.discountEndsAtSec * 1000 } : {}),
            ...(m.fallback ? { fallback: true } : {})
          });
        }
      }
      return out;
    },
    /**
     * 只读缓存快照：**不发任何网络请求**。
     * 请求入口用它把「模型显示名」还原成 `provider/model`——绝不能在那个位置
     * 裸调 listAll()，否则某家上游卡住（TRAE 单次超时 75s）会把整个对话请求
     * 一起拖到客户端超时，表现为「用着用着就断了」。
     */
    peek() {
      const disabledAll = store.settings?.disabledModels || {};
      const out = [];
      for (const [provider, entry] of cache) {
        if (!entry || !Array.isArray(entry.models)) continue;
        const disabled = disabledAll[provider] || {};
        for (const m of entry.models) {
          if (!m || disabled[m.id]) continue;
          out.push({
            id: `${provider}/${m.id}`,
            model: m.id,
            display_name: m.displayName || m.id,
            provider
          });
        }
      }
      return out;
    },
    modelsOf
  };
}
