/**
 * 账号 / 凭据体检（纯本地、脱敏、不发任何网络请求）。
 *
 * 为什么需要它：网络自检只能证明 DNS/TCP/TLS/HTTPS 可达，但「模型目录为空」
 * 「余额查询失败」还有一类与网络完全无关的原因 —— 清空过应用数据后没有
 * 已登录账号、登录卡在 pending、凭据文件丢了、或字段不全（TRAE 签到要 uid，
 * 模型目录要 machine_id/device_id）。这些情况下网络再好也不会有数据。
 *
 * 把这一层并进 /api/network/diagnose，用户点一次「网络自检」就能同时排除
 * 两个变量：网络通不通、账号能不能用。
 *
 * 安全：只输出字段名和布尔状态，绝不输出 token / refresh_token / 昵称 / 手机号。
 */
const TOKEN_KEYS = ['access_token', 'token', 'zcode_jwt', 'security_oauth_token'];

/** 各渠道特有的必需字段。不确定的渠道不臆造，只查通用 token 键。 */
const EXTRA_REQUIRED = {
  trae: ['uid', 'machine_id', 'device_id']
};

function finiteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function hasValue(cred, key) {
  const v = cred?.[key];
  if (v === undefined || v === null) return false;
  return typeof v === 'string' ? v.trim() !== '' : true;
}

function expiryOf(account, cred) {
  const candidates = [account?.expiresAt, cred?.expires_at, cred?.expiresAt];
  for (const c of candidates) {
    const n = finiteNumber(c);
    if (n !== undefined && n > 0) return n;
  }
  return null;
}

function describeOne(account, store, nowMs) {
  const provider = String(account?.provider || 'unknown');
  const ref = account?.credentialRef;
  const cred = ref ? store.readCredential?.(ref) : null;
  const hasCredential = Boolean(cred && typeof cred === 'object');

  const present = [];
  if (hasCredential) {
    for (const k of Object.keys(cred)) {
      // 只收字段名，绝不收值
      if (typeof k === 'string' && k.length <= 40) present.push(k);
    }
  }
  present.sort();

  // token 只要任意一个已知键有值就算有
  const hasToken = TOKEN_KEYS.some((k) => hasValue(cred, k));
  const missing = hasCredential
    ? [...(hasToken ? [] : ['access_token']), ...(EXTRA_REQUIRED[provider] || []).filter((k) => !hasValue(cred, k))]
    : ['access_token'];

  const exp = expiryOf(account, cred);
  const expiresInHours = exp === null ? null : Math.round(((exp - nowMs) / 3600000) * 10) / 10;
  const expired = expiresInHours !== null && expiresInHours <= 0;

  let state;
  if (account?.pending === true) state = 'pending';
  else if (account?.needsLogin === true) state = 'needs-login';
  else if (account?.enabled === false) state = 'disabled';
  else if (!hasCredential) state = 'no-credential';
  else if (missing.length > 0) state = 'incomplete';
  else if (expired) state = 'expired';
  else state = 'ok';

  return {
    provider,
    state,
    hasCredential,
    fields: present,
    missing,
    expired,
    expiresInHours
  };
}

function makeHint(rows, count, usable) {
  if (count === 0) {
    return '没有已登录账号：模型目录为空、余额/签到失败都是正常的。请先在 App 里连接渠道并完成登录。';
  }
  const pending = rows.filter((r) => r.state === 'pending').length;
  const needsLogin = rows.filter((r) => r.state === 'needs-login').length;
  const noCred = rows.filter((r) => r.state === 'no-credential').length;
  const incomplete = rows.filter((r) => r.state === 'incomplete');
  const expired = rows.filter((r) => r.state === 'expired').length;

  if (usable === 0 && pending > 0) {
    return '账号仍在登录中（pending）：完成回调 / 粘贴链接后才会可用。';
  }
  if (needsLogin > 0) {
    return `有 ${needsLogin} 个账号需要重新登录：凭据已失效，请对该渠道重新点「连接」。`;
  }
  if (noCred > 0) {
    return `有 ${noCred} 个账号没有凭据文件（可能被清数据或删除时残留）：删掉该账号重新登录。`;
  }
  if (incomplete.length > 0) {
    const fields = [...new Set(incomplete.flatMap((r) => r.missing))];
    const autoFixable = fields.filter((f) => f === 'machine_id' || f === 'device_id');
    const manual = fields.filter((f) => !autoFixable.includes(f));
    // machine_id / device_id 是客户端自造的设备标识，新版会在启动 / 自检时
    // 自动补齐并写回，不必重新登录（默认浏览器回调本来就难连）。
    // uid / access_token 只能由登录返回，缺了才真的需要重连。
    if (manual.length > 0) {
      return `凭据缺字段（${manual.join('、')}）：这类字段只能由登录返回，请对该渠道重新点「连接」。`
        + (autoFixable.length ? `另外 ${autoFixable.join('、')} 会自动补齐，无需处理。` : '');
    }
    return `凭据缺 ${autoFixable.join('、')}：这是旧版登录链路写丢的设备标识，新版会在启动或点「网络自检」时自动补齐，无需重新登录；补齐后点「重新拉取」即可。`;
  }
  if (usable === 0) {
    return '没有可用账号（被禁用或状态异常）：检查账号开关，或重新登录。';
  }
  if (expired > 0) {
    return `${usable} 个账号可用，其中 ${expired} 个 token 已过期；请求时会自动续期，若仍失败请重新登录。`;
  }
  return `${usable} 个账号与凭据完整。网络全通过时若模型/余额仍失败，请看「可用模型」上方的 HTTP 状态或余额卡片的错误原因（多半是上游 401 / 业务码）。`;
}

/**
 * @param {object} opts
 * @param {object} opts.store 需提供 settings.accounts 与 readCredential(ref)
 * @param {number} opts.nowMs 当前时间（注入以便测试）
 */
export function describeAccounts({ store, nowMs = Date.now() } = {}) {
  const accounts = Array.isArray(store?.settings?.accounts) ? store.settings.accounts : [];
  const rows = accounts.map((a) => describeOne(a, store, nowMs));
  const usable = rows.filter(
    (r) => !['pending', 'needs-login', 'disabled', 'no-credential', 'incomplete'].includes(r.state)
  ).length;
  return {
    count: accounts.length,
    usable,
    accounts: rows,
    hint: makeHint(rows, accounts.length, usable)
  };
}
