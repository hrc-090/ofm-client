/**
 * 本机登录入口页：`GET /raccoon/login`
 *
 * 为什么要有这一页：
 *   官方扫码落地页 `/login/mp` 现在是 404（2026-11 实测，换 UA/主机名/参数都没用），
 *   旧实现直接把 `…/login/mp?code=<本地随机 hex>` 丢给浏览器，用户只能看到 404。
 *   上游给的是本机地址 `http://127.0.0.1:<port>/raccoon/login`，本页对齐这个入口：
 *   先渲染一个过渡页，再跳到**仍然可用**的官网 `/login`。
 *
 * 登录态由 App 侧在 WebView 的 Cookie 里取（xhx_token / raccoon_token），
 * 交给 `/api/accounts/:id/cookie` 验活后落库 —— 所以这一页不需要 JS 回调。
 */
export function raccoonLoginPage({ target }) {
  const url = String(target || 'https://xiaohuanxiong.com/login');
  const safeUrl = url.replace(/"/g, '%22');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>连接 Raccoon</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f1115; color: #e8eaf0;
    font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    padding: 24px;
  }
  .card { width: 100%; max-width: 420px; background: #171a21; border: 1px solid #262b36; border-radius: 18px; padding: 24px; }
  .brand { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #7c8598; }
  h1 { font-size: 20px; margin: 6px 0 4px; }
  p { margin: 0 0 14px; color: #a7b0c0; font-size: 13px; }
  .steps { margin: 0 0 18px; padding: 0; list-style: none; }
  .steps li { position: relative; padding-left: 22px; margin-bottom: 8px; color: #a7b0c0; font-size: 13px; }
  .steps li::before {
    content: attr(data-n); position: absolute; left: 0; top: 1px; width: 16px; height: 16px;
    border-radius: 50%; background: #2a3140; color: #9aa6bd; font-size: 10px;
    display: flex; align-items: center; justify-content: center;
  }
  .btn {
    display: block; width: 100%; text-align: center; text-decoration: none;
    background: #4f7cff; color: #fff; border-radius: 12px; padding: 12px 16px;
    font-weight: 600; font-size: 14px;
  }
  .btn:active { opacity: .85; }
  .hint { margin-top: 14px; font-size: 12px; color: #7c8598; }
  .spin {
    width: 14px; height: 14px; border-radius: 50%; border: 2px solid #2f3543; border-top-color: #4f7cff;
    display: inline-block; vertical-align: -2px; margin-right: 6px; animation: r .8s linear infinite;
  }
  @keyframes r { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">Our Free Model</div>
    <h1>连接 Raccoon</h1>
    <p><span class="spin"></span>正在打开商汤小浣熊官网登录页…</p>
    <ul class="steps">
      <li data-n="1">用手机号验证码或密码登录（官方扫码页已下线，请勿用扫码）</li>
      <li data-n="2">登录成功后会自动回到 App，无需手动复制任何东西</li>
    </ul>
    <a class="btn" href="${safeUrl}" id="go">手动打开登录页</a>
    <div class="hint">若长时间没有反应，点上面的按钮重试；还是不行就回 App 重新点「连接」。</div>
  </div>
  <script>
    // 顶层跳转：WebView 里登录态才是第一方 Cookie，才能被取到
    setTimeout(function () { location.replace(${JSON.stringify(url)}); }, 300);
    document.getElementById('go').addEventListener('click', function (e) {
      e.preventDefault();
      location.replace(${JSON.stringify(url)});
    });
  </script>
</body>
</html>`;
}
