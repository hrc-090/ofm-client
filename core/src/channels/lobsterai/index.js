/**
 * LobsterAI（有道）— §5.4
 * 坑：模型目录必须带 X-LobsterAI-Client-Capabilities，否则**永久缺少 kimi-k3**。
 */
import { request, briefBody, encodeForm } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { openAiCompatStream } from '../../openai-compat.js';
import { toOpenAiMessages, toOpenAiTools } from '../../convert/openai-chat.js';
import { ensureCredential } from '../credential.js';
import { uuid, now } from '../../util.js';

const PORTAL = 'https://lobsterai.youdao.com';
const API = 'https://lobsterai-server.youdao.com';
const VERSION = '0.1.0';
const CAPS = 'kimi-k3-agentic-v1,thinking-level-control-v1';

const clientHeaders = () => ({
  'X-LobsterAI-Client-Capabilities': CAPS,
  'X-LobsterAI-Client-Version': VERSION,
  'user-agent': `LobsterAI/${VERSION}`
});

export class LobsterChannel {
  constructor() {
    this.id = 'lobsterai';
    this.name = 'lobsterai';
    this.displayName = 'LobsterAI';
    this.loginMode = 'callback';
    this.requiresAccount = true;
    this.supported = true;
    this.note = '登录后把回调链接粘回 App';
  }

  credential(store, account, opts = {}) {
    return ensureCredential(store, account, { refresh: refreshLobster, ...opts });
  }

  login = {
    start: async ({ accountId }) => {
      const state = uuid();
      const base = uuid();
      const redirect = `http://127.0.0.1:18901/auth/callback`;
      const loginUrl = `${PORTAL}/portal#/login?source=electron&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
      return {
        loginUrl,
        session: { state, uuid: base, firstKeyfrom: String(now()), redirect },
        instructions: '在浏览器授权后，把跳转到的整条地址（含 code 与 state）复制回 App'
      };
    },
    poll: async (session) => (session.result ? { done: true, ...session.result } : { done: false, status: 'waiting-callback' }),
    complete: async (session, url) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { success: false, error: '回调链接格式不正确' };
      }
      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      if (!code) return { success: false, error: '回调链接里没有 code' };
      if (state && state !== session.state) return { success: false, error: 'state 不匹配，可能被伪造，已拒绝' };

      const res = await request(`${API}/api/auth/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: {
          authCode: code,
          firstKeyfrom: session.firstKeyfrom,
          latestKeyfrom: String(now()),
          uuid: session.uuid,
          version: VERSION
        }
      });
      if (res.status >= 400) return { success: false, error: `换取 token 失败: ${briefBody(res.text, 200)}` };
      const d = res.json?.data || res.json || {};
      const token = d.accessToken || d.token || d.access_token;
      if (!token) return { success: false, error: '响应里没有 accessToken' };

      const result = {
        success: true,
        nickname: d.user?.nickname || d.nickname || d.user?.email || 'LobsterAI 账号',
        expiresAt: d.expiresAt ? Number(d.expiresAt) : undefined,
        credential: {
          access_token: token,
          refresh_token: d.refreshToken || d.refresh_token,
          expires_at: Number(d.expiresAt || 0) || undefined,
          // uuid / firstKeyfrom 贯穿账号生命周期，必须写进凭据
          uuid: session.uuid,
          first_keyfrom: session.firstKeyfrom,
          latest_keyfrom: session.latestKeyfrom || String(now()),
          user_id: d.user?.id || d.userId
        }
      };
      session.result = result;
      return result;
    }
  };

  async listModels() {
    const res = await request(`${API}/api/models/available`, { headers: clientHeaders(), timeoutMs: 30000 });
    if (res.status >= 400) throw new OfmError(Codes.UPSTREAM, `LobsterAI 模型目录失败: ${briefBody(res.text, 200)}`);
    const list = res.json?.data || res.json?.models || res.json || [];
    if (!Array.isArray(list)) return [];
    return list.map((m) => ({
      id: m.id || m.model,
      displayName: m.name || m.displayName || m.id,
      contextWindow: m.contextWindow || m.context_window,
      multimodal: Boolean(m.supportsVision || m.vision),
      reasoning: Boolean(m.supportsThinking || m.reasoning)
    }));
  }

  async *stream(req, { credential, signal }) {
    yield* openAiCompatStream({
      url: `${API}/api/proxy/v1/chat/completions`,
      headers: {
        ...clientHeaders(),
        accept: 'text/event-stream, application/json',
        authorization: `Bearer ${credential.access_token}`
      },
      body: {
        model: req.modelId,
        messages: toOpenAiMessages(req.messages),
        tools: toOpenAiTools(req.tools),
        tool_choice: req.toolChoice,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxTokens || undefined,
        temperature: req.temperature,
        reasoning_effort: req.reasoningEffort
      },
      onHttpError: (status, text) =>
        status === 401 || status === 403
          ? new OfmError(Codes.AUTH, 'LobsterAI 鉴权失败，需要重新登录', { status: 401 })
          : new OfmError(Codes.UPSTREAM, `LobsterAI HTTP ${status}: ${briefBody(text, 200)}`, { status }),
      signal
    });
  }
}

async function refreshLobster(cred) {
  if (!cred.refresh_token) throw new OfmError(Codes.AUTH, 'LobsterAI 凭据无 refresh_token', { status: 401 });
  const res = await request(`${API}/api/auth/refresh`, {
    method: 'POST',
    body: {
      firstKeyfrom: cred.first_keyfrom,
      // ⚠️ latestKeyfrom 用凭据里的原值，不更新
      latestKeyfrom: cred.latest_keyfrom,
      version: VERSION,
      uuid: cred.uuid,
      userId: cred.user_id,
      refreshToken: cred.refresh_token
    }
  });
  if (res.status === 401 || res.status === 403) {
    throw new OfmError(Codes.AUTH, 'LobsterAI 续期失败，需要重新登录', { status: 401 });
  }
  if (res.status >= 400) throw new OfmError(Codes.UPSTREAM, `LobsterAI 续期失败: ${briefBody(res.text, 200)}`);
  const d = res.json?.data || res.json || {};
  return {
    ...cred,
    access_token: d.accessToken || d.access_token || cred.access_token,
    refresh_token: d.refreshToken || d.refresh_token || cred.refresh_token,
    expires_at: Number(d.expiresAt || 0) || cred.expires_at
  };
}

export { encodeForm };
