/**
 * 出站地址安全检查（SSRF）。
 *
 * 两类地址区别对待：
 *  - **用户自己配的搜索/读取接口**（settings 里填的 URL）：只校验协议，
 *    允许局域网（自建 SearXNG 常在 192.168.x）—— 它是用户主动填的，不是外部输入；
 *  - **搜索结果里的 URL**（`/v1/read` 的入参）：外部输入，必须拦私网/回环/云元数据，
 *    否则第三方客户端能借这个接口扫本机端口和路由器后台。
 */
import dns from 'node:dns';

const BLOCKED_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data'
]);

function ipv4Blocked(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 保留 / TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播 / 保留
  return false;
}

function ipv6Blocked(raw) {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true;
  // ::ffff:127.0.0.1 这类映射地址按 IPv4 再判一次
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

function hostBlocked(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_NAMES.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (h.startsWith('[') || h.includes(':')) return ipv6Blocked(h);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return ipv4Blocked(h);
  return false;
}

function isMetadataHost(host) {
  const h = String(host || '').toLowerCase();
  if (h === '169.254.169.254' || h === 'metadata.google.internal' || h === 'metadata') return true;
  return h.startsWith('169.254.');
}

export class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
    this.code = 'SSRF_BLOCKED';
  }
}

/**
 * 校验一个 URL 能不能抓。
 * @param {string} urlStr
 * @param {{allowPrivate?: boolean, selfPort?: number}} [opts]
 */
export function assertSafeUrl(urlStr, opts = {}) {
  let u;
  try {
    u = new URL(String(urlStr || '').trim());
  } catch {
    throw new SsrfError('地址不是合法 URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError(`只允许 http/https，收到 ${u.protocol}`);
  }
  if (u.username || u.password) throw new SsrfError('URL 里不允许带用户名密码');
  // 云元数据地址即使放开内网也不许读：它不是「用户的局域网」，是凭据泄露面
  if (isMetadataHost(u.hostname)) throw new SsrfError('拒绝访问云元数据地址');
  if (opts.allowPrivate) return u;

  if (hostBlocked(u.hostname)) throw new SsrfError('拒绝访问本机/内网地址');
  if (opts.selfPort && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === Number(opts.selfPort)) {
    throw new SsrfError('拒绝读取本机 API 自己（会死循环）');
  }
  return u;
}

/**
 * 域名解析后二次校验：挡住「域名指向 127.0.0.1」这类绕过。
 * DNS 查询失败不算 SSRF（后面连接自然会失败），但要给出可读原因。
 */
export function assertResolvedSafe(host) {
  return new Promise((resolve, reject) => {
    const h = String(host || '').replace(/^\[|\]$/g, '');
    if (hostBlocked(h)) {
      reject(new SsrfError('拒绝访问本机/内网地址'));
      return;
    }
    dns.lookup(h, { all: true }, (err, list) => {
      if (err) {
        resolve([{ address: h, family: 0 }]);
        return;
      }
      for (const item of list || []) {
        const bad = String(item.address).includes(':') ? ipv6Blocked(item.address) : ipv4Blocked(item.address);
        if (bad) {
          reject(new SsrfError(`域名解析到内网地址（${item.address}）`));
          return;
        }
      }
      resolve(list || []);
    });
  });
}
