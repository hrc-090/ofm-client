/**
 * Loomy — 短信验证码 + HMAC-SHA1 签名（§5.5）
 * 没有刷新端点，过期只能重登。
 */
import crypto from 'node:crypto';
import { request, briefBody } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { openAiCompatStream } from '../../openai-compat.js';
import { toOpenAiMessages, toOpenAiTools } from '../../convert/openai-chat.js';
import { ensureCredential } from '../credential.js';
import { randomHex, now } from '../../util.js';

const API = 'https://loomyad.xunfei.cn/api/v1';
const ACCOUNT = 'https://account.xfinfr.com';
const AK = '2thryby66wxi53sk';
const SK = 'zsak6eadrbawz683wf5r3m2snrwj868r';
const APPID = 'GM3LOOMY';
const UA = 'Loomy|Desktop|Electron|macOS';

function rfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function escapePath(pathname) {
  let p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.split('/').map(rfc3986).join('/');
}

function escapeQuery(query) {
  if (!query) return '';
  return Object.entries(query)
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v === null || v === undefined ? '' : String(v))}`)
    .join('&');
}

/** 9 段签名串，末尾两段恒为空串 → 以 \n\n 结尾 */
export function stringToSign({ method, path, query, body, contentType }) {
  const contentMd5 = body ? crypto.createHash('md5').update(body).digest('base64') : '';
  const date = new Date().toUTCString();
  const nonce = crypto.randomUUID();
  const sts = [
    method.toUpperCase(),
    escapePath(path),
    escapeQuery(query),
    contentMd5,
    contentType || '',
    date,
    nonce,
    '',
    ''
  ].join('\n');
  return { sts, date, nonce, contentMd5 };
}

export function signedHeaders({ method, path, query, body }) {
  const contentType = body ? 'application/json' : '';
  const { sts, date, nonce, contentMd5 } = stringToSign({ method, path, query, body, contentType });
  const signature = crypto.createHmac('sha1', SK).update(sts).digest('base64');
  return {
    date,
    nonce,
    authorization: `account ${AK}:${signature}`,
    ...(contentType ? { 'content-type': contentType } : {}),
    // ⚠️ 服务端按「收到的 Content-MD5 头」重建 9 行规范串，不是自己重算 body。
    // 签名里算了 contentMd5 却不发这个头 → 上游 401 HMAC signature does not match。
    // sendMsgCode / checkCode 共用 signedPost，漏这一个头会让整个短信登录完全发不出去。
    ...(contentMd5 ? { 'content-md5': contentMd5 } : {}),
    'user-agent': UA
  };
}

function envelope(param) {
  return {
    base: {
      appid: APPID,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      ua: UA,
      traceid: randomHex(16)
    },
    param
  };
}

async function signedPost(baseUrl, path, param, doRequest = request) {
  const body = JSON.stringify(envelope(param));
  // ⚠️ 签名用的 body 串与发送的必须是同一个
  const headers = signedHeaders({ method: 'POST', path, query: null, body });
  const res = await doRequest(`${baseUrl}${path}`, { method: 'POST', headers, body, timeoutMs: 30000 });
  return res;
}

const CLIENT_VERSION = '0.9.38';

/** 模型网关每个请求必备的头。缺 traceparent 上游会一直挂到超时（PROTOCOL §2）。 */
export function buildChatHeaders(credential) {
  const token = credential?.access_token || '';
  return {
    authorization: `Bearer ${token}`,
    token, // 小写 token 与 Bearer 两种拼写都发
    traceparent: `00-${randomHex(16)}-${randomHex(8)}-01`,
    'loomy-version': CLIENT_VERSION // 仅检查存在
  };
}

export class LoomyChannel {
  constructor() {
    this.id = 'loomy';
    this.name = 'loomy';
    this.displayName = 'Loomy';
    this.loginMode = 'sms';
    this.requiresAccount = true;
    this.supported = true;
    this.note = '短信验证码登录（14 天内免重登）';
    // 测试注入点：替换真实 HTTP，保持纯 mock 可测
    this.requestImpl = null;
  }

  credential(store, account, opts = {}) {
    return ensureCredential(store, account, { ...opts }); // 无刷新端点
  }

  login = {
    start: async () => ({
      loginUrl: '',
      session: { phone: '', msgId: '' },
      instructions: '输入手机号获取验证码'
    }),
    poll: async () => ({ done: false, status: 'need-sms' }),
    sendCode: async (session, phone) => {
      const res = await signedPost(ACCOUNT, '/login/phone/sendMsgCode', { ccode: '86', phone, expire: 300 }, this.requestImpl || request);
      const msgId = res.json?.data?.msgid || res.json?.msgid || res.json?.data?.msgId;
      if (res.status >= 400 || !res.json) {
        throw new OfmError(Codes.UPSTREAM, `发送验证码失败: ${briefBody(res.text, 200)}`);
      }
      session.phone = phone;
      session.msgId = msgId || '';
      return { ok: true, msgId: session.msgId };
    },
    verifyCode: async (session, { phone, code, msgId }) => {
      const res = await signedPost(ACCOUNT, '/login/phone/checkCode', {
        ccode: '86',
        phone: phone || session.phone,
        mcode: code,
        msgid: msgId || session.msgId,
        expire: 1209600
      }, this.requestImpl || request);
      const d = res.json?.data || res.json || {};
      const sessionToken = d.session || d.token || d.access_token;
      if (res.status >= 400 || !sessionToken) {
        return { success: false, error: `验证码校验失败: ${briefBody(res.text, 200)}` };
      }
      const expiresAt = now() + 14 * 86400000;
      return {
        success: true,
        nickname: `Loomy ${phone || session.phone}`,
        expiresAt,
        credential: {
          access_token: sessionToken,
          userid: d.userid || d.userId,
          phone: phone || session.phone,
          expires_at: expiresAt
        }
      };
    }
  };

  async listModels({ credential } = {}) {
    const token = credential?.access_token;
    // 目录端点认小写 token；以前恒发 'unused'，上游回 code=100002「缺少 token」
    // 却仍是 HTTP 200，于是永远走兜底目录。没有凭据时保持兜底行为。
    const res = token
      ? await (this.requestImpl || request)(`${API}/models`, {
          headers: { token, authorization: `Bearer ${token}` },
          timeoutMs: 20000
        }).catch(() => null)
      : null;
    const fallback = [
      { id: 'loomy-chat', displayName: 'Loomy Chat' },
      { id: 'loomy-reasoner', displayName: 'Loomy Reasoner', reasoning: true }
    ];
    if (!res || res.status >= 400) return fallback;
    const list = res.json?.data?.models || res.json?.models || res.json?.data || [];
    if (!Array.isArray(list) || !list.length) return fallback;
    return list.map((m) => ({ id: m.id || m.model, displayName: m.name || m.id, contextWindow: m.contextWindow }));
  }

  async *stream(req, { credential, signal }) {
    // 聊天只认 Bearer；其余端点只认小写 token —— 两个都发
    yield* openAiCompatStream({
      url: `${API}/chat/completions`,
      headers: buildChatHeaders(credential),
      body: {
        model: req.modelId,
        messages: toOpenAiMessages(req.messages),
        tools: toOpenAiTools(req.tools),
        stream: true,
        max_tokens: req.maxTokens || undefined
      },
      onHttpError: (status, text) =>
        status === 401
          ? new OfmError(Codes.AUTH, 'Loomy 登录态已过期（无刷新端点），请重新登录', { status: 401 })
          : new OfmError(Codes.UPSTREAM, `Loomy HTTP ${status}: ${briefBody(text, 200)}`, { status }),
      signal
    });
  }
}
