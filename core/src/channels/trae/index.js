/**
 * TRAE 渠道实现：登录（本地回调）→ 模型目录 → 流式对话。
 */
import { OfmError, Codes } from '../../errors.js';
import { openUpstream, iterateSse, looksLikeSse } from '../../http-client.js';
import { tryJson } from '../../util.js';
import { TRAE, TRAE_PATHS } from './product.js';
import {
  traeHeaders,
  transformToSoloBody,
  applyMaxMode,
  parseTraeEvent,
  mapFinishReason,
  deriveRotatingMachineId,
  stripDevSuffix
} from './protocol.js';
import { newLoginSession, completeLogin, refreshCredential } from './auth.js';
import { fetchModels, toModelEntries, fallbackModelEntries } from './models.js';
import { ensureCredential } from '../credential.js';
import { repairTraeCredential } from '../../credential-repair.js';

export class TraeChannel {
  constructor({ fetchModelsImpl = null, openImpl = null } = {}) {
    this.id = 'trae';
    this.name = 'trae';
    this.displayName = 'TRAE';
    this.loginMode = 'callback';
    this.requiresAccount = true;
    this.supported = true;
    this.note = '登录后打开授权页，把回调链接粘回 App';
    this.modelIndex = new Map();
    // 最近一次目录拉取失败的原因（脱敏）。非空即表示当前展示的是兜底目录。
    this.lastModelWarning = null;
    // 可注入：验收测试用 mock 目录 / mock 上游，不联网
    this.fetchModelsImpl = fetchModelsImpl;
    this.openImpl = openImpl || openUpstream;
  }

  credential(store, account, opts = {}) {
    return Promise.resolve(ensureCredential(store, account, { refresh: refreshCredential, ...opts }))
      .then((cred) => {
        // 惰性兜底：即使凭据是在启动自愈之后才写入的，也不能让
        // x-machine-id / x-device-id 变成 undefined 发出去。
        // 只补缺失字段、不覆盖已有值，不写盘（持久化由启动自愈负责）。
        return repairTraeCredential(cred).credential;
      });
  }

  login = {
    start: async () => {
      const session = newLoginSession();
      return {
        loginUrl: session.loginUrl,
        session,
        instructions: `授权后浏览器会跳到 ${session.loginUrl.includes('trae') ? '127.0.0.1:18080/authorize' : ''}，把整条地址复制回 App`
      };
    },
    poll: async (session) => {
      if (session.result) return { done: true, ...session.result };
      return { done: false, status: 'waiting-callback' };
    },
    complete: async (session, url) => {
      const result = await completeLogin(session, url);
      if (result.success) session.result = result;
      return result;
    }
  };

  async listModels({ account, credential }) {
    const machineId = deriveRotatingMachineId(credential.machine_id, account?.generation || 0);
    try {
      const doFetch = this.fetchModelsImpl || fetchModels;
      const remote = await doFetch({ credential, machineId, deviceId: credential.device_id });
      const entries = toModelEntries(remote);
      if (entries.length === 0) throw new Error('远端目录为空');
      for (const e of entries) this.modelIndex.set(e.id, e);
      this.lastModelWarning = null;
      return entries;
    } catch (e) {
      // 上游同款语义：远端目录不可用时不外抛，回退静态兜底目录，
      // 保证「选择器不会为空」；同时保留失败原因供界面显示。
      this.lastModelWarning = sanitizeModelWarning(e?.message);
      const entries = fallbackModelEntries();
      for (const e of entries) this.modelIndex.set(e.id, e);
      return entries;
    }
  }

  async *stream(req, { account, credential, signal, trace = null }) {
    const modelId = stripDevSuffix(req.modelId);
    let meta = this.modelIndex.get(req.modelId) || this.modelIndex.get(modelId);

    // 目录没加载过（进程重启后第三方直接调 API，没先点开模型列表）时，
    // modelIndex 是空的，通道只能退到默认 solo_work_lite —— 而模型很可能
    // 只列在别的通道里。上游对「模型不属于该通道」不总是报错，常见表现是
    // 建好会话只发一帧 metadata 就断流。这里先补一次目录，失败也不挡主流程。
    if (!meta && account) {
      try {
        await this.listModels({ account, credential });
      } catch {
        /* 目录失败：仍按默认通道走，让上游自己报错 */
      }
      meta = this.modelIndex.get(req.modelId) || this.modelIndex.get(modelId);
    }

    const channel = meta?.function || TRAE.function;
    const machineId = deriveRotatingMachineId(credential.machine_id, account?.generation || 0);

    if (trace) {
      trace.modelInCatalog = Boolean(meta);
      trace.upstreamFunction = channel;
      trace.modelMaxOutputTokens = meta?.maxOutputTokens ?? null;
    }

    // 两次尝试：第一次按客户端参数；整轮零正文时换一套更保守的输出额度再发。
    // TRAE 在 max_tokens 超出模型上限 / 思考占满预算时，会建好会话、只发一帧
    // metadata 就断流（HTTP 200，零错误）；重开一个会话往往就正常，官方支持
    // 对「只有状态没有输出」的建议也是「新开对话重试」。
    const conservative =
      meta?.maxOutputTokens && meta.maxOutputTokens > 0
        ? Math.min(meta.maxOutputTokens, TRAE.defaultMaxOutputTokens)
        : TRAE.defaultMaxOutputTokens;
    const variants = [
      { maxTokens: req.maxTokens, reason: 'first' },
      { maxTokens: conservative, reason: 'empty-retry' }
    ];

    let attemptNo = 0;
    for (const variant of variants) {
      attemptNo += 1;
      if (trace) {
        trace.attempts = attemptNo;
        // 重试时重置上一轮观测值：报告要反映「最后一次」，而不是两轮累加
        Object.assign(trace, {
          frames: 0,
          validFrames: 0,
          sample: '',
          shape: null,
          httpStatus: null,
          contentType: null,
          url: null
        });
      }

      const body = transformToSoloBody(
        { ...req, maxTokens: variant.maxTokens },
        { channel, modelId, maxOutputTokens: meta?.maxOutputTokens }
      );
      if (meta?.maxMode && req.maxMode) {
        applyMaxMode(body, { contextWindow: meta.maxContextWindow, maxTokens: body.max_tokens });
      }
      if (trace) {
        trace.request = {
          model: body.model,
          function: body.function,
          max_tokens: body.max_tokens,
          messages: body.messages.length
        };
      }

      // 第一个正文 delta 之前绝不往客户端写：否则空流重试会先把 finish 帧
      // 发出去，客户端已经当成「结束」，后面再冒内容就废了。
      const buffered = [];
      let started = false;

      for await (const d of this.consume(body, { credential, machineId, signal, trace })) {
        if (!started) {
          buffered.push(d);
          if (isContentDelta(d)) {
            started = true;
            for (const b of buffered) yield b;
            buffered.length = 0;
          }
          continue;
        }
        yield d;
      }

      if (started) return;

      // 整轮零正文：丢弃 buffered（含可能的 finish），进入下一次尝试
      if (trace) {
        trace.emptyAttempts = (trace.emptyAttempts || 0) + 1;
        if (attemptNo < variants.length) trace.retriedReason = variant.reason;
      }
    }

    // 两次都没有正文：不 yield finish，交给 dispatch 抛 EMPTY_REPLY，
    // 报告里带上 attempts / function / request 供定位。
  }

  /**
   * 单次请求：发上游 + 解 SSE，产出内部 delta。
   * 不含重试与缓冲（由 stream 负责），重试时是一次干净的新会话。
   */
  async *consume(body, { credential, machineId, signal, trace = null }) {
    const payload = JSON.stringify(body);
    const url = `${TRAE.agentHost}${TRAE_PATHS.chat}`;

    const res = await this.openImpl(url, {
      method: 'POST',
      headers: {
        ...traeHeaders({
          accessToken: credential.access_token,
          uid: credential.uid,
          machineId,
          deviceId: credential.device_id,
          accept: 'text/event-stream'
        }),
        // 有些网关不接受 chunked 请求体；显式给长度，与 openAiCompatStream 对齐
        'content-length': Buffer.byteLength(payload)
      },
      body: payload,
      timeoutMs: 45000,
      signal
    });

    if (trace) {
      trace.url = url;
      trace.httpStatus = res.status;
      trace.contentType = String(res.headers['content-type'] || '');
    }

    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      if (trace) trace.sample = sanitizeTraceSample(text);
      throw new OfmError(Codes.AUTH, 'TRAE 鉴权失败，需要重新登录', { status: 401 });
    }
    if (res.status === 429) {
      const text = await res.text();
      if (trace) trace.sample = sanitizeTraceSample(text);
      throw new OfmError(Codes.MODEL_QUEUED, `TRAE 限流/排队: ${sanitizeTraceSample(text).slice(0, 200)}`, {
        retryAfterMs: 30000
      });
    }
    if (res.status >= 400) {
      const text = await res.text();
      if (trace) trace.sample = sanitizeTraceSample(text);
      throw new OfmError(
        Codes.INVALID_REQUEST,
        `TRAE 请求失败 HTTP ${res.status}: ${sanitizeTraceSample(text).slice(0, 300)}`,
        { status: res.status }
      );
    }

    // 取首个原始块嗅探形状：上游 200 时未必真是 SSE。
    // 可能回整段 JSON 完成体、业务错误 JSON，或只发心跳注释帧。
    const iterator = res.raw[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new OfmError(Codes.TRANSPORT, 'TRAE 返回了空响应（连首块都没有）');
    const headBuf = Buffer.isBuffer(first.value) ? first.value : Buffer.from(first.value);
    const probe = headBuf.toString('utf8', 0, Math.min(headBuf.length, 512));
    if (trace) trace.sample = sanitizeTraceSample(probe);

    let toolSeq = 0;
    const toolIndexById = new Map();
    const toolIndexByUpstream = new Map();
    const sentArgs = new Map(); // index → 已经下发给客户端的参数累计值
    let lastToolIndex = -1;
    let finished = false;

    /** 把一个统一事件摊成内部 delta；SSE 与整段 JSON 两条路径共用。 */
    const emit = function* (ev) {
      if (ev.reasoningContent) yield { type: 'reasoning', text: ev.reasoningContent };
      if (ev.response) yield { type: 'text', text: ev.response };
      for (const call of ev.toolCalls || []) {
        const id = call.id || call.function?.id;
        const upIndex = Number.isInteger(call.index) ? call.index : null;
        // 归并规则（顺序很重要）：
        //  1) 上游给了 index → 以 index 为准。OpenAI / TRAE 的分片帧首片带
        //     id，后续片只有 index；以前只看 id，于是后续片每次都被当成
        //     新调用（index +1），一个工具调用被拆成 N 个空参数调用 ——
        //     AI 收到的工具参数残缺，直接表现为「无法使用工具」。
        //  2) 没 index 但有 id → 按 id 复用。
        //  3) 两者都没有 → 归到最近一次打开的调用（纯增量帧）。
        let index;
        if (upIndex !== null) {
          if (!toolIndexByUpstream.has(upIndex)) toolIndexByUpstream.set(upIndex, toolSeq++);
          index = toolIndexByUpstream.get(upIndex);
        } else if (id && toolIndexById.has(id)) {
          index = toolIndexById.get(id);
        } else if (id) {
          index = toolSeq++;
          toolIndexById.set(id, index);
        } else if (lastToolIndex >= 0) {
          index = lastToolIndex;
        } else {
          index = toolSeq++;
        }
        lastToolIndex = index;
        if (id) {
          toolIndexById.set(id, index);
          if (upIndex !== null) toolIndexByUpstream.set(upIndex, index);
        }
        // 上游对 arguments 有两种习惯：增量（OpenAI 风格）和累计（每帧发全量）。
        // 累计值原样转发会让客户端拼出 `{"a":1}{"a":1}`，JSON 解析失败，
        // 工具调用直接作废。这里按「是否是已发内容的前缀超集」自适应裁掉已发部分。
        const rawArgs = call.function?.arguments ?? '';
        const prev = sentArgs.get(index) || '';
        const delta = prev && rawArgs.startsWith(prev) ? rawArgs.slice(prev.length) : rawArgs;
        sentArgs.set(index, prev + delta);
        yield {
          type: 'tool_call',
          index,
          id,
          name: call.function?.name,
          argumentsDelta: delta
        };
      }
      if (ev.usage) yield { type: 'usage', usage: ev.usage };
      if (ev.finishReason) {
        yield { type: 'finish', reason: mapFinishReason(ev.finishReason) };
        finished = true;
      }
    };

    if (!looksLikeSse(probe)) {
      // 200 + 非 SSE：把整段按 JSON 解析（业务错误 / 普通完成体 / 网关降级整段 SSE）
      const chunks = [headBuf];
      for await (const c of iterator) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const full = Buffer.concat(chunks).toString('utf8').trim();
      if (trace) {
        trace.shape = 'json';
        trace.frames = 1;
        trace.sample = sanitizeTraceSample(full.slice(0, 400));
      }
      const parsed = tryJson(full, undefined);
      if (parsed === undefined) {
        throw new OfmError(
          Codes.UPSTREAM,
          `TRAE 返回了非流式且无法解析的响应: ${sanitizeTraceSample(full.slice(0, 200))}`
        );
      }
      // parseTraeEvent 会识别业务错误（code!==0 / error 且无 choices）并抛出，
      // 也会把标准 OpenAI 完成对象转成统一事件形状。
      const ev = parseTraeEvent('', full);
      if (trace && (ev.response || ev.reasoningContent || ev.toolCalls?.length)) trace.validFrames = 1;
      yield* emit(ev);
    } else {
      if (trace) trace.shape = 'sse';
      // 首块原样喂回，避免 TextDecoder 二次解码破坏多字节边界
      const prefetched = (async function* () {
        yield headBuf;
        for await (const c of iterator) yield c;
      })();
      // iterateSse 的空闲/首帧超时靠 destroy 掐断流；async generator 没有
      // destroy，这里把销毁动作转发到底层 socket，超时才真的能生效。
      prefetched.destroy = (err) => {
        try { res.raw.destroy(err); } catch { /* noop */ }
      };
      for await (const evt of iterateSse(prefetched, {
        idleTimeoutMs: 90000,
        firstEventTimeoutMs: 60000,
        signal
      })) {
        if (trace) trace.frames = (trace.frames || 0) + 1;
        const ev = parseTraeEvent(evt.event, evt.data);
        if (trace && (ev.response || ev.reasoningContent || ev.toolCalls?.length)) {
          trace.validFrames = (trace.validFrames || 0) + 1;
        }
        yield* emit(ev);
      }
    }

    if (!finished) yield { type: 'finish', reason: 'stop' };
  }
}

/** 只有这三类算「有正文」；usage / finish 都不算。 */
function isContentDelta(d) {
  return Boolean(d) && (d.type === 'text' || d.type === 'reasoning' || d.type === 'tool_call');
}

/** 诊断样本只用于排障显示，绝不能把 token / JWT 带出去。 */
function sanitizeTraceSample(s) {
  return String(s || '')
    .replace(/Cloud-IDE-JWT\s+\S+/gi, 'Cloud-IDE-JWT ***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9_-]{20,}/g, '***')
    .replace(/(access_token|refresh_token|userJwt|token)"?\s*[:=]\s*"?[^",\s}]+/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
}

/** 目录失败原因要显示给用户，但绝不能把凭据带出去。 */
function sanitizeModelWarning(msg) {
  return String(msg || '未知原因')
    .replace(/Cloud-IDE-JWT\s+\S+/gi, 'Cloud-IDE-JWT ***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9_-]{20,}/g, '***')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}
