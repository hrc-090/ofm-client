/**
 * ZCode（智谱）— 服务端中介的设备授权，上游是 Anthropic 协议（§5.8）
 */
import crypto from 'node:crypto';
import { request, briefBody } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { openUpstream, iterateSse } from '../../http-client.js';
import { toAnthropicRequest, consumeAnthropicStream } from '../../anthropic-compat.js';
import { ensureCredential } from '../credential.js';
import { now, randomHex } from '../../util.js';

const ORIGIN = 'https://zcode.z.ai';
const APP_VERSION = '3.14.3';

export class ZCodeChannel {
  constructor() {
    this.id = 'zcode';
    this.name = 'zcode';
    this.displayName = 'ZCode';
    this.loginMode = 'device';
    this.requiresAccount = true;
    this.supported = true;
    this.note = '设备授权（无需装 ZCode IDE）';
  }

  credential(store, account, opts = {}) {
    return ensureCredential(store, account, { ...opts }); // 无 refresh 端点
  }

  login = {
    start: async () => {
      const sessionKey = randomHex(32);
      const res = await request(`${ORIGIN}/api/v1/oauth/cli/init`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionKey}` },
        body: { provider: 'bigmodel' },
        timeoutMs: 30000
      });
      const d = res.json?.data || res.json || {};
      if (!d.flow_id || !d.authorize_url) {
        throw new OfmError(Codes.UPSTREAM, `ZCode 登录初始化失败: ${briefBody(res.text, 200)}`);
      }
      return {
        loginUrl: d.authorize_url,
        session: {
          flowId: d.flow_id,
          pollToken: d.poll_token || sessionKey,
          sessionKey,
          interval: (Number(d.poll_interval_sec) || 2) * 1000,
          lastPoll: 0,
          expiresAt: now() + (Number(d.expires_in) || 600) * 1000
        },
        instructions: '在浏览器完成授权后自动返回'
      };
    },
    poll: async (session) => {
      if (Date.now() > session.expiresAt) return { done: true, success: false, error: '授权已超时' };
      if (Date.now() - session.lastPoll < session.interval) return { done: false, status: 'waiting' };
      session.lastPoll = Date.now();

      const res = await request(`${ORIGIN}/api/v1/oauth/cli/poll/${session.flowId}`, {
        headers: {
          authorization: `Bearer ${session.pollToken}`,
          accept: 'application/json'
        },
        timeoutMs: 20000
      });
      const d = res.json?.data || res.json || {};
      if (d.status === 'pending') return { done: false, status: 'waiting' };
      if (d.status !== 'ready') {
        return { done: true, success: false, error: `授权失败: ${d.status || res.status}` };
      }
      const token = d.token || d.bigmodel?.access_token;
      if (!token) return { done: true, success: false, error: '授权响应缺少 token' };

      const deviceMid = crypto.randomUUID();
      return {
        done: true,
        success: true,
        nickname: d.user?.name || d.user?.email || 'ZCode 账号',
        expiresAt: now() + 7 * 86400000,
        credential: {
          zcode_jwt: token,
          access_token: token,
          refresh_token: d.bigmodel?.refresh_token,
          device_mid: deviceMid,
          user_id: d.user?.id,
          app_version: APP_VERSION,
          expires_at: now() + 7 * 86400000
        }
      };
    }
  };

  async listModels() {
    const res = await request(`${ORIGIN}/api/v1/client/configs?app_version=${APP_VERSION}&platform=unknown`, {
      timeoutMs: 30000
    });
    if (res.status >= 400) return [];
    const list = res.json?.data?.builtinModels || res.json?.data?.builtin_models || [];
    return (Array.isArray(list) ? list : []).map((m) => ({
      id: m.id || m.model,
      displayName: m.name || m.display_name || m.id,
      contextWindow: m.context_window || m.contextWindow,
      multimodal: Boolean(m.vision),
      reasoning: Boolean(m.thinking)
    }));
  }

  async *stream(req, { credential, signal }) {
    const body = toAnthropicRequest(req, { maxTokens: 8192 });
    const res = await openUpstream(`${ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
        'user-agent': `ZCode/${APP_VERSION}`,
        'http-referer': 'https://zcode.z.ai',
        'x-zcode-app-version': APP_VERSION,
        'x-release-channel': 'stable',
        'x-client-language': 'zh-CN',
        'x-client-timezone': 'Asia/Shanghai',
        'x-device-mid': credential.device_mid,
        'x-platform': 'win32',
        'x-os-category': 'windows',
        authorization: `Bearer ${credential.zcode_jwt}`
      },
      body: JSON.stringify(body),
      timeoutMs: 60000,
      signal
    });
    if (res.status >= 400) {
      const text = await res.text();
      throw new OfmError(
        res.status === 401 || res.status === 403 ? Codes.AUTH : Codes.UPSTREAM,
        `ZCode HTTP ${res.status}: ${text.slice(0, 200)}`,
        { status: res.status }
      );
    }
    yield* consumeAnthropicStream(iterateSse(res.raw, { idleTimeoutMs: 120000, signal }));
  }
}
