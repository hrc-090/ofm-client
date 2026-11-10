/**
 * Cline（WorkOS 设备码）— §5.3
 * 坑：access_token 必须保留服务端给的 `workos:` 前缀，剥掉即 401。
 */
import { request, postForm, briefBody } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { openAiCompatStream, normalizeUsage } from '../../openai-compat.js';
import { toOpenAiMessages, toOpenAiTools } from '../../convert/openai-chat.js';
import { ensureCredential } from '../credential.js';
import { toEpochMs, expiresInToMs, now } from '../../util.js';

const API = 'https://api.cline.bot';
const WORKOS = 'https://api.workos.com';
const WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR';
const CLIENT_HEADERS = {
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk'
};

function mapError(status, text) {
  if (status === 401 || status === 403) return new OfmError(Codes.AUTH, 'Cline 鉴权失败，需要重新登录', { status: 401 });
  if (status === 429) return new OfmError(Codes.QUOTA_EXCEEDED, `Cline 限流: ${briefBody(text, 200)}`);
  return new OfmError(Codes.UPSTREAM, `Cline HTTP ${status}: ${briefBody(text, 200)}`, { status });
}

export class ClineChannel {
  constructor() {
    this.id = 'cline';
    this.name = 'cline';
    this.displayName = 'Cline';
    this.loginMode = 'device';
    this.requiresAccount = true;
    this.supported = true;
    this.note = 'WorkOS 设备码登录，浏览器确认后自动完成';
  }

  credential(store, account, opts = {}) {
    return ensureCredential(store, account, { refresh: refreshCline, ...opts });
  }

  login = {
    start: async () => {
      const res = await postForm(`${WORKOS}/user_management/authorize/device`, {
        client_id: WORKOS_CLIENT_ID
      });
      const d = res.json || {};
      if (!d.device_code) {
        throw new OfmError(Codes.UPSTREAM, `Cline 设备码申请失败: ${briefBody(res.text, 200)}`);
      }
      return {
        loginUrl: d.verification_uri_complete || d.verification_uri,
        userCode: d.user_code,
        session: {
          deviceCode: d.device_code,
          interval: (d.interval || 5) * 1000,
          expiresAt: now() + expiresInToMs(d.expires_in, 600000),
          lastPoll: 0
        },
        instructions: d.verification_uri_complete ? '在浏览器完成授权即可' : `打开 ${d.verification_uri}，输入代码 ${d.user_code}`
      };
    },
    poll: async (session) => {
      if (Date.now() > session.expiresAt) return { done: true, success: false, error: '设备码已过期，请重试' };
      if (Date.now() - session.lastPoll < session.interval) return { done: false, status: 'waiting' };
      session.lastPoll = Date.now();

      const res = await postForm(`${WORKOS}/user_management/authenticate`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: session.deviceCode,
        client_id: WORKOS_CLIENT_ID
      });
      const d = res.json || {};
      if (d.error === 'authorization_pending') return { done: false, status: 'waiting' };
      if (d.error === 'slow_down') {
        session.interval += 1000; // 必须真退避且累积
        return { done: false, status: 'waiting' };
      }
      if (!d.access_token) {
        return { done: true, success: false, error: d.error_description || d.error || '授权失败' };
      }

      const reg = await request(`${API}/api/v1/auth/register`, {
        method: 'POST',
        headers: { ...CLIENT_HEADERS },
        body: { accessToken: d.access_token, refreshToken: d.refresh_token }
      });
      const regData = reg.json || {};
      const token = regData.data?.accessToken || regData.accessToken || d.access_token;
      const refresh = regData.data?.refreshToken || regData.refreshToken || d.refresh_token;

      return {
        done: true,
        success: true,
        nickname: regData.data?.user?.email || regData.user?.email || 'Cline 账号',
        expiresAt: now() + expiresInToMs(d.expires_in, 3600 * 1000),
        credential: {
          access_token: token, // 保留 workos: 前缀
          refresh_token: refresh,
          expires_at: now() + expiresInToMs(d.expires_in, 3600 * 1000),
          email: regData.data?.user?.email || regData.user?.email
        }
      };
    }
  };

  async listModels() {
    const out = [];
    const seen = new Set();

    // 唯一权威的免费集合（/api/v1/models 里没有 cline-free/*）
    try {
      const rec = await request(`${API}/api/v1/ai/cline/recommended-models`, {
        headers: { ...CLIENT_HEADERS },
        timeoutMs: 30000
      });
      const groups = ['recommended', 'free', 'clinePass'];
      for (const g of groups) {
        for (const m of rec.json?.[g] || []) {
          const id = m.id || m.model || m.slug;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push({
            id,
            displayName: m.name || m.displayName || id,
            contextWindow: m.contextWindow || m.context_window,
            multimodal: Boolean(m.supportsImages || m.vision),
            reasoning: Boolean(m.supportsReasoning || /think|reason/i.test(String(m.name || '')))
          });
        }
      }
    } catch {
      /* 忽略：拿不到就只返回认证目录 */
    }

    return out;
  }

  async *stream(req, { credential, signal }) {
    const body = {
      model: req.modelId,
      messages: toOpenAiMessages(req.messages),
      tools: toOpenAiTools(req.tools),
      tool_choice: req.toolChoice,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens || undefined,
      temperature: req.temperature,
      // 不传则模型完全不思考
      reasoning_effort: req.reasoningEffort || 'high'
    };
    yield* openAiCompatStream({
      url: `${API}/api/v1/chat/completions`,
      headers: { ...CLIENT_HEADERS, authorization: `Bearer ${credential.access_token}` },
      body,
      onHttpError: mapError,
      signal
    });
  }
}

async function refreshCline(cred) {
  if (!cred.refresh_token) throw new OfmError(Codes.AUTH, 'Cline 凭据无 refresh_token，需要重新登录', { status: 401 });
  const res = await request(`${API}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS },
    // ⚠️ 驼峰，不是 snake_case
    body: { refreshToken: cred.refresh_token, grantType: 'refresh_token' }
  });
  if (res.status === 401 || res.status === 403) {
    throw new OfmError(Codes.AUTH, 'Cline 续期失败，需要重新登录', { status: 401 });
  }
  if (res.status >= 400) throw new OfmError(Codes.UPSTREAM, `Cline 续期失败: ${briefBody(res.text, 200)}`);
  const d = res.json?.data || res.json || {};
  return {
    ...cred,
    access_token: d.accessToken || d.access_token || cred.access_token,
    refresh_token: d.refreshToken || d.refresh_token || cred.refresh_token,
    expires_at: toEpochMs(d.expiresAt ?? d.expire_time, 0) || now() + 3600 * 1000
  };
}

export { normalizeUsage };
