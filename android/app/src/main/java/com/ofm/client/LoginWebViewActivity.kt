package com.ofm.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
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
 * 授权页承载 + 本地回调拦截。
 *
 * Android 上「本地回调」不必真的起监听端口：WebView 拦到
 * http://127.0.0.1:18080/... 之后把整条 URL 交给 Node 侧完成换取 token。
 * 这样也不受端口被占用影响。
 */
class LoginWebViewActivity : Activity() {

    companion object {
        private const val EXTRA_ACCOUNT = "accountId"
        private const val EXTRA_URL = "loginUrl"

        fun intent(context: Context, accountId: String, loginUrl: String): Intent =
            Intent(context, LoginWebViewActivity::class.java)
                .putExtra(EXTRA_ACCOUNT, accountId)
                .putExtra(EXTRA_URL, loginUrl)
    }

    private lateinit var webView: WebView
    private var accountId: String = ""
    private var handled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        accountId = intent.getStringExtra(EXTRA_ACCOUNT) ?: ""
        val startUrl = intent.getStringExtra(EXTRA_URL) ?: ""

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }

        val hintView = TextView(this).apply {
            text = "完成授权后会自动返回；若停在回调页，复制地址栏链接粘贴到下面"
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
        root.addView(pasteRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    return maybeHandleCallback(url)
                }

                @Deprecated("老 WebView 兼容")
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                    return url != null && maybeHandleCallback(url)
                }
            }
            loadUrl(startUrl)
        }
        root.addView(webView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        submit.setOnClickListener {
            val url = input.text?.toString()?.trim().orEmpty()
            if (url.isEmpty()) return@setOnClickListener
            if (!maybeHandleCallback(url)) {
                Toast.makeText(this, "这个链接不是本机回调地址", Toast.LENGTH_SHORT).show()
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
        webView.destroy()
        super.onDestroy()
    }
}
