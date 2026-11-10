#!/usr/bin/env node
/**
 * 取 nodejs-mobile 的预编译 libnode.so。
 *
 * 不用 Gradle 插件的原因：com.janeasystems:nodejs-mobile-gradle 只发布在已关闭的
 * JCenter，Maven Central / Google Maven 都是 404；而 nodejs-mobile 的 GitHub
 * Release 在国内经常超时。改为从 npm 上的 nodejs-mobile-react-native 包里取——
 * 它的 package/android/libnode/bin/<abi>/libnode.so 就是同一份产物。
 *
 * 用法：node tools/fetch-libnode.mjs [arm64-v8a|x86_64|armeabi-v7a]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ABI = process.argv[2] || 'arm64-v8a';
const ROOT = path.resolve(import.meta.dirname, '..');
const DEST = path.join(ROOT, 'android/app/src/main/jniLibs', ABI, 'libnode.so');

if (fs.existsSync(DEST)) {
  console.log(`已存在，跳过：${DEST}`);
  process.exit(0);
}

const meta = await fetch('https://registry.npmjs.org/nodejs-mobile-react-native').then((r) => r.json());
const version = meta['dist-tags'].latest;
const tarball = meta.versions[version].dist.tarball;
console.log(`nodejs-mobile-react-native@${version} <- ${tarball}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-libnode-'));
const tgz = path.join(tmp, 'pkg.tgz');
const res = await fetch(tarball);
if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
console.log(`已下载 ${(fs.statSync(tgz).size / 1048576).toFixed(1)} MB，解包中…`);

const inner = `package/android/libnode/bin/${ABI}/libnode.so`;
execFileSync('tar', ['xzf', tgz, '-C', tmp, inner], { stdio: 'inherit' });

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(path.join(tmp, inner), DEST);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`OK -> ${DEST} (${(fs.statSync(DEST).size / 1048576).toFixed(1)} MB)`);
