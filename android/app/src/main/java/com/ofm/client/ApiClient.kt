package com.ofm.client

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * 管理接口客户端。所有请求都打本机回环，鉴权用 runtime.json 里的 uiToken。
 */
object ApiClient {

    private fun open(path: String, method: String, body: String?): HttpURLConnection {
        val url = URL(ApiService.baseUrl + path)
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 8000
        // 网络自检逐层探测、对话自检要发一条真实请求（内部上限 75s），单独放宽
        conn.readTimeout = when {
            path.startsWith("/api/chat/diagnose") -> 100000
            path.startsWith("/api/network/diagnose") -> 60000
            // 试搜要等完整回退链（最多 30s），试读要等远端/本地抓取
            path.startsWith("/api/search/test") -> 60000
            path.startsWith("/api/search/read") -> 45000
            else -> 20000
        }
        conn.setRequestProperty("x-ofm-ui-token", ApiService.uiToken)
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.outputStream.use { it.write(body.toByteArray()) }
        }
        return conn
    }

    private fun readText(conn: HttpURLConnection): String {
        val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
        return stream?.let {
            BufferedReader(InputStreamReader(it, "UTF-8")).use { r -> r.readText() }
        } ?: ""
    }

    private fun read(conn: HttpURLConnection): JSONObject {
        val text = readText(conn)
        if (text.isBlank()) return JSONObject()
        return runCatching { JSONObject(text) }.getOrElse { JSONObject().put("raw", text) }
    }

    fun get(path: String): JSONObject = read(open(path, "GET", null))

    fun post(path: String, body: JSONObject? = null): JSONObject =
        read(open(path, "POST", body?.toString() ?: "{}"))

    fun patch(path: String, body: JSONObject): JSONObject =
        read(open(path, "PATCH", body.toString()))

    fun delete(path: String): JSONObject = read(open(path, "DELETE", null))

    // ── 用量看板 / 运行日志（Node 侧 /api/usage/*）──
    fun usageSummary(days: Int): JSONObject = get("/api/usage/summary?days=$days")

    fun usageLog(limit: Int, days: Int = 0): JSONObject =
        get("/api/usage/log?limit=$limit&days=$days")

    fun clearUsage(): JSONObject = delete("/api/usage")

    /**
     * 按模型保存默认思考档位。value 为 null 表示清除该模型的默认值，
     * 回到「完全跟随客户端请求里的 reasoning_effort」。
     */
    fun setModelEffort(modelId: String, value: String?): JSONObject {
        val b = JSONObject().put("modelEffort", JSONObject().put(modelId, value ?: ""))
        return post("/api/settings", b)
    }

    fun accounts(): List<Account> {
        val arr: JSONArray = get("/api/accounts").optJSONArray("data") ?: return emptyList()
        return (0 until arr.length()).map { Account.from(arr.getJSONObject(it)) }
    }

    fun providers(): List<Provider> {
        val arr = get("/api/providers").optJSONArray("data") ?: return emptyList()
        return (0 until arr.length()).map { Provider.from(arr.getJSONObject(it)) }
    }

    fun models(): List<String> {
        val arr = get("/api/models").optJSONArray("data") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { arr.getJSONObject(it).optString("id").takeIf { id -> id.isNotBlank() } }
    }

    /** 18080 端口不通时的兜底：把浏览器地址栏整条回调链接直接送回 Node 换 token。 */
    fun completeLogin(url: String, accountId: String? = null): JSONObject {
        val b = JSONObject().put("url", url)
        if (!accountId.isNullOrBlank()) b.put("accountId", accountId)
        return post("/api/login/complete", b)
    }

    /** 设成自己的固定 Key；留空 = 恢复固定默认值。返回 {ok, key} 或 {ok:false, error}。 */
    fun setApiKey(key: String): JSONObject =
        post("/api/settings/key", JSONObject().put("key", key))

    /** 18080 是否真的在听（没在听就引导用户改用粘贴方式）。 */
    fun callbackListening(status: JSONObject = get("/api/status")): Boolean =
        status.optJSONObject("callback")?.optBoolean("listening") == true

    /** 出站网络分步自检：DNS / TCP / TLS / HTTPS 每层结果，可原样复制给开发者。 */
    fun networkDiagnose(): JSONObject = get("/api/network/diagnose")

    /** 对话链路自检：发一条 hi 真实请求，逐层定位「接入 API 无回复」。
     *  probeTools = true 时带一个 ofm_echo 工具，用来验证上游到底支不支持工具调用。 */
    fun chatDiagnose(model: String? = null, probeTools: Boolean = false): JSONObject {
        val b = JSONObject()
        if (!model.isNullOrBlank()) b.put("model", model.trim())
        if (probeTools) b.put("probeTools", true)
        return post("/api/chat/diagnose", b)
    }

    // ── 签到 / 领取积分（说明书 §2）──
    fun creditCapabilities(): List<CreditCapability> {
        val arr = get("/api/checkin/capabilities").optJSONObject("value")
            ?.optJSONArray("capabilities") ?: return emptyList()
        return (0 until arr.length()).map { CreditCapability.from(arr.getJSONObject(it)) }
    }

    fun checkinStatus(provider: String): JSONObject =
        post("/api/checkin/status", JSONObject().put("provider", provider))

    fun checkinClaim(provider: String): JSONObject =
        post("/api/checkin/claim", JSONObject().put("provider", provider))

    fun checkinBalances(provider: String, force: Boolean = false): JSONObject =
        post("/api/checkin/balances", JSONObject().put("provider", provider).put("force", force))

    /** 三个字段都省略 = 只读；enabled 非空 = 写开关；dismiss = 关掉本轮状态文字。 */
    fun checkinAuto(enabled: Boolean? = null, dismiss: Boolean = false): JSONObject {
        val b = JSONObject()
        if (enabled != null) b.put("enabled", enabled)
        if (dismiss) b.put("dismiss", true)
        return post("/api/checkin/auto", b)
    }

    // ── 签到日志（Node 侧 /api/checkin/log）──
    fun checkinLog(limit: Int): JSONObject = get("/api/checkin/log?limit=$limit")

    /** 纯文本报告，已脱敏，供「复制日志」一键贴给开发者。 */
    fun checkinLogText(limit: Int): String =
        readText(open("/api/checkin/log?limit=$limit&format=text", "GET", null))

    fun clearCheckinLog(): JSONObject = delete("/api/checkin/log")

    // ── 网页搜索与读取（Node 侧 /api/search/*）──

    /** 配置 + Key 尾号 + 运行时状态（引擎链路 / 冷却 / 缓存条数）。 */
    fun searchConfig(): JSONObject = get("/api/search/config").optJSONObject("value") ?: JSONObject()

    /**
     * 保存配置。config 与 keys 分开传：Key 只在这里出现一次明文，
     * 读回来永远只有尾号，避免界面反复展示密钥。
     */
    fun saveSearchConfig(config: JSONObject, keys: JSONObject): JSONObject =
        post("/api/search/config", JSONObject().put("config", config).put("keys", keys))

    /** 试搜：真跑一次查询，回 provider / 耗时 / 结果，用来判断配置到底通不通。 */
    fun testSearch(query: String, count: Int): JSONObject =
        post("/api/search/test", JSONObject().put("query", query).put("count", count))

    /** 试读：抓一个 URL，回来源（custom/local/keenable）、字数与样本。 */
    fun testRead(url: String): JSONObject =
        post("/api/search/read", JSONObject().put("url", url))

    fun searchLog(limit: Int): JSONObject = get("/api/search/log?limit=$limit")
}

/** 渠道签到能力表（决定 UI 要不要给按钮）。 */
data class CreditCapability(
    val provider: String,
    val dailyCheckin: Boolean,
    val onboardingTasks: Boolean,
    val balance: Boolean,
    val quotaOnly: Boolean,
    val autoExcluded: Boolean,
    val note: String
) {
    companion object {
        fun from(o: JSONObject) = CreditCapability(
            provider = o.optString("provider"),
            dailyCheckin = o.optBoolean("dailyCheckin"),
            onboardingTasks = o.optBoolean("onboardingTasks"),
            balance = o.optBoolean("balance"),
            quotaOnly = o.optBoolean("quotaOnly"),
            autoExcluded = o.optBoolean("autoExcluded"),
            note = o.optString("note")
        )
    }
}

data class Account(
    val id: String,
    val provider: String,
    val nickname: String,
    val enabled: Boolean,
    val pending: Boolean,
    val needsLogin: Boolean,
    val expiresAt: Long
) {
    companion object {
        fun from(o: JSONObject) = Account(
            id = o.optString("id"),
            provider = o.optString("provider"),
            nickname = o.optString("nickname"),
            enabled = o.optBoolean("enabled", true),
            pending = o.optBoolean("pending", false),
            needsLogin = o.optBoolean("needsLogin", false),
            expiresAt = o.optLong("expiresAt", 0L)
        )
    }
}

data class Provider(
    val id: String,
    val displayName: String,
    val loginMode: String,
    val supported: Boolean,
    val note: String
) {
    companion object {
        fun from(o: JSONObject) = Provider(
            id = o.optString("id"),
            displayName = o.optString("displayName"),
            loginMode = o.optString("loginMode"),
            supported = o.optBoolean("supported", true),
            note = o.optString("note")
        )
    }
}
