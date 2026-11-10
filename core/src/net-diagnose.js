/**
 * 出站网络分步自检。
 *
 * 真机上「模型远端拉取失败 / 余额查询失败」往往是同一个根因，但界面只有一句
 * 泛化文案，无法区分：手机没外网 / DNS 被污染 / 443 被拦 / 证书链缺根 /
 * 上游返回 401。这里按 dns → tcp → tls → https 逐层测，把每层错误码原样带回 UI。
 *
 * 安全：全程不带任何凭据，只发一个不带业务头的 GET /；TLS 步骤故意
 * rejectUnauthorized:false 只为了读出 authorizationError，真实请求仍然严格校验。
 */
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { httpsOptions, describeCa } from './ca-bundle.js';
import { describeNetError } from './http-client.js';

const STEP_TIMEOUT_MS = 4000;
const PORT = 443;

/**
 * 默认目标：一个国内对照 + 三个真实上游。
 * 注意 api.trae.cn（签到/余额）、trae-api-cn.mchost.guru（模型目录）、
 * api.trae.com.cn（OAuth 换 token / 用户信息）是**三个不同域名**，
 * 以前漏了最后一个，导致「网络自检全通过」却仍可能登录失败。
 */
export const DEFAULT_TARGETS = [
  { host: 'www.baidu.com', label: '基础连通性（对照）' },
  { host: 'api.trae.cn', label: 'TRAE 签到 / 余额' },
  { host: 'trae-api-cn.mchost.guru', label: 'TRAE 模型目录' },
  { host: 'api.trae.com.cn', label: 'TRAE 登录 / 换 token' }
];

export function normalizeHost(h) {
  try {
    const s = String(h || '').trim();
    if (!s) return '';
    return new URL(s.includes('://') ? s : `https://${s}`).hostname;
  } catch {
    return '';
  }
}

function stepDns(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ms: Date.now() - t0, ...r });
    };
    const timer = setTimeout(
      () => finish({ ok: false, code: 'TIMEOUT', message: 'DNS 解析超时' }),
      STEP_TIMEOUT_MS
    );
    if (timer.unref) timer.unref();
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) {
        return finish({
          ok: false,
          code: err.code || 'DNS',
          message: describeNetError(err) || err.message
        });
      }
      const list = (addrs || []).map((a) => a.address).filter(Boolean);
      finish({
        ok: list.length > 0,
        code: list.length ? null : 'ENODATA',
        message: list.length ? '' : '域名解析成功但没有返回地址',
        addresses: list.slice(0, 4)
      });
    });
  });
}

function stepTcp(host, address) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let sock;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { sock?.destroy(); } catch { /* noop */ }
      resolve({ ms: Date.now() - t0, ...r });
    };
    try {
      sock = net.connect({
        host: address || host,
        port: PORT,
        autoSelectFamily: true
      });
    } catch (e) {
      return finish({ ok: false, code: 'CONNECT', message: e.message });
    }
    sock.setTimeout(STEP_TIMEOUT_MS, () =>
      finish({ ok: false, code: 'TIMEOUT', message: 'TCP 连接超时' })
    );
    sock.once('connect', () => finish({ ok: true }));
    sock.once('error', (e) =>
      finish({
        ok: false,
        code: e.code || 'TCP',
        message: describeNetError(e) || e.message
      })
    );
  });
}

function stepTls(host, address) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let sock;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { sock?.destroy(); } catch { /* noop */ }
      resolve({ ms: Date.now() - t0, ...r });
    };
    try {
      sock = tls.connect({
        host: address || host,
        port: PORT,
        servername: host,
        ...httpsOptions(),
        // 故意放行：握手一定能完成，才能读到 authorizationError / 证书信息。
        // 真实业务请求的 https.request 仍是严格校验，这里只是探测。
        rejectUnauthorized: false
      });
    } catch (e) {
      return finish({ ok: false, code: 'CONNECT', message: e.message });
    }
    sock.setTimeout(STEP_TIMEOUT_MS, () =>
      finish({ ok: false, code: 'TIMEOUT', message: 'TLS 握手超时' })
    );
    sock.once('secureConnect', () => {
      const authErr = sock.authorizationError ? String(sock.authorizationError) : null;
      const cert = sock.getPeerCertificate?.(true) || {};
      finish({
        ok: sock.authorized === true,
        code: authErr,
        message: authErr ? describeNetError({ code: authErr }) || authErr : '',
        authorized: sock.authorized === true,
        protocol: sock.getProtocol?.() || null,
        certCN: cert.subject?.CN || null,
        certIssuer: cert.issuer?.O || null,
        certValidTo: cert.valid_to || null
      });
    });
    sock.once('error', (e) =>
      finish({
        ok: false,
        code: e.code || 'TLS',
        message: describeNetError(e) || e.message
      })
    );
  });
}

function stepHttps(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let req;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch { /* noop */ }
      resolve({ ms: Date.now() - t0, ...r });
    };
    try {
      req = https.request(
        {
          ...httpsOptions(),
          host,
          port: PORT,
          servername: host,
          path: '/',
          method: 'GET',
          headers: { 'user-agent': 'ofm-network-probe/1.0', accept: '*/*' }
        },
        (res) => {
          res.resume(); // 丢弃 body，只要状态码
          finish({ ok: true, status: res.statusCode || 0 });
        }
      );
    } catch (e) {
      return finish({ ok: false, code: 'CONNECT', message: e.message });
    }
    req.setTimeout(STEP_TIMEOUT_MS, () =>
      finish({ ok: false, code: 'TIMEOUT', message: 'HTTPS 请求超时' })
    );
    req.once('error', (e) =>
      finish({
        ok: false,
        code: e.code || 'HTTPS',
        message: describeNetError(e) || e.message
      })
    );
    req.end();
  });
}

/** 分层结论：把「卡在哪一层」翻译成人能看懂的一句话。 */
export function summarize(results) {
  const bad = results.filter((r) => !r.ok);
  if (bad.length === 0) return '所有目标均可达（DNS / TCP / TLS / HTTPS 全部通过）';
  const layers = new Set(bad.map((r) => r.failedAt));
  if (layers.has('dns')) return '域名解析失败：手机可能没外网，或 DNS 被污染 / 被 VPN 拦截';
  if (layers.has('tcp')) return '域名能解析但连不上 443：检查网络、防火墙或代理设置';
  if (layers.has('tls')) {
    const codes = [
      ...new Set(
        bad.filter((r) => r.failedAt === 'tls').map((r) => r.steps.tls?.code).filter(Boolean)
      )
    ];
    return `TLS 证书校验失败（${codes.join(', ') || '未知'}）：根证书缺失，或网络被中间人代理`;
  }
  return `HTTPS 请求失败：${bad.map((r) => `${r.host} ${r.reason || ''}`).join('；').slice(0, 200)}`;
}

/**
 * @param {object} opts
 * @param {string[]} opts.hosts 自定义目标（覆盖默认列表）
 * @param {object} opts.steps  注入假步骤，供纯 mock 验收使用
 */
export async function runNetworkDiagnose({ hosts, steps } = {}) {
  const s = steps || { dns: stepDns, tcp: stepTcp, tls: stepTls, https: stepHttps };
  const custom = Array.isArray(hosts) ? hosts.map(normalizeHost).filter(Boolean) : [];
  const targets = custom.length
    ? custom.map((host) => ({ host, label: '自定义目标' }))
    : DEFAULT_TARGETS;

  const results = await Promise.all(
    targets.map(async (t) => {
      const out = { host: t.host, label: t.label, ok: false, steps: {}, failedAt: null, reason: '' };
      const dnsR = await s.dns(t.host);
      out.steps.dns = dnsR;
      if (!dnsR.ok) {
        out.failedAt = 'dns';
        out.reason = dnsR.message || dnsR.code || 'DNS 失败';
        return out;
      }
      const addr = dnsR.addresses?.[0];
      const tcpR = await s.tcp(t.host, addr);
      out.steps.tcp = tcpR;
      if (!tcpR.ok) {
        out.failedAt = 'tcp';
        out.reason = tcpR.message || tcpR.code || 'TCP 失败';
        return out;
      }
      const tlsR = await s.tls(t.host, addr);
      out.steps.tls = tlsR;
      if (!tlsR.ok) {
        out.failedAt = 'tls';
        out.reason = tlsR.message || tlsR.code || '证书不受信任';
        return out;
      }
      const httpsR = await s.https(t.host, addr);
      out.steps.https = httpsR;
      out.ok = httpsR.ok === true;
      if (!out.ok) {
        out.failedAt = 'https';
        out.reason = httpsR.message || `HTTP ${httpsR.status ?? 0}`;
      }
      return out;
    })
  );

  return {
    ok: results.every((r) => r.ok),
    at: Date.now(),
    ca: describeCa(),
    targets: results,
    summary: summarize(results)
  };
}
