/**
 * 内嵌 Node 的 HTTPS 根证书。
 *
 * 坑：Android 的 res/xml/network_security_config.xml 只约束 Java 层
 * （WebView / HttpsURLConnection / OkHttp）。nodejs-mobile 里的 Node 用自己的
 * OpenSSL，既读不到 /etc/ssl/certs/ca-certificates.crt（Android 没这个路径），
 * 也读不到 /system/etc/security/cacerts（分文件 + hash 命名，OpenSSL 不认）。
 * 一旦 libnode.so 编译时没把内置根证书打进去，所有出站 HTTPS 都会
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE —— 表现就是「模型远端拉取失败 / 余额查询失败」
 * 同时出现，因为它们共用同一个 https.request。
 *
 * 做法：把 curl.se 的 Mozilla CA bundle 打进 assets，启动时与
 * tls.rootCertificates（Node 编译时内置的那一批）**合并**后显式传给 https.request。
 * 合并而不是替换，避免某些构建里内置表反而更全。
 */
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

let cached;

/** 把一个多证书 PEM 文本拆成 Node 能直接吃的数组。 */
export function splitPem(text) {
  return String(text || '').match(PEM_RE) || [];
}

function candidatePaths() {
  const list = [];
  const env = typeof process !== 'undefined' ? String(process.env.OFM_CA_FILE || '').trim() : '';
  if (env) list.push(env);
  try {
    const cwd = process.cwd();
    // nodejs-mobile 的 cwd = assets 解包目录（App filesDir），cacert.pem 就在根
    list.push(path.join(cwd, 'cacert.pem'));
    list.push(path.join(cwd, 'src', 'cacert.pem'));
    // 桌面开发时从 core/src/ 被 import，cwd 可能是 core/
    list.push(path.join(cwd, '..', 'cacert.pem'));
  } catch {
    /* 忽略：拿不到 cwd 就只用环境变量 */
  }
  return list;
}

export function loadExtraCa(paths = candidatePaths()) {
  for (const p of paths) {
    try {
      const certs = splitPem(fs.readFileSync(p, 'utf8'));
      if (certs.length) return { certs, source: p };
    } catch {
      /* 继续找下一个 */
    }
  }
  return { certs: [], source: null };
}

export function caInfo() {
  if (cached) return cached;
  const builtin = Array.isArray(tls.rootCertificates) ? tls.rootCertificates.filter(Boolean) : [];
  const { certs, source } = loadExtraCa();
  cached = {
    builtinCount: builtin.length,
    extraCount: certs.length,
    source,
    ca: [...builtin, ...certs]
  };
  return cached;
}

/** 供验收测试重置缓存（换 OFM_CA_FILE 后重新加载）。 */
export function resetCaCache() {
  cached = undefined;
}

/** 传给 node:https / node:tls 的选项。ca 为空就保持 Node 默认行为，不瞎覆盖。 */
export function httpsOptions() {
  const info = caInfo();
  const opt = {};
  if (info.ca.length) opt.ca = info.ca;
  // Android 上常见「IPv6 能解析但路由不通」，让 Node 在双栈间自动择优（18.18+；
  // 更老的构建会忽略这个未知选项，无害）。
  opt.autoSelectFamily = true;
  return opt;
}

/** 只给诊断用，绝不含证书内容。 */
export function describeCa() {
  const i = caInfo();
  return {
    builtinRootCerts: i.builtinCount,
    bundledRootCerts: i.extraCount,
    bundle: i.source ? path.basename(i.source) : null,
    total: i.ca.length
  };
}
