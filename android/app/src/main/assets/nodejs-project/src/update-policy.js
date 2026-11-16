/**
 * 应用内更新的「纯规则」层：不联网、不碰文件，只做版本比较、Release 解析、
 * 镜像候选构造与 SHA256SUMS 匹配。
 *
 * Android 侧 UpdateManager.kt 按同一套规则实现（Kotlin 无法复用 JS），
 * 这里保留一份等价实现 + 回归用例，保证发版时「附件名 / 校验文件 / 版本比较」
 * 的约定不会被无意改坏。改规则时两边一起改，并跑 core/test/update-policy.mjs。
 *
 * 目标运行时 nodejs-mobile Node 18，不用任何新 API。
 */

/** 逐段数字比较；v 前缀、beta 后缀、0.10.0 > 0.9.0 都按数字段处理。 */
export function compareVersions(a, b) {
  const parts = (v) => {
    const out = [];
    const re = /\d+/g;
    let m;
    const s = String(v ?? '').trim().replace(/^[vV]/, '');
    while ((m = re.exec(s)) !== null) out.push(Number(m[0]));
    return out;
  };
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 加速前缀规范化：补 https、补尾斜杠；空串表示只走官方。 */
export function normalizeMirror(raw) {
  let m = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!m) return '';
  if (!/^https?:\/\//i.test(m)) m = `https://${m}`;
  return `${m}/`;
}

/** 官方优先（镜像只是兜底源之一），镜像非空时先试镜像再回退官方。 */
export function candidates(url, mirrorPrefix) {
  const m = normalizeMirror(mirrorPrefix);
  return m ? [`${m}${url}`, url] : [url];
}

/**
 * 从 GitHub releases/latest 的 JSON 里挑出可安装信息。
 * 与 Android UpdateManager.parseRelease 一致：优先 ofm-client-*.apk，
 * 避免选到历史文件名的 AP.apk；SHA256SUMS.txt 单独记下来。
 */
export function parseRelease(json) {
  const tag = String(json?.tag_name || json?.name || '').trim();
  if (!tag) throw new Error('Release 缺少 tag_name');
  const assets = Array.isArray(json?.assets) ? json.assets : [];
  let apk = null;         // { name, url, size }
  let namedApk = null;
  let sumsUrl = null;
  for (const a of assets) {
    const name = String(a?.name || '');
    const url = String(a?.browser_download_url || '');
    if (!url) continue;
    if (name.toLowerCase() === 'sha256sums.txt') sumsUrl = url;
    if (!name.toLowerCase().endsWith('.apk')) continue;
    const size = Number(a?.size) || 0;
    const entry = { name, url, size };
    if (!apk || size > apk.size) apk = entry;
    if (/^ofm-client-/i.test(name) && (!namedApk || size > namedApk.size)) namedApk = entry;
  }
  const chosen = namedApk || apk;
  if (!chosen) throw new Error('这个 Release 里没有 APK 附件');
  return {
    version: tag.replace(/^[vV]/, ''),
    tag,
    name: String(json?.name || tag),
    notes: String(json?.body || '').slice(0, 1500),
    htmlUrl: String(json?.html_url || '').trim(),
    apkName: chosen.name,
    apkUrl: chosen.url,
    apkSize: chosen.size,
    sumsUrl,
    publishedAt: String(json?.published_at || '').slice(0, 10)
  };
}

/** 从 checksum 文件里找指定 APK 的 hash，兼容 `*binary` 标记与 `./` 前缀。 */
export function expectedHash(sums, apkName) {
  const wanted = String(apkName || '').split('/').pop().replace(/^\.\//, '').trim();
  for (const line of String(sums || '').split(/\r?\n/)) {
    const t = line.trim();
    const sp = t.search(/\s/);
    if (sp < 0) continue;
    const hash = t.slice(0, sp).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    const name = t.slice(sp).trim().replace(/^\*/, '').replace(/^\.\//, '').trim();
    if (name === wanted) return hash;
  }
  return null;
}

/** 一次检查的结论。 */
export function checkResult(json, currentVersion) {
  const info = parseRelease(json);
  return {
    current: currentVersion,
    remote: info.version,
    newer: compareVersions(info.version, currentVersion) > 0,
    info
  };
}
