/**
 * Qoder / Qoder 中国版渠道。
 *
 * 默认走**加密端点**（WASM 生成的 url/headers/body 原样透传），
 * 只有显式配置 mode='public' 时才走公开 OpenAI 兼容端点（模型名不同！）。
 */
import { OfmError, Codes } from '../../errors.js';
import { openUpstream, iterateSse } from '../../http-client.js';
import { QODER, QODER_CN, PATHS } from './product.js';
import { modelsFor, modelMeta } from './models.js';
import { buildQoderInferPayload, toQoderHistory } from './payload.js';
import { createSession, pollOnce, refreshCredential, fetchUserInfo } from './auth.js';
import { innerTextOf, classifyInner, parseQoderError } from './envelope.js';
import { QoderEncryptedInfer } from './wasm.js';
import { ensureCredential } from '../credential.js';
import { contentToText } from '../../canonical.js';
import { deltasFromChunk, mapFinish } from '../../openai-compat.js';
import { tryJson } from '../../util.js';

export class QoderChannel {
  constructor({ id }) {
    this.id = id;
    this.name = id;
    this.product = id === 'qodercn' ? QODER_CN : QODER;
    this.displayName = this.product.displayName;
    this.loginMode = 'device';
    this.requiresAccount = true;
    this.supported = true;
    this.note = '设备码登录；加密推理依赖包内 WASM';
    this.clientCache = new Map();
  }

  credential(store, account, opts = {}) {
    return ensureCredential(store, account, {
      refresh: (cred) => refreshCredential(cred, this.product),
      ...opts
    });
  }

  login = {
    start: async () => {
      const session = createSession(this.product);
      return {
        loginUrl: session.loginUrl,
        session,
        instructions: '在授权页确认后回到 App，等待自动完成'
      };
    },
    poll: async (session) => {
      const r = await pollOnce(session, this.product);
      if (!r.done) return { done: false, status: r.status };
      return r;
    }
  };

  async listModels() {
    return modelsFor(this.id).map((m) => ({
      id: m.id,
      displayName: m.name,
      contextWindow: m.contextWindow,
      multimodal: m.multimodal,
      reasoning: m.reasoning,
      efforts: m.efforts
    }));
  }

  async #client(account, cred) {
    const key = `${account.id}:${cred.access_token ? cred.access_token.slice(-12) : 'none'}`;
    const cached = this.clientCache.get(account.id);
    if (cached && cached.key === key) return cached.client;
    const client = await QoderEncryptedInfer.create({
      user: { uid: cred.uid, securityOauthToken: cred.access_token },
      machineId: cred.machine_id,
      metadata: this.product.clientMetadata,
      host: this.product.encryptedInferBase,
      clientVersion: this.product.cosyVersion
    });
    this.clientCache.set(account.id, { key, client });
    return client;
  }

  async *stream(req, { account, credential, signal, store }) {
    let cred = credential;

    // uid 是签名的必要输入；旧凭据缺它时补一次
    if (!cred.uid) {
      const info = await fetchUserInfo(cred, this.product);
      if (info?.uid) {
        cred = { ...cred, uid: info.uid, nickname: cred.nickname || info.nickname };
        yield { type: 'credential', credential: cred };
      } else {
        throw new OfmError(Codes.AUTH, 'Qoder 凭据缺少 uid，无法生成加密签名，请重新登录', { status: 401 });
      }
    }

    const meta = modelMeta(this.id, req.modelId);
    if (!meta) {
      yield* this.streamPublic(req, cred, signal);
      return;
    }

    const systemText = contentToText(req.messages.find((m) => m.role === 'system')?.content || '');
    const history = toQoderHistory(req.messages);

    const ask = {
      modelKey: req.modelId,
      userText: contentToText([...req.messages].reverse().find((m) => m.role === 'user')?.content || ''),
      systemText,
      history,
      isReasoning: meta.reasoning === true,
      maxTokens: req.maxTokens || 32768,
      reasoningEffort: req.reasoningEffort || meta.defaultEffort,
      contextWindow: meta.contextWindow,
      displayName: meta.name,
      isVl: meta.multimodal !== false,
      sessionType: this.product.sessionType,
      source: 'system',
      business: { type: 'agent' },
      tools: (req.tools || []).map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || undefined, parameters: t.parameters }
      }))
    };

    const client = await this.#client(account, cred);
    const prepared = client.prepareInfer({
      modelKey: req.modelId,
      payload: buildQoderInferPayload(ask),
      source: 'system'
    });

    const res = await openUpstream(prepared.url, {
      method: 'POST',
      headers: { ...prepared.headers, 'content-length': Buffer.byteLength(prepared.body) },
      body: prepared.body,
      timeoutMs: 60000,
      signal
    });

    if (res.status >= 400) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new OfmError(Codes.AUTH, `Qoder 签名被拒（${res.status}），可能需要重新登录: ${text.slice(0, 200)}`, {
          status: 401
        });
      }
      throw new OfmError(Codes.UPSTREAM, `Qoder 加密端点 HTTP ${res.status}: ${text.slice(0, 200)}`, {
        status: res.status
      });
    }

    let finished = false;
    let toolSeq = 0;
    const toolIndex = new Map();

    for await (const evt of iterateSse(res.raw, { idleTimeoutMs: 120000, signal })) {
      const payload = evt.data.trim();
      if (!payload || payload === '[DONE]') continue;

      const inner = innerTextOf(payload);
      if (inner === null) {
        const direct = tryJson(payload, null);
        if (direct) yield* deltasFromChunk(direct);
        continue;
      }

      const kind = classifyInner(inner);
      if (kind === 'heartbeat') continue;
      if (kind === 'error') throw qoderErrorOf(inner);

      const chunk = tryJson(inner, null);
      if (!chunk) continue;

      for (const d of deltasFromChunk(chunk)) {
        if (d.type === 'tool_call') {
          const key = d.id || d.index;
          if (!toolIndex.has(key)) toolIndex.set(key, toolSeq++);
          yield { ...d, index: toolIndex.get(key), argumentsDelta: d.argumentsDelta || '' };
          continue;
        }
        if (d.type === 'finish') finished = true;
        yield d;
      }
    }

    if (!finished) yield { type: 'finish', reason: 'stop' };
  }

  /** 公开端点：只认通用模型名，走标准 OpenAI 兼容 */
  async *streamPublic(req, cred, signal) {
    const res = await openUpstream(`${this.product.inferBase}${PATHS.chatPublic}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${cred.access_token}`
      },
      body: JSON.stringify({
        model: req.modelId,
        stream: true,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: req.maxTokens || undefined
      }),
      timeoutMs: 60000,
      signal
    });

    if (res.status >= 400) {
      const text = await res.text();
      throw new OfmError(
        res.status === 401 ? Codes.AUTH : Codes.INVALID_REQUEST,
        `Qoder 公开端点 HTTP ${res.status}: ${text.slice(0, 200)}`,
        { status: res.status }
      );
    }

    for await (const evt of iterateSse(res.raw, { idleTimeoutMs: 120000, signal })) {
      const payload = evt.data.trim();
      if (!payload || payload === '[DONE]') continue;
      const chunk = tryJson(payload, null);
      if (chunk) yield* deltasFromChunk(chunk);
    }
    yield { type: 'finish', reason: 'stop' };
  }
}

function qoderErrorOf(inner) {
  const { code, message, retryAfterMs } = parseQoderError(inner);
  if (code === '10605') {
    return new OfmError(Codes.MODEL_QUEUED, `模型排队中，约 ${Math.round((retryAfterMs || 30000) / 1000)} 秒后重试`, {
      retryAfterMs: retryAfterMs || 30000
    });
  }
  if (code === '110' || /daily count exceeded/i.test(message)) {
    return new OfmError(Codes.QUOTA_EXCEEDED, `Qoder 额度已用尽: ${message}`);
  }
  if (code === '105' || /authentication|unauthorized/i.test(message)) {
    return new OfmError(Codes.AUTH, `Qoder 认证失败: ${message}`, { status: 401 });
  }
  if (code === 'duplicate_request') {
    return new OfmError(Codes.TRANSPORT, '重复请求，可直接重发', { retryable: true });
  }
  if (code === '101' || /signature invalid/i.test(message)) {
    return new OfmError(Codes.AUTH, `Qoder 签名无效（101），请重新登录: ${message}`, { status: 401 });
  }
  return new OfmError(Codes.UPSTREAM, `Qoder 业务错误 ${code ?? ''}: ${message}`.trim());
}

export { mapFinish };
