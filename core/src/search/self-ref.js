/**
 * 自环检测：配置里的「自定义搜索 / 自定义读取」地址如果指向本机 API 自己，
 * 就会变成「服务调用自己」——一层层嵌套请求，直到把 fd 和预算耗光。
 *
 * 真实踩坑：用户把给第三方客户端用的 `http://127.0.0.1:18900/v1/search`
 * 填进了 App 自己的「自定义搜索」，没填 Key 时表现为「鉴权失败，已改用 Bing」，
 * 填了 Key 就会真的递归。所以这里既要在配置层拦，也要在调用前拦。
 *
 * 判定口径：端口等于本机端口 + 主机名是本机（回环 / 全零 / 本机网卡地址）。
 * 只判端口不判主机不行（局域网里另有 18900 服务是可能的），
 * 只判主机不判端口也不行（本机别的服务可以正常调）。
 */
import os from 'node:os';

/** 本机所有网卡地址（含回环），用于判断「这个 host 是不是我自己」 */
export function localHosts() {
  const set = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item && item.address) set.add(String(item.address).toLowerCase());
    }
  }
  return set;
}

/** 给 App 显示「第三方该填哪个地址」用 */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (!item || item.internal) continue;
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      out.push(item.address);
    }
  }
  return [...new Set(out)];
}

/**
 * 这个地址是不是「本机 API 自己」？
 *
 * 两个判据命中任意一个就算：
 *  1. 主机是本机 + 端口等于本机端口；
 *  2. 主机是本机 + 路径正好是我们自己的出口（/v1/search、/v1/read、/mcp）——
 *     端口可能因为降级被系统改过（EADDRINUSE 时监听 0），只靠端口会漏。
 *
 * 不把「主机是本机」单独当判据：手机上自建 SearXNG 监听 127.0.0.1:8080 是常见用法，
 * 那种要能正常调。
 *
 * @param {string} urlStr
 * @param {{selfPort?: number}} opts
 */
export function isSelfEndpoint(urlStr, opts = {}) {
  let u;
  try {
    u = new URL(String(urlStr || '').trim());
  } catch {
    return false;
  }
  const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!localHosts().has(host)) return false;

  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (opts.selfPort && port === Number(opts.selfPort)) return true;

  // 端口对不上时再看路径：只认我们自己的三个出口。
  // 不认裸 /search、/read —— 自建 SearXNG 也用 /search，那是合法第三方。
  const p = u.pathname.replace(/\/+$/, '').toLowerCase();
  return p === '/v1/search' || p === '/v1/read' || p === '/mcp';
}

export class SelfLoopError extends Error {
  constructor(url, selfPort) {
    super(`自定义接口地址指向了本机 API 自己（${url}），已跳过。这个框是给第三方搜索服务用的，不需要填本机地址`);
    this.name = 'SelfLoopError';
    this.code = 'SELF_LOOP';
    this.status = 400;
    this.selfPort = selfPort;
  }
}
