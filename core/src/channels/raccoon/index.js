/**
 * Raccoon（商汤小浣熊）
 *
 * 登录：**官网网页登录 → 自动导入 Cookie 里的会话 token**
 *   官方扫码落地页 /login/mp 目前是 404（2026-11 实测），
 *   官方 IAM 扫码接口虽然还在，但扫码后跳的就是那个 404 页，走不通。
 *   所以这里不再拼 `login/mp?code=…`（那是本地随便生成的假 code，
 *   官网根本不认，打开必然 404），改为在 App 内打开 /login，
 *   用户在网页里用手机号验证码/密码登录，登录成功后网页会种下
 *   `xhx_token`（旧版网页会话）和 `raccoon_token`（IAM 会话），
 *   我们把 Cookie 带回来，**用模型目录接口逐个验活**，
 *   只有真能调的 token 才会被写成凭据。
 *
 * 任何异常都降级为 pending / 可读错误，不要中断会话。
 */
import { request, briefBody } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { openAiCompatStream } from '../../openai-compat.js';
import { toOpenAiMessages, toOpenAiTools } from '../../convert/openai-chat.js';
import { ensureCredential } from '../credential.js';
import { now } from '../../util.js';

const API = 'https://xiaohuanxiong.com';
const AUTH = '/api/web/auth/v1';
const LLM = '/api/web/llm/v2';
/** 本地 /raccoon/login 最终落地页：官网登录页本身是好的（只有 /login/mp 挂了） */
export const RACCOON_LOGIN_TARGET = `${API}/login`;

/** 网页登录后会种下的会话 cookie，按「最可能可用」排序 */
const TOKEN_COOKIES = ['xhx_token', 'raccoon_token', 'access_token'];

/** "a=1; b=2" / "b=2; a=1" / 裸 token 都能吃 */
export function parseCookieHeader(raw) {
  const out = {};
  if (typeof raw !== 'string') return out;
  const text = raw.trim();
  if (!text) return out;
  for (const part of text.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    if (!name) continue;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      // 网页会 encodeURIComponent 后写入，双重编码时只解一层
      if (/%[0-9a-f]{2}/i.test(value)) value = decodeURIComponent(value);
    } catch {
      /* 解不开就用原文 */
    }
    if (value) out[name] = value;
  }
  return out;
}

/** 从 Cookie 串 / 裸 token 里挑出候选 token，按优先级去重 */
export function tokenCandidates(raw) {
  const cookies = parseCookieHeader(raw);
  const list = [];
  for (const name of TOKEN_COOKIES) {
    if (cookies[name]) list.push({ source: name, token: cookies[name] });
  }
  if (list.length === 0) {
    const bare = typeof raw === 'string' ? raw.trim() : '';
    // 裸 token 通常没有 '='；有 '=' 说明是 Cookie 串但没命中已知名字
    if (bare && !bare.includes('=') && !bare.includes(';')) list.push({ source: 'pasted', token: bare });
  }
  const seen = new Set();
  return list.filter((c) => (seen.has(c.token) ? false : (seen.add(c.token), true)));
}

function llmHeaders(token, officeIdentity) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-org-code': officeIdentity || '',
    'x-raccoon-language': 'zh',
    'x-client-platform': 'desktop-windows'
  };
}

export class RaccoonChannel {
  constructor() {
    this.id = 'raccoon';
    this.name = 'raccoon';
    this.displayName = 'Raccoon';
    this.loginMode = 'cookie';
    this.requiresAccount = true;
    this.supported = true;
    this.note = '网页登录后自动导入（扫码页官方已 404）';
  }

  credential(store, account, opts = {}) {
    return ensureCredential(store, account, { refresh: refreshRaccoon, ...opts });
  }

  login = {
    start: async () => ({
      // 相对路径：由本机服务补成 http://127.0.0.1:<port>/raccoon/login。
      // 不能直接把官网 /login/mp 丢给浏览器 —— 那个落地页官方已经 404。
      loginUrl: '/raccoon/login',
      session: {},
      instructions: '用手机号验证码或密码登录，登录成功后会自动导入凭据'
    }),
    // cookie 模式下 App 不轮询；这里保持契约完整，永不 done。
    poll: async () => ({ done: false, status: 'waiting' }),
    /**
     * App 从 WebView 里取到 Cookie 后调用。
     * 只认「模型目录能真的调通」的 token，避免把过期会话写进凭据。
     */
    cookie: async (session, raw) => {
      const candidates = tokenCandidates(raw);
      if (candidates.length === 0) {
        return { success: false, error: '没读到登录凭据，请确认网页里已经登录成功' };
      }
      const cookies = parseCookieHeader(raw);
      let lastError = '';
      for (const c of candidates) {
        let probe;
        try {
          probe = await request(`${API}${LLM}/model_catalog`, {
            headers: llmHeaders(c.token),
            timeoutMs: 20000
          });
        } catch (e) {
          lastError = e?.message || String(e);
          continue;
        }
        if (probe.status >= 400) {
          lastError = `HTTP ${probe.status}`;
          continue;
        }
        const body = probe.json || {};
        const list = body?.data?.models || body?.data || body?.models;
        if (!Array.isArray(list)) {
          lastError = '模型目录返回格式异常';
          continue;
        }
        const profile = await readProfile(c.token);
        return {
          success: true,
          nickname: profile.name || 'Raccoon 账号',
          credential: {
            access_token: c.token,
            refresh_token: cookies.raccoon_refresh_token || cookies.refresh_token,
            office_identity: profile.office_identity,
            expires_at: now() + 7 * 86400000
          }
        };
      }
      return { success: false, error: `登录态无效或已过期（${lastError || '未通过校验'}），请回到网页重新登录` };
    }
  };

  async listModels({ credential }) {
    const res = await request(`${API}${LLM}/model_catalog`, {
      headers: llmHeaders(credential.access_token, credential.office_identity),
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
          ? new OfmError(Codes.AUTH, 'Raccoon 登录态失效，请重新导入凭据', { status: 401 })
          : new OfmError(Codes.UPSTREAM, `Raccoon HTTP ${status}: ${briefBody(text, 200)}`, { status }),
      signal
    });
  }
}

/** 用户资料（昵称 / 组织号）：失败不影响登录，只是少两个字段 */
async function readProfile(token) {
  try {
    const res = await request(`${API}${AUTH}/user_info`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'x-raccoon-language': 'zh' },
      timeoutMs: 12000
    });
    if (res.status >= 400) return {};
    const d = res.json?.data || res.json || {};
    return {
      name: d.name || d.nickname || d.user?.name,
      office_identity: d.office_identity || d.officeIdentity || d.organization?.code || d.office?.code
    };
  } catch {
    return {};
  }
}

async function refreshRaccoon(cred) {
  if (!cred.refresh_token) throw new OfmError(Codes.AUTH, 'Raccoon 凭据无 refresh_token', { status: 401 });
  // 旧版网页接口：refresh_token 换新会话；IAM 会话可能没有 refresh_token，
  // 这时只能提示重新网页登录（不抛 500）。
  const res = await request(`${API}${AUTH}/refresh_token`, {
    method: 'POST',
    body: { refresh_token: cred.refresh_token },
    timeoutMs: 20000
  });
  if (res.status >= 400) throw new OfmError(Codes.AUTH, 'Raccoon 续期失败，请重新网页登录', { status: 401 });
  const d = res.json?.data || res.json || {};
  return {
    ...cred,
    access_token: d.access_token || cred.access_token,
    refresh_token: d.refresh_token || cred.refresh_token,
    expires_at: now() + 7 * 86400000
  };
}
