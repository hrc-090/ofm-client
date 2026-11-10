/**
 * MiniMax Code — 设备码 + PKCE，上游是 **Anthropic Messages** 协议（§5.7）
 * ⚠️ pending 可能是 HTTP 200 + status:"pending"，不是标准的 400 + authorization_pending。
 */
import crypto from 'node:crypto';
import { request, postForm, briefBody } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { openUpstream, iterateSse } from '../../http-client.js';
import { toAnthropicRequest, consumeAnthropicStream } from '../../anthropic-compat.js';
import { ensureCredential } from '../credential.js';
import { now } from '../../util.js';
import { normalizeReasoningOptions } from '../../reasoning-options.js';

const ACCOUNT = 'https://account.minimax.cn';
const APIHOST = 'https://agent.minimax.cn';
const CLIENT_ID = 'mcode-public';
const SCOPE = 'agent.default';
const AUDIENCE = 'agent-backend';

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export class MiniMaxChannel {
  constructor() {
    this.id = 'minimax';
    this.name = 'minimax';
    this.displayName = 'MiniMax Code';
    this.loginMode = 'device';
    this.requiresAccount = true;
    this.supported = true;
    this.note = '设备码登录，浏览器授权后自动完成';
    // 目录拉取失败时挂脱敏后的原因，供 /api/models 的 diagnostics 显示
    this.lastModelWarning = null;
    // 测试注入点：替换真实 HTTP，保持纯 mock 可测
    this.fetchModelsImpl = null;
    // 模型目录是公开配置接口（不带 token 也返回 200），不该被凭据过期卡住
    this.publicModels = true;
  }

  credential(store, account, opts = {}) {
    return ensureCredential(store, account, { refresh: refreshMiniMax, ...opts });
  }

  login = {
    start: async () => {
      const { verifier, challenge } = pkce();
      const res = await postForm(`${ACCOUNT}/oauth2/device/code`, {
        client_id: CLIENT_ID,
        scope: SCOPE,
        audience: AUDIENCE,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      });
      const d = res.json || {};
      const url = d.verification_uri_complete || d.verification_uri || d.verification_url;
      if (!d.device_code || !url) {
        throw new OfmError(Codes.UPSTREAM, `MiniMax 设备码失败: ${briefBody(res.text, 200)}`);
      }
      return {
        loginUrl: url,
        userCode: d.user_code,
        session: {
          deviceCode: d.device_code,
          verifier,
          interval: (d.interval || 3) * 1000,
          lastPoll: 0,
          expiresAt: now() + (Number(d.expires_in) || 600) * 1000
        },
        instructions: d.user_code ? `确认代码 ${d.user_code} 后授权` : '在浏览器完成授权'
      };
    },
    poll: async (session) => {
      if (Date.now() > session.expiresAt) return { done: true, success: false, error: '设备码已过期' };
      if (Date.now() - session.lastPoll < session.interval) return { done: false, status: 'waiting' };
      session.lastPoll = Date.now();

      const res = await postForm(`${ACCOUNT}/oauth2/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: session.deviceCode,
        client_id: CLIENT_ID,
        code_verifier: session.verifier
      });
      const d = res.json || {};
      // 两种 pending 形态都要认
      if (d.status === 'pending' || d.error === 'authorization_pending' || d.error === 'slow_down') {
        if (d.error === 'slow_down') session.interval += 1000;
        return { done: false, status: 'waiting' };
      }
      if (!d.access_token) {
        return { done: true, success: false, error: d.error_description || d.error || '授权失败' };
      }
      const scope = String(d.scope || '');
      if (scope && !scope.split(' ').includes(SCOPE)) {
        return { done: true, success: false, error: `授权范围不含 ${SCOPE}` };
      }
      const expiresAt = now() + (Number(d.expires_in) || 3600) * 1000;
      return {
        done: true,
        success: true,
        nickname: 'MiniMax Code',
        expiresAt,
        credential: {
          access_token: d.access_token, // 不是 JWT，只能靠 expires_in 自算过期
          refresh_token: d.refresh_token,
          expires_at: expiresAt,
          scope
        }
      };
    }
  };

  async listModels({ credential } = {}) {
    try {
      const doFetch = this.fetchModelsImpl || fetchRemoteModels;
      const res = await doFetch({ credential });
      if (!res || res.status >= 400) {
        throw new Error(`HTTP ${res?.status ?? '?'}: ${briefBody(res?.text, 200)}`);
      }
      const models = parseModelsResponse(res.json);
      if (!models.length) {
        // 旧版就是死在这里：形状认不出却返回空数组，HTTP 200、无报错、界面空白。
        // 现在把响应样本带进原因，至少能在 diagnostics 里看到真实形状。
        throw new Error(`目录为空或形状未识别: ${briefBody(res.text, 200)}`);
      }
      this.lastModelWarning = null;
      return models;
    } catch (e) {
      // 与 TRAE 同语义：远端不可用时不外抛，给静态兜底目录，
      // 同时把脱敏原因挂出来，界面显示「兜底目录（远端拉取失败：…）」。
      this.lastModelWarning = cleanWarning(e?.message);
      return fallbackMiniMaxModels();
    }
  }

  async *stream(req, { credential, signal }) {
    const body = toAnthropicRequest(req, { maxTokens: 8192 });
    const res = await openUpstream(`${APIHOST}/mavis/api/v1/llm/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${credential.access_token}`
      },
      body: JSON.stringify(body),
      timeoutMs: 60000,
      signal
    });
    if (res.status >= 400) {
      const text = await res.text();
      throw new OfmError(
        res.status === 401 ? Codes.AUTH : Codes.UPSTREAM,
        `MiniMax HTTP ${res.status}: ${text.slice(0, 200)}`,
        { status: res.status }
      );
    }
    yield* consumeAnthropicStream(iterateSse(res.raw, { idleTimeoutMs: 120000, signal }));
  }
}

/**
 * MiniMax 模型目录是**公开配置**接口：GET /mavis/api/v1/models 不带 token 也返回 200，
 * 形状是 providers[].config.models —— 一个**字典**，key 才是模型 id，
 * 值为 { name, limit:{context,output}, modalities, reasoning, effort_options, ... }。
 *
 * 旧版只认 `data.models` 数组，恒得空列表且不抛错，表现就是「MiniMax 拉不到模型」。
 * 这里同时兼容字典 / 数组 / 旧扁平形状，认不出时返回空数组由上层抛错。
 */
export function parseModelsResponse(json) {
  const providers = Array.isArray(json?.providers)
    ? json.providers
    : Array.isArray(json?.data?.providers)
      ? json.data.providers
      : [];
  const collected = [];
  const orders = [];

  const collect = (bag, order) => {
    if (!bag) return;
    if (Array.isArray(bag)) {
      for (const v of bag) {
        if (!v || typeof v !== 'object') continue;
        const id = v.id || v.model || v.model_id || v.name;
        if (id) collected.push({ id: String(id), raw: v });
      }
    } else if (typeof bag === 'object') {
      for (const [id, v] of Object.entries(bag)) {
        if (!id || !v || typeof v !== 'object') continue;
        collected.push({ id, raw: v });
      }
    }
    if (Array.isArray(order)) orders.push(order);
  };

  for (const p of providers) {
    const cfg = p?.config && typeof p.config === 'object' ? p.config : p;
    collect(cfg?.models, cfg?.model_order);
  }
  // 旧形状兜底：{data:{models:[...]}} / {models:[...]} / {data:[...]}
  if (!collected.length) {
    collect(
      json?.data?.models ?? json?.models ?? (Array.isArray(json?.data) ? json.data : null),
      json?.model_order
    );
  }

  const rank = new Map((orders[0] || []).map((id, i) => [String(id), i]));
  collected.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
    return ra - rb; // 未在 model_order 里的保持原顺序（稳定排序）
  });

  return collected.map(({ id, raw }) => {
    const input = Array.isArray(raw.modalities?.input) ? raw.modalities.input : [];
    // 公开配置里带 effort_options（如 default / low / high / xhigh），
    // 以前整个丢掉，App 只能显示 low/medium/high 兜底档位
    const reasoningOptions = normalizeReasoningOptions(
      raw.effort_options ?? raw.efforts ?? raw.effortOptions
    );
    return {
      id,
      displayName: raw.name || raw.display_name || id,
      contextWindow: Number(raw.limit?.context ?? raw.context_window ?? raw.contextWindow) || undefined,
      maxOutputTokens: Number(raw.limit?.output ?? raw.max_output_tokens) || undefined,
      multimodal: input.includes('image') || input.includes('video') ||
        raw.vision === true || raw.supports_vision === true,
      reasoning: raw.reasoning === true || raw.thinking === true ||
        raw.supports_reasoning === true || raw.supports_thinking === true ||
        reasoningOptions.length > 0,
      reasoningOptions
    };
  });
}

async function fetchRemoteModels({ credential } = {}) {
  const headers = { accept: 'application/json' };
  // 该端点无需 token，但带上真实凭据可兼容上游以后收紧权限
  if (credential?.access_token) headers.authorization = `Bearer ${credential.access_token}`;
  return request(`${APIHOST}/mavis/api/v1/models?region=cn&buildEnv=prod`, {
    headers,
    timeoutMs: 30000
  });
}

/** 远端不可用时的静态目录，字段来自公开配置接口实测值。 */
export function fallbackMiniMaxModels() {
  return [
    { id: 'MiniMax-M3', displayName: 'M3', contextWindow: 512000, multimodal: true, reasoning: true },
    { id: 'MiniMax-M3.1-Flash', displayName: 'M3.1-Flash', contextWindow: 512000, multimodal: true, reasoning: true }
  ].map((m) => ({ ...m, fallback: true }));
}

function cleanWarning(msg) {
  return String(msg || '未知原因')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

async function refreshMiniMax(cred) {
  if (!cred.refresh_token) throw new OfmError(Codes.AUTH, 'MiniMax 凭据无 refresh_token', { status: 401 });
  const res = await postForm(`${ACCOUNT}/oauth2/token`, {
    grant_type: 'refresh_token',
    refresh_token: cred.refresh_token,
    client_id: CLIENT_ID
  });
  if (res.status >= 400) throw new OfmError(Codes.AUTH, 'MiniMax 续期失败，需要重新登录', { status: 401 });
  const d = res.json || {};
  return {
    ...cred,
    access_token: d.access_token || cred.access_token,
    refresh_token: d.refresh_token || cred.refresh_token,
    expires_at: now() + (Number(d.expires_in) || 3600) * 1000
  };
}
