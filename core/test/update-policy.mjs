/**
 * 应用内更新「纯规则」回归：版本比较 / 镜像候选 / Release 解析 / 校验和匹配。
 * 纯 mock，不联网、不需要 Android。运行：node test/update-policy.mjs
 *
 * 夹具用真实 v0.2.0 Release 的字段形状（4 个附件 + SHA256SUMS.txt），
 * 与 Android 侧 UpdateManager.kt 的规则一一对应。
 */
import assert from 'node:assert/strict';

import {
  compareVersions,
  normalizeMirror,
  candidates,
  parseRelease,
  expectedHash,
  checkResult
} from '../src/update-policy.js';

let passed = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const results = [];
async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    results.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

/* 真实 Release 夹具（v0.2.0） */
const APK = 'ofm-client-0.2.0-debug.apk';
const APK_SHA = '553a6b1b4835cd94a571d92e5a3ae3f549d6a519f31ee40b6c4323420b362f03';
const REAL_RELEASE = {
  tag_name: 'v0.2.0',
  name: 'v0.2.0 · Raccoon 登录修复 + 思考档位对外',
  body: '## 下载\n\n| 文件 | 说明 |\n…',
  html_url: 'https://github.com/hrc-090/ofm-client/releases/tag/v0.2.0',
  published_at: '2026-11-11T06:56:24Z',
  assets: [
    { name: 'AP.apk', size: 26723604, browser_download_url: 'https://github.com/hrc-090/ofm-client/releases/download/v0.2.0/AP.apk' },
    { name: 'AP.zip', size: 26723766, browser_download_url: 'https://github.com/hrc-090/ofm-client/releases/download/v0.2.0/AP.zip' },
    { name: APK, size: 26723604, browser_download_url: `https://github.com/hrc-090/ofm-client/releases/download/v0.2.0/${APK}` },
    { name: 'SHA256SUMS.txt', size: 239, browser_download_url: 'https://github.com/hrc-090/ofm-client/releases/download/v0.2.0/SHA256SUMS.txt' }
  ]
};
const REAL_SUMS = [
  `${APK_SHA}  AP.apk`,
  `149bb89e7d961ebcafd1445b5b09b05b89d953fc52d0800730e0ea7a446d861d  AP.zip`,
  `${APK_SHA}  ${APK}`,
  ''
].join('\n');

/* ───────── 版本比较 ───────── */
await test('版本比较', () => {
  ok('v 前缀等价', compareVersions('v0.2.0', '0.2.0') === 0);
  ok('V 大写前缀等价', compareVersions('V0.2.0', '0.2.0') === 0);
  ok('新版更大', compareVersions('v0.3.0', '0.2.0') > 0);
  ok('旧版更小', compareVersions('v0.1.9', '0.2.0') < 0);
  ok('两位数段按数字比', compareVersions('0.10.0', '0.9.0') > 0);
  ok('缺段补零', compareVersions('0.2', '0.2.0') === 0);
  ok('补丁位', compareVersions('0.2.1', '0.2.0') > 0);
  ok('beta 后缀不影响数字段', compareVersions('0.3.0-beta', '0.2.0') > 0);
  ok('空串不当作 0 段崩溃', compareVersions('', '0.2.0') < 0);
  ok('非数字串退化成 0', compareVersions('dev', '0.0.0') === 0);
  ok('null 安全', compareVersions(null, '0.2.0') < 0);
  ok('四位版本号', compareVersions('0.2.0.1', '0.2.0') > 0);
});

/* ───────── 镜像规范化与候选 ───────── */
await test('镜像规范化与候选', () => {
  ok('空串 = 只走官方', normalizeMirror('') === '');
  ok('纯空白 = 只走官方', normalizeMirror('   ') === '');
  ok('裸域名补 https', normalizeMirror('ghproxy.net') === 'https://ghproxy.net/');
  ok('带尾斜杠不重复', normalizeMirror('https://ghproxy.net/') === 'https://ghproxy.net/');
  ok('多个尾斜杠清理', normalizeMirror('https://ghproxy.net///') === 'https://ghproxy.net/');
  ok('保留 http 显式写法', normalizeMirror('http://10.0.0.2:8080') === 'http://10.0.0.2:8080/');
  ok('前后空白清理', normalizeMirror('  https://mirror.example.com/  ') === 'https://mirror.example.com/');
  ok('null 安全', normalizeMirror(null) === '');

  const official = 'https://api.github.com/repos/x/releases/latest';
  ok('无镜像只有一个候选', candidates(official, '').length === 1);
  ok('无镜像候选就是官方', candidates(official, '')[0] === official);
  const two = candidates(official, 'https://ghproxy.net/');
  ok('有镜像两个候选', two.length === 2);
  ok('镜像候选 = 前缀 + 官方完整 URL', two[0] === `https://ghproxy.net/${official}`);
  ok('最后回退官方', two[1] === official);
  ok('候选不重复', two[0] !== two[1]);
});

/* ───────── Release 解析 ───────── */
await test('Release 解析', () => {
  const info = parseRelease(REAL_RELEASE);
  ok('版本号剥掉 v', info.version === '0.2.0', info.version);
  ok('tag 保留原样', info.tag === 'v0.2.0');
  ok('优先选正式命名 APK', info.apkName === APK, info.apkName);
  ok('不选历史文件名的 AP.apk', info.apkName !== 'AP.apk');
  ok('APK 大小正确', info.apkSize === 26723604);
  ok('APK 下载 URL 正确', info.apkUrl.endsWith(`/v0.2.0/${APK}`));
  ok('拿到校验文件 URL', (info.sumsUrl || '').endsWith('/SHA256SUMS.txt'));
  ok('发布日期只留日期', info.publishedAt === '2026-11-11');
  ok('Release 页 URL', info.htmlUrl.includes('/releases/tag/v0.2.0'));
  ok('标题保留', info.name.includes('Raccoon'));
  ok('更新说明保留', info.notes.includes('下载'));
});

await test('Release 解析：边界与降级', () => {
  // 只有历史文件名时也要能选到，不能误选 AP.zip
  const legacy = {
    ...REAL_RELEASE,
    tag_name: 'v0.1.0',
    assets: [
      { name: 'AP.apk', size: 31891110, browser_download_url: 'https://x/AP.apk' },
      { name: 'AP.zip', size: 25975240, browser_download_url: 'https://x/AP.zip' },
      { name: 'SHA256SUMS.txt', size: 239, browser_download_url: 'https://x/SHA256SUMS.txt' }
    ]
  };
  const l = parseRelease(legacy);
  ok('只剩 AP.apk 时回退到它', l.apkName === 'AP.apk');
  ok('不会把 zip 当安装包', l.apkName.endsWith('.apk'));
  ok('同名多个 APK 取最大的', parseRelease({
    ...REAL_RELEASE,
    assets: [
      { name: APK, size: 100, browser_download_url: 'https://x/small' },
      { name: APK, size: 900, browser_download_url: 'https://x/big' }
    ]
  }).apkUrl === 'https://x/big');
  ok('缺 tag_name 抛错', (() => {
    try { parseRelease({ assets: [] }); return false; } catch { return true; }
  })());
  ok('完全没有 APK 抛错', (() => {
    try { parseRelease({ tag_name: 'v9', assets: [{ name: 'README.md' }] }); return false; } catch { return true; }
  })());
  ok('assets 缺失抛错而不是崩', (() => {
    try { parseRelease({ tag_name: 'v9' }); return false; } catch { return true; }
  })());
  ok('没有 SHA256SUMS.txt 时 sumsUrl 为 null',
    parseRelease({ tag_name: 'v9', assets: [{ name: APK, browser_download_url: 'https://x/a.apk' }] }).sumsUrl === null);
  ok('空 browser_download_url 跳过',
    parseRelease({
      tag_name: 'v9',
      assets: [
        { name: APK, size: 1, browser_download_url: '' },
        { name: 'ofm-client-9.apk', size: 2, browser_download_url: 'https://x/ok.apk' }
      ]
    }).apkUrl === 'https://x/ok.apk');
  ok('tag 用 name 兜底', parseRelease({
    name: 'v1.2.3',
    assets: [{ name: APK, browser_download_url: 'https://x/a.apk' }]
  }).version === '1.2.3');
  ok('更新说明截断到 1500', parseRelease({
    tag_name: 'v9', body: 'x'.repeat(3000),
    assets: [{ name: APK, browser_download_url: 'https://x/a.apk' }]
  }).notes.length === 1500);
  ok('SHA256SUMS 大小写不敏感', parseRelease({
    tag_name: 'v9',
    assets: [
      { name: APK, browser_download_url: 'https://x/a.apk' },
      { name: 'sha256sums.TXT', browser_download_url: 'https://x/sums' }
    ]
  }).sumsUrl === 'https://x/sums');
});

/* ───────── 校验和匹配 ───────── */
await test('校验和匹配', () => {
  ok('真实校验文件匹配到 APK', expectedHash(REAL_SUMS, APK) === APK_SHA);
  ok('取到的是 64 位小写 hex', /^[0-9a-f]{64}$/.test(expectedHash(REAL_SUMS, APK) || ''));
  ok('也认 `*` 二进制标记', expectedHash(`${APK_SHA} *${APK}`, APK) === APK_SHA);
  ok('也认 ./ 前缀', expectedHash(`${APK_SHA}  ./${APK}`, APK) === APK_SHA);
  ok('CRLF 能解析', expectedHash(REAL_SUMS.replace(/\n/g, '\r\n'), APK) === APK_SHA);
  ok('大写 hash 归一成小写', expectedHash(`${APK_SHA.toUpperCase()}  ${APK}`, APK) === APK_SHA);
  ok('apkName 带路径取 basename', expectedHash(REAL_SUMS, `download/${APK}`) === APK_SHA);
  ok('找不到对应行返回 null', expectedHash(REAL_SUMS, 'other.apk') === null);
  ok('短 hash 不算有效行', expectedHash(`abc  ${APK}`, APK) === null);
  ok('非 hex 字符不算有效行', expectedHash(`${'z'.repeat(64)}  ${APK}`, APK) === null);
  ok('空内容返回 null', expectedHash('', APK) === null);
  ok('null 内容返回 null', expectedHash(null, APK) === null);
  ok('只有 hash 没有文件名不算', expectedHash(APK_SHA, APK) === null);
  ok('注释行被跳过', expectedHash(`# comment\n${APK_SHA}  ${APK}`, APK) === APK_SHA);
  ok('不会跨行误配', expectedHash(`${APK_SHA}  A.apk\n${'a'.repeat(64)}  ${APK}`, APK) === 'a'.repeat(64));
});

/* ───────── 检查结论 ───────── */
await test('检查结论', () => {
  const newer = checkResult(REAL_RELEASE, '0.1.9');
  ok('旧版本检测到更新', newer.newer === true);
  ok('结论带完整的 info', newer.info.apkName === APK);
  ok('结论记录当前版本', newer.current === '0.1.9');
  ok('结论记录线上版本', newer.remote === '0.2.0');

  const same = checkResult(REAL_RELEASE, '0.2.0');
  ok('同版本不提示更新', same.newer === false);
  ok('同版本仍返回 info 供 UI 显示', same.info != null);

  const ahead = checkResult(REAL_RELEASE, '0.3.0');
  ok('本地比线上新不提示降级', ahead.newer === false);
  ok('本地开发版仍显示线上版本', ahead.remote === '0.2.0');

  const next = checkResult({ ...REAL_RELEASE, tag_name: 'v0.10.0' }, '0.9.0');
  ok('0.10 大于 0.9', next.newer === true);
});

/* ───────── 汇总 ───────── */
console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/update-policy.mjs 通过 ${passed} 项断言`);
