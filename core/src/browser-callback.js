/**
 * 默认浏览器登录的回调接收器 + 会话匹配。
 *
 * 渠道（TRAE / LobsterAI 等本地回调类）的 auth_callback_url 指向
 * http://127.0.0.1:18080/authorize。浏览器完成授权后跳这个地址，
 * 由 App 进程里的 Node 接住并交给 logins.completeCallback 换 token。
 *
 * 但这个端口并不可靠，以下情况都会让浏览器显示 ERR_CONNECTION_REFUSED：
 *   1. 授权是在「电脑浏览器」完成的 —— 电脑的 127.0.0.1 不是手机；
 *   2. App 切到后台后进程被系统回收，Node 停了；
 *   3. 18080 被别的进程占用 / 监听失败。
 * 因此这里同时提供「粘贴回调链接」通路：resolveCallbackTarget +
 * normalizeCallbackUrl 让 server.js 能把用户从浏览器地址栏复制回来的
 * 整条 URL（或裸 query）直接送进 completeCallback，完全绕开 18080。
 *
 * 安全纪律：任何日志都不打印 URL 内容（里面有 refreshToken / userJwt）。
 */
import http from 'node:http';

const TARGET_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CALLBACK_PORT = 18080;
let target = null;

/** 供 /api/status 展示，UI 据此提示「端口没在听，请粘贴链接」 */
const state = { port: DEFAULT_CALLBACK_PORT, listening: false, error: null };

export function getCallbackServerState() {
  return { ...state };
}

/** App 打开浏览器前告知本次会话的 accountId（比「猜最近的会话」可靠） */
export function setBrowserTarget(accountId) {
  target = accountId ? { accountId, at: Date.now() } : null;
}

export function getBrowserTarget() {
  if (!target) return null;
  if (Date.now() - target.at > TARGET_TTL_MS) {
    target = null;
    return null;
  }
  return target.accountId;
}

/**
 * 回调该落到哪个会话。优先级：
 *   1. 调用方显式给的 accountId（且会话仍存在）
 *   2. App 打开浏览器前登记的 browser target
 *   3. 最近一个 callback 类待完成会话
 * 会话是内存 Map，App 被杀后会全部消失 —— 这时返回 null，UI 提示重新发起登录。
 */
export function resolveCallbackTarget(logins, accountId = null) {
  const sessions = logins?.sessions;
  const alive = (id) => Boolean(id && sessions?.has(id));
  if (alive(accountId)) return accountId;
  const t = getBrowserTarget();
  if (alive(t)) return t;
  const rec = [...(sessions?.values?.() || [])]
    .filter((s) => s.channel?.loginMode === 'callback')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  return rec?.accountId || null;
}

/**
 * 把用户粘贴的各种形态统一成 new URL() 能解析的绝对地址。
 * 允许：完整 http(s)/自定义 scheme URL、?开头的 query、裸 key=value 串。
 * host 刻意不校验 —— 电脑浏览器复制回来的地址、或经聊天转发的链接都要能用。
 */
export function normalizeCallbackUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (s.startsWith('?')) return `http://127.0.0.1:${state.port}/authorize${s}`;
  if (s.includes('=')) return `http://127.0.0.1:${state.port}/authorize?${s}`;
  return s; // 让下游报「链接格式不正确」
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function page(ok, detail, fullUrl) {
  const title = ok ? '登录完成' : '登录未完成';
  const tip = ok
    ? '凭据已经写入，回到 OFM 渠道就能看到账号了。'
    : `没能完成登录：${esc(detail)}。可以回 App 重新发起，或者把下面整条地址复制回 App，点「粘贴回调链接完成登录」。`;
  const link = ok
    ? '<a class="btn" href="ofm://login/done">返回应用</a>'
    : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#1a1a1a;margin:0;padding:32px;}` +
    `.card{max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px #0001}` +
    `h1{font-size:20px;margin:0 0 12px}p{font-size:14px;line-height:1.7;color:#555}` +
    `code{display:block;word-break:break-all;background:#f3f4f6;border-radius:8px;padding:12px;font-size:12px;margin-top:16px;user-select:all}` +
    `.btn{display:inline-block;margin-top:20px;padding:10px 18px;background:#2563eb;color:#fff;border-radius:10px;text-decoration:none;font-size:14px}</style>` +
    `</head><body><div class="card"><h1>${title}</h1><p>${tip}</p>${link}` +
    `<code>${esc(fullUrl)}</code></div></body></html>`;
}

export function startBrowserCallbackServer({ logins, port = DEFAULT_CALLBACK_PORT, log = console }) {
  state.port = port;
  state.listening = false;
  state.error = null;

  const server = http.createServer(async (req, res) => {
    const raw = req.url || '/';
    const pathname = raw.split('?')[0];

    // 浏览器顺带请求 favicon / 其它探测路径时不要误触发换 token
    if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
      res.writeHead(204);
      res.end();
      return;
    }

    const full = `http://127.0.0.1:${port}${raw}`;
    const id = resolveCallbackTarget(logins);

    let ok = false;
    let detail = '';
    if (!id) {
      detail = '没有待完成的回调登录会话（可能 App 被重启过），请回 App 重新点「连接」';
    } else {
      try {
        await logins.completeCallback(id, full);
        ok = true;
        setBrowserTarget(null);
      } catch (e) {
        detail = e?.message || String(e);
      }
    }

    if (ok) log.log(`[ofm] 浏览器回调完成：${id}`);
    else log.warn(`[ofm] 浏览器回调未完成：${detail}`);

    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(page(ok, detail, full));
  });

  let retries = 0;
  server.on('error', (e) => {
    // 上一个进程刚被杀时端口可能还没释放，重试几次再放弃
    if ((e?.code === 'EADDRINUSE' || e?.code === 'EACCES') && retries < 3) {
      retries += 1;
      log.warn(`[ofm] 回调端口 ${port} 暂不可用（${e.code}），${300 * retries}ms 后重试`);
      setTimeout(() => {
        try { server.listen(port, '127.0.0.1'); } catch { /* 忽略，交给 error 事件 */ }
      }, 300 * retries);
      return;
    }
    state.listening = false;
    state.error = e?.code || e?.message || 'listen failed';
    // 不阻断主服务：端口不通时 UI 会提示改用「粘贴回调链接」
    log.warn(`[ofm] 回调端口 ${port} 监听失败：${state.error}（请用 App 内「粘贴回调链接」完成登录）`);
  });

  server.on('listening', () => {
    state.listening = true;
    state.error = null;
    log.log(`[ofm] 浏览器回调监听 http://127.0.0.1:${port}`);
  });

  server.on('close', () => { state.listening = false; });

  try { server.listen(port, '127.0.0.1'); } catch (e) {
    state.error = e?.code || e?.message || 'listen failed';
    log.warn(`[ofm] 回调端口 ${port} 启动异常：${state.error}`);
  }
  return server;
}
