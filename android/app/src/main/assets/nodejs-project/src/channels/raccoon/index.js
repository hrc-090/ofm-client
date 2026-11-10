/**
 * Raccoon（商汤小浣熊）— 微信扫码登录（§5.6）
 * 任何异常都降级为 pending，不要中断轮询。
 */
import { request, briefBody } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { openAiCompatStream } from '../../openai-compat.js';
import { toOpenAiMessages, toOpenAiTools } from '../../convert/openai-chat.js';
import { ensureCredential } from '../credential.js';
import { randomHex, now } from '../../util.js';

const API = 'https://xiaohuanxiong.com';
const AUTH = '/api/web/auth/v1';
const LLM = '/api/web/llm/v2';

export class RaccoonChannel {
  constructor() {
    this.id = 'raccoon';
    this.name = 'raccoon';
    this.displayName = 'Raccoon';
    this.loginMode = 'qrcode';
    this.requiresAccount = true;
    this.supported = true;
    this.note = '微信扫码登录';
  }

  credential(store, account, opts = {}) {
    return ensureCredential(store, account, { refresh: refreshRaccoon, ...opts });
  }

  login = {
    start: async () => {
      const code = randomHex(16); // 32 hex，客户端自造即可
      return {
        loginUrl: `${API}/login/mp?code=${code}&appname=${encodeURIComponent('商汤小浣熊官网')}`,
        session: { code, lastPoll: 0 },
        instructions: '用微信扫码，页面提示成功后会自动完成'
      };
    },
    poll: async (session) => {
      if (Date.now() - session.lastPoll < 2000) return { done: false, status: 'waiting' };
      session.lastPoll = Date.now();
      try {
        const res = await request(`${API}${AUTH}/login_with_qrcode_code`, {
          method: 'POST',
          body: { qrcode_code: session.code },
          timeoutMs: 15000
        });
        const d = res.json?.data || {};
        const status = d.status;
        if (status === 'success' && d.access_token) {
          return {
            done: true,
            success: true,
            nickname: d.nickname || d.office_identity || 'Raccoon 账号',
            credential: {
              access_token: d.access_token,
              refresh_token: d.refresh_token,
              office_identity: d.office_identity,
              expires_at: now() + 7 * 86400000
            }
          };
        }
        if (status === 'canceled' || status === 'expired') {
          return { done: true, success: false, error: status === 'expired' ? '二维码已过期' : '已取消授权' };
        }
        return { done: false, status: status || 'pending' };
      } catch {
        // 网络/畸形/未知状态一律继续等
        return { done: false, status: 'pending' };
      }
    }
  };

  async listModels({ credential }) {
    const res = await request(`${API}${LLM}/model_catalog`, {
      headers: {
        authorization: `Bearer ${credential.access_token}`,
        'x-org-code': credential.office_identity || '',
        'x-raccoon-language': 'zh'
      },
      timeoutMs: 30000
    });
    if (res.status >= 400) throw new OfmError(Codes.UPSTREAM, `Raccoon 模型目录失败: ${briefBody(res.text, 200)}`);
    const list = res.json?.data?.models || res.json?.data || res.json?.models || [];
    return (Array.isArray(list) ? list : []).map((m) => ({
      id: m.id || m.model || m.name,
      displayName: m.name || m.displayName || m.id,
      contextWindow: m.contextWindow || m.max_input_tokens,
      multimodal: Boolean(m.vision || m.supports_vision),
      reasoning: Boolean(m.reasoning || m.supports_thinking)
    }));
  }

  async *stream(req, { credential, signal }) {
    yield* openAiCompatStream({
      url: `${API}${LLM}/chat/completions`,
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${credential.access_token}`,
        'x-org-code': credential.office_identity || '',
        'x-raccoon-language': 'zh',
        'x-client-platform': 'desktop-windows'
      },
      body: {
        model: req.modelId,
        messages: toOpenAiMessages(req.messages),
        tools: toOpenAiTools(req.tools),
        stream: true,
        max_tokens: req.maxTokens || undefined,
        // 思考开关必须放 extra_body，放顶层会被静默忽略
        extra_body: req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : undefined
      },
      onHttpError: (status, text) =>
        status === 401
          ? new OfmError(Codes.AUTH, 'Raccoon 登录态失效，请重新扫码', { status: 401 })
          : new OfmError(Codes.UPSTREAM, `Raccoon HTTP ${status}: ${briefBody(text, 200)}`, { status }),
      signal
    });
  }
}

async function refreshRaccoon(cred) {
  if (!cred.refresh_token) throw new OfmError(Codes.AUTH, 'Raccoon 凭据无 refresh_token', { status: 401 });
  const res = await request(`${API}${AUTH}/refresh_token`, {
    method: 'POST',
    body: { refresh_token: cred.refresh_token },
    timeoutMs: 20000
  });
  if (res.status >= 400) throw new OfmError(Codes.AUTH, 'Raccoon 续期失败，请重新扫码', { status: 401 });
  const d = res.json?.data || res.json || {};
  return {
    ...cred,
    access_token: d.access_token || cred.access_token,
    refresh_token: d.refresh_token || cred.refresh_token,
    expires_at: now() + 7 * 86400000
  };
}
