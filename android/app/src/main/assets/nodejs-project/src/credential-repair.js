/**
 * 存量凭据自愈：把登录链路历史上写丢的 TRAE 设备标识补回来。
 *
 * 背景（真机自检报告定位到的根因）：
 *   login-manager 以前把 channel.login.start() 的**外层包装对象**
 *   { loginUrl, session, instructions } 原样当 session 传给 complete，
 *   而 completeLogin 读的是 session.machineId / session.deviceId（在内层）。
 *   于是落库时这两个字段是 undefined，被 JSON.stringify 省略，凭据永久缺字段：
 *     - 模型目录请求头 x-machine-id / x-device-id 为空 → 远端拉取失败（回退兜底目录）；
 *     - 账号体检判 incomplete → usable 0。
 *
 * 为什么可以本地补：machine_id / device_id 是**客户端自造的设备标识**
 *   （newLoginSession() 里 hex32() 随机生成），不来自服务端；上游还会按
 *   generation 轮换 machine_id（deriveRotatingMachineId），说明服务端不严格
 *   绑定登录时那一个值。签到/余额的设备身份更是完全由 uid 派生，与这两个字段无关。
 *   因此缺了就用 uid 确定性派生一对稳定的 32 位 hex，无需让用户重新登录
 *   （默认浏览器回调本来就难连，重登代价很高）。
 *
 * 纪律：
 *   - 只补**缺失/空**字段，绝不覆盖已有值，绝不改动 access_token / refresh_token / uid；
 *   - uid 缺失时不编造（签到要用真 uid，编造会让签到用错身份），只留待重新登录；
 *   - 派生用 sha256 + 固定盐，同一 uid 每次结果一致，避免每次启动换设备触发风控；
 *   - 全程不发网络请求；日志/摘要只含账号 id 与字段名，不含任何凭据值。
 */
import crypto from 'node:crypto';

const DEVICE_FIELDS = ['machine_id', 'device_id'];

function isBlank(v) {
  if (v === undefined || v === null) return true;
  return typeof v === 'string' && v.trim() === '';
}

/** 32 位 hex，与 hex32() 同形状。salt 让 machine_id / device_id 不相等。 */
function deriveDeviceId(uid, salt) {
  return crypto.createHash('sha256').update(`ofm:trae:${salt}:${uid}`).digest('hex').slice(0, 32);
}

/**
 * 补齐单份 TRAE 凭据的设备标识（纯函数，不改入参）。
 * @returns {{ credential: object, added: string[], needsRelogin: boolean }}
 *   added 为本次补上的字段名；needsRelogin 表示 uid 也缺，只能重新登录。
 */
export function repairTraeCredential(cred) {
  if (!cred || typeof cred !== 'object' || Array.isArray(cred)) {
    return { credential: cred, added: [], needsRelogin: false };
  }
  const uid = String(cred.uid ?? '').trim();
  if (!uid) return { credential: cred, added: [], needsRelogin: true };

  let next = cred;
  const added = [];
  for (const field of DEVICE_FIELDS) {
    if (!isBlank(cred[field])) continue;
    if (next === cred) next = { ...cred };
    next[field] = deriveDeviceId(uid, field);
    added.push(field);
  }
  return { credential: next, added, needsRelogin: false };
}

/**
 * 扫描并修复 store 里所有 TRAE 账号的凭据，有变更才写回（幂等）。
 * 只依赖 store.settings.accounts / readCredential / writeCredential。
 * @returns {{ scanned: number, repaired: number, added: string[], accounts: string[], needsRelogin: string[] }}
 */
export function repairStoredCredentials(store, { log = null } = {}) {
  const out = { scanned: 0, repaired: 0, added: [], accounts: [], needsRelogin: [] };
  const accounts = Array.isArray(store?.settings?.accounts) ? store.settings.accounts : [];
  for (const account of accounts) {
    if (account?.provider !== 'trae' || !account.credentialRef) continue;
    out.scanned += 1;
    let cred;
    try {
      cred = store.readCredential(account.credentialRef);
    } catch {
      continue;
    }
    if (!cred || typeof cred !== 'object') continue;

    const { credential, added, needsRelogin } = repairTraeCredential(cred);
    if (needsRelogin) {
      out.needsRelogin.push(account.id);
      continue;
    }
    if (added.length === 0) continue;
    try {
      store.writeCredential(account.credentialRef, credential);
      out.repaired += 1;
      out.accounts.push(account.id);
      for (const f of added) if (!out.added.includes(f)) out.added.push(f);
      log?.log?.(`[ofm] 凭据自愈：${account.id} 补齐 ${added.join('、')}`);
    } catch (e) {
      log?.warn?.(`[ofm] 凭据自愈写回失败：${String(e?.message || e).slice(0, 120)}`);
    }
  }
  return out;
}
