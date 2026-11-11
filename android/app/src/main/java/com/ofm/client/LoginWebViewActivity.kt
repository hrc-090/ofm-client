package com.ofm.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * 授权页承载 + 本地回调拦截 + Cookie 导入。
 *
 * Android 上「本地回调」不必真的起监听端口：WebView 拦到
 * http://127.0.0.1:18080/... 之后把整条 URL 交给 Node 侧完成换取 token。
 * 这样也不受端口被占用影响。
 *
 * Cookie 模式（Raccoon）：官网扫码落地页已 404，改为加载官网正常的 /login，
 * 用户用手机号登录后，从 WebView 的 Cookie 里取 xhx_token / raccoon_token
 * 回传给 Node 验活。必须是 WebView（系统浏览器拿不到同源 Cookie）。
 */
class LoginWebViewActivity : Activity() {

    companion object {
        private const val EXTRA_ACCOUNT = "accountId"
        private const val EXTRA_URL = "loginUrl"
        private const val EXTRA_MODE = "mode"
        const val MODE_CALLBACK = "callback"
        const val MODE_COOKIE = "cookie"

        private const val COOKIE_HOST = "https://xiaohuanxiong.com"
        private val TOKEN_COOKIES = listOf("xhx_token=", "raccoon_token=")

        fun intent(
            context: Context,
            accountId: String,
            loginUrl: String,
            mode: String = MODE_CALLBACK
        ): Intent =
            Intent(context, LoginWebViewActivity::class.java)
                .putExtra(EXTRA_ACCOUNT, accountId)
                .putExtra(EXTRA_URL, loginUrl)
                .putExtra(EXTRA_MODE, mode)
    }

    private lateinit var webView: WebView
    private var accountId: String = ""
    private var handled = false
    private var cookieMode = false
    /** 已经提交过、但被 Node 判无效的 Cookie 串，避免同一串反复打接口 */
    private var triedCookie: String? = null
    private val handler = Handler(Looper.getMainLooper())
    private val cookiePoll = object : Runnable {
        override fun run() {
            if (handled || isFinishing) return
            checkCookies()
            handler.postDelayed(this, 1200)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        accountId = intent.getStringExtra(EXTRA_ACCOUNT) ?: ""
        val startUrl = intent.getStringExtra(EXTRA_URL) ?: ""
        cookieMode = intent.getStringExtra(EXTRA_MODE) == MODE_COOKIE

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }

        val hintView = TextView(this).apply {
            text = if (cookieMode) {
                "登录成功后会自动返回；用手机号验证码或密码登录（官方扫码页已下线）"
            } else {
                "完成授权后会自动返回；若停在回调页，复制地址栏链接粘贴到下面"
            }
            textSize = 12f
            setPadding(24, 24, 24, 8)
        }
        root.addView(hintView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val pasteRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(24, 0, 24, 8)
        }
        val input = EditText(this).apply {
            hint = "http://127.0.0.1:18080/authorize?…"
            inputType = InputType.TYPE_CLASS_TEXT
            textSize = 12f
        }
        pasteRow.addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val submit = Button(this).apply { text = "提交" }
        pasteRow.addView(submit)
        if (cookieMode) pasteRow.visibility = android.view.View.GONE
        root.addView(pasteRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        // Cookie 模式必须开 Cookie + 第三方 Cookie：登录页里可能有 iframe/跨站跳转
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                cookieManager.setAcceptThirdPartyCookies(this, true)
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    return maybeHandleCallback(url)
                }

                @Deprecated("老 WebView 兼容")
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                    return url != null && maybeHandleCallback(url)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    if (cookieMode) checkCookies()
                }
            }
            loadUrl(startUrl)
        }
        root.addView(webView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        submit.setOnClickListener {
            if (cookieMode) return@setOnClickListener
            val url = input.text?.toString()?.trim().orEmpty()
            if (url.isEmpty()) return@setOnClickListener
            if (!maybeHandleCallback(url)) {
                Toast.makeText(this, "这个链接不是本机回调地址", Toast.LENGTH_SHORT).show()
            }
        }

        if (cookieMode) handler.postDelayed(cookiePoll, 1500)
    }

    /** Cookie 模式：轮询 WebView 的站点 Cookie，出现登录 token 就交给 Node 验活 */
    private fun checkCookies() {
        if (!cookieMode || handled) return
        val cookies = CookieManager.getInstance().getCookie(COOKIE_HOST) ?: return
        if (TOKEN_COOKIES.none { cookies.contains(it) }) return
        if (cookies == triedCookie) return
        triedCookie = cookies

        handled = true
        Toast.makeText(this, "已读取登录态，正在校验…", Toast.LENGTH_SHORT).show()
        thread {
            val result = runCatching {
                ApiClient.post("/api/accounts/$accountId/cookie", JSONObject().put("cookie", cookies))
            }
            runOnUiThread {
                val ok = result.getOrNull()?.optBoolean("success") == true
                if (ok) {
                    CookieManager.getInstance().flush()
                    Toast.makeText(this, "登录成功", Toast.LENGTH_SHORT).show()
                    setResult(RESULT_OK)
                    finish()
                } else {
                    val why = result.exceptionOrNull()?.message
                        ?: result.getOrNull()?.optString("error").orEmpty()
                    Toast.makeText(this, "登录态校验失败：${why.ifBlank { "请重试" }}", Toast.LENGTH_LONG).show()
                    // Node 侧失败会删掉占位账号，重试同一个会话没有意义，直接收尾
                    setResult(RESULT_CANCELED)
                    finish()
                }
            }
        }
    }

    private fun maybeHandleCallback(url: String): Boolean {
        if (handled) return true
        val isLocal = url.startsWith("http://127.0.0.1:18080") ||
            url.startsWith("http://localhost:18080") ||
            (url.startsWith("http://127.0.0.1") && (url.contains("/authorize") || url.contains("/auth/callback") || url.contains("/oauth-callback")))
        if (!isLocal) return false

        handled = true
        Toast.makeText(this, "已收到回调，正在换取凭据…", Toast.LENGTH_SHORT).show()

        thread {
            val result = runCatching {
                ApiClient.post("/api/accounts/$accountId/callback", JSONObject().put("url", url))
            }
            runOnUiThread {
                val ok = result.getOrNull()?.optBoolean("success") == true
                Toast.makeText(
                    this,
                    if (ok) "登录成功" else "登录失败：${result.exceptionOrNull()?.message ?: result.getOrNull()?.optString("error")}",
                    Toast.LENGTH_LONG
                ).show()
                if (ok) {
                    setResult(RESULT_OK)
                    finish()
                } else {
                    handled = false
                }
            }
        }
        return true
    }

    override fun onDestroy() {
        handler.removeCallbacks(cookiePoll)
        webView.destroy()
        super.onDestroy()
    }
}
