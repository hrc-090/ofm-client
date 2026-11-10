/**
 * 把 core 同步到 Android 的 assets/nodejs-project。
 * 用法：node tools/sync-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'core');
const dest = path.join(root, 'android/app/src/main/assets/nodejs-project');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

const copy = (from, to) => {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copy(path.join(from, entry), path.join(to, entry));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
};

// cacert.pem 必须一起进 assets：内嵌 Node 读不到 Android 系统 CA，
// 缺了它所有出站 HTTPS 都会「证书链校验失败」。
for (const entry of ['main.js', 'package.json', 'cacert.pem', 'src']) {
  copy(path.join(src, entry), path.join(dest, entry));
}

// 内容指纹：任一 JS 变化都会让 version.txt 改变，App 端据此重新解包 assets。
// 以前用写死的 "0.1.0"，改了 JS 却没改版本号 → 覆盖安装后仍在跑旧 server.js
// （表现为新 UI 配旧接口，出现「未知管理接口 /api/xxx」）。
const hash = crypto.createHash('sha256');
const fingerprint = (dir) => {
  for (const e of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, e);
    const rel = path.relative(dest, p);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      hash.update(`D:${rel}\n`);
      fingerprint(p);
    } else {
      hash.update(`F:${rel}:${st.size}\n`);
      hash.update(fs.readFileSync(p));
    }
  }
};
fingerprint(dest);
const version = `ofm-assets-${hash.digest('hex').slice(0, 24)}`;
fs.writeFileSync(path.join(dest, 'version.txt'), version);

let files = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    if (fs.statSync(p).isDirectory()) walk(p);
    else files += 1;
  }
};
walk(dest);
console.log(`同步完成：${files} 个文件 → ${path.relative(root, dest)}`);
console.log(`assets 版本：${version}`);
