/**
 * 内嵌服务入口（Android 上由 nodejs-mobile 的 NodeJS.start("main.js") 拉起）。
 *
 * 启动顺序：读配置 → 起 http server → 只监听回环 → 把实际端口/Key 写进 runtime.json。
 * 端口 18900 被占用时用系统分配端口（listen 0），绝不改成 0.0.0.0。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { createApp } from './src/server.js';
import { startBrowserCallbackServer } from './src/browser-callback.js';

const dataDir =
  process.env.OFM_DATA_DIR ||
  (process.platform === 'android'
    ? path.join(process.cwd(), 'data') // nodejs-mobile 的 cwd 是 App 的 files 目录
    : path.join(os.homedir(), '.our-free-model'));
fs.mkdirSync(dataDir, { recursive: true });

const { server, store, search, uiToken, logins, autoCheckin, modelService } = createApp({ dataDir, log: console });

// 固定端口。绝不读 store.settings.forward.port —— 早期版本把「降级时系统分配的
// 随机端口」写回了 settings，导致下次启动继续用那个端口，客户端配置就永远连不上。
const desiredPort = Number(process.env.OFM_PORT || 18900);
const host = '127.0.0.1';

// 双保险：Kotlin 侧启动时已删过一次。旧文件含上次的端口与 uiToken，
// 而 uiToken 每次 createApp 都会重新随机，留着只会让界面连错地方。
const runtimePath = path.join(dataDir, 'runtime.json');
try { fs.rmSync(runtimePath, { force: true }); } catch { /* 忽略 */ }

function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function start() {
  let port = 0;
  let fallback = false;
  // 上一次进程刚被杀时端口可能还没释放，重试几次再降级到随机端口。
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      port = await listen(desiredPort);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      if (attempt < 3) {
        console.warn(`[ofm] 端口 ${desiredPort} 暂不可用（${e.code}），${400 * (attempt + 1)}ms 后重试`);
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  if (!port) {
    console.warn(`[ofm] 端口 ${desiredPort} 始终不可用，改用系统分配端口`);
    port = await listen(0);
    fallback = true;
  }

  // 写实际端口只是给 /api/status 显示用；desiredPort 不读它，所以不会造成端口漂移。
  store.update((s) => {
    s.forward.host = host;
    s.forward.port = port;
  });
  // 搜索的自环判定要用真实监听端口：createApp 时读的还是上一次落盘的值，
  // 端口降级过就会判错（把真正的自环当成第三方）。
  search.setSelfPort?.(port);

  const runtime = {
    pid: process.pid,
    host,
    port,
    portFallback: fallback,
    key: store.settings.forward.key,
    uiToken,
    startedAt: Date.now(),
    version: '0.2.0'
  };
  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2), { mode: 0o600 });

  console.log(`[ofm] listening on http://${host}:${port}`);
  console.log(`[ofm] api key: ${store.settings.forward.key.slice(0, 12)}…（完整值见 runtime.json / App 界面）`);

  // 自动签到：启动延迟 30s（0 合法）+ 跨天巡检 2.5h。
  // 放在 listen 成功之后，确保此时凭据目录与 runtime 都已就绪。
  autoCheckin.start();

  // 启动后异步预热模型目录：有账号时第三方第一次调 /v1/models 就能直接命中缓存，
  // 不用等它发请求才现拉上游。失败只记日志（没账号 / 上游不可达都属正常）。
  setTimeout(() => {
    Promise.resolve()
      .then(() => modelService.listAll({ force: true }))
      .then((list) => console.log(`[ofm] 模型目录预热完成：${list.length} 个`))
      .catch((e) => console.warn(`[ofm] 模型目录预热失败：${e.message}`));
  }, 1500).unref?.();

  // 默认浏览器登录的回调接收器。只监听回环，随服务一起启停，
  // 关服务时必须一起关，否则端口残留会让下次启动的浏览器回调落空。
  const callbackPort = Number(process.env.OFM_CALLBACK_PORT || 18080);
  const callbackServer = startBrowserCallbackServer({ logins, port: callbackPort, log: console });

  const shutdown = () => {
    console.log('[ofm] shutting down');
    try { autoCheckin.stop(); } catch { /* 忽略 */ }
    try { callbackServer.close(); } catch { /* 忽略 */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((e) => {
  console.error('[ofm] 启动失败:', e);
  process.exit(1);
});
