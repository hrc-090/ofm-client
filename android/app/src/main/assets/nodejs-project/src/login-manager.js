/**
 * 登录会话管理（§5.0 两步式）。
 *
 * 统一契约：
 *   POST /api/accounts {provider}  → {accountId, loginUrl, mode}   立刻返回
 *   前端打开 loginUrl，每 1s GET /api/login/poll?accountId=        直到 done
 *   本地回调类渠道由 WebView 拦截 URL 后 POST /api/accounts/:id/callback
 *
 * 占位账号先入池、失败必须删除 —— 否则会留下「发不出请求」的幽灵账号。
 */
import { randomHex, now } from './util.js';
import { OfmError, Codes } from './errors.js';

export function createLoginManager({ store, registry, settings, log = console, onAccountReady = null }) {
  const sessions = new Map();

  function newIds(provider) {
    const suffix = randomHex(4);
    return {
      accountId: `${provider}-${suffix}`,
      credentialRef: `${provider.toUpperCase()}_ACCOUNT_${suffix.toUpperCase()}`
    };
  }

  function finalize(accountId, result) {
    const account = store.findAccount(accountId);
    if (!account) throw new OfmError(Codes.INVALID_REQUEST, '账号不存在或登录会话已失效');
    if (!result?.credential) throw new OfmError(Codes.UPSTREAM, '登录成功但没有拿到凭据');

    store.writeCredential(account.credentialRef, result.credential);
    store.upsertAccount({
      ...account,
      nickname: result.nickname || account.nickname,
      expiresAt: result.expiresAt || result.credential.expires_at || undefined,
      refreshable: result.refreshable !== false,
      pending: false,
      needsLogin: false,
      enabled: true,
      createdAt: account.createdAt || now()
    });
    sessions.delete(accountId);
    const saved = store.findAccount(accountId);
    try { onAccountReady?.(saved); } catch { /* 预热失败不该让登录失败 */ }
    return saved;
  }

  return {
    sessions,

    async start(provider) {
      const channel = registry.get(provider);
      if (!channel.login || channel.loginMode === 'none') {
        throw new OfmError(Codes.UNSUPPORTED, `${channel.displayName} 暂不支持在 App 内登录`);
      }
      const { accountId, credentialRef } = newIds(provider);
      const account = {
        id: accountId,
        provider,
        nickname: '登录中…',
        enabled: true,
        credentialRef,
        createdAt: now(),
        refreshable: true,
        pending: true
      };
      store.upsertAccount(account);

      try {
        const raw = await channel.login.start({ accountId, account, store, settings });
        // ⚠️ 渠道的 start() 有两种返回风格：扁平 session，或
        //   { loginUrl, session, instructions } 包装层（TRAE / Qoder / LobsterAI…）。
        //   以前直接把整个包装对象当 session 存起来，于是 complete/poll 拿到的
        //   是外层：completeLogin 读 session.machineId 得到 undefined，落库时
        //   machine_id / device_id 被 JSON.stringify 省略 → 凭据永久缺字段，
        //   模型目录请求头 x-machine-id 为空（账号体检报 incomplete）。
        //   Qoder 的 nonce / LobsterAI 的 state 也同理读不到。
        //   这里统一摊平成**单个** session 对象：内层实现字段 + 外层 UI 元数据。
        //   渠道把状态（result / lastPoll…）挂在传入对象上，摊平后仍是同一引用，自洽。
        const inner =
          raw && typeof raw === 'object' && raw.session && typeof raw.session === 'object'
            ? raw.session
            : null;
        const session = inner ? { ...inner, ...raw } : raw;
        if (inner) delete session.session;
        sessions.set(accountId, { accountId, provider, channel, session, createdAt: now() });
        return {
          accountId,
          provider,
          mode: channel.loginMode,
          loginUrl: session.loginUrl,
          userCode: session.userCode,
          instructions: session.instructions
        };
      } catch (e) {
        store.removeAccount(accountId);
        throw e;
      }
    },

    async poll(accountId) {
      const rec = sessions.get(accountId);
      if (!rec) {
        const acc = store.findAccount(accountId);
        if (acc && !acc.pending) return { done: true, success: true, account: acc };
        throw new OfmError(Codes.INVALID_REQUEST, '登录会话不存在或已过期');
      }
      let r;
      try {
        r = await rec.channel.login.poll(rec.session, { store, settings });
      } catch (e) {
        // 网络抖动不销毁会话；只有明确的失败才收尾
        if (e?.code === Codes.TRANSPORT || e?.code === Codes.TIMEOUT) {
          return { done: false, status: 'waiting', error: e.message };
        }
        store.removeAccount(accountId);
        sessions.delete(accountId);
        throw e;
      }
      if (!r?.done) return { done: false, status: r?.status || 'pending', userCode: r?.userCode };
      if (!r.success) {
        store.removeAccount(accountId);
        sessions.delete(accountId);
        return { done: true, success: false, error: r.error || '授权失败或被取消' };
      }
      const account = finalize(accountId, r);
      return { done: true, success: true, account };
    },

    async completeCallback(accountId, url) {
      const rec = sessions.get(accountId);
      if (!rec) throw new OfmError(Codes.INVALID_REQUEST, '登录会话不存在或已过期');
      if (!rec.channel.login.complete) {
        throw new OfmError(Codes.INVALID_REQUEST, '该渠道使用设备码登录，无需回调链接');
      }
      const r = await rec.channel.login.complete(rec.session, url, { store, settings });
      if (!r?.success) {
        store.removeAccount(accountId);
        sessions.delete(accountId);
        throw new OfmError(Codes.AUTH, r?.error || '回调链接无效');
      }
      const account = finalize(accountId, r);
      return { done: true, success: true, account };
    },

    async smsSend(accountId, phone) {
      const rec = sessions.get(accountId);
      if (!rec?.channel.login.sendCode) throw new OfmError(Codes.UNSUPPORTED, '该渠道不支持短信登录');
      return rec.channel.login.sendCode(rec.session, phone, { store, settings });
    },

    async smsVerify(accountId, { phone, code, msgId }) {
      const rec = sessions.get(accountId);
      if (!rec?.channel.login.verifyCode) throw new OfmError(Codes.UNSUPPORTED, '该渠道不支持短信登录');
      const r = await rec.channel.login.verifyCode(rec.session, { phone, code, msgId }, { store, settings });
      if (!r?.success) throw new OfmError(Codes.AUTH, r?.error || '验证码不正确');
      const account = finalize(accountId, r);
      return { done: true, success: true, account };
    },

    cancel(accountId) {
      const rec = sessions.get(accountId);
      if (rec) sessions.delete(accountId);
      store.removeAccount(accountId);
    }
  };
}
