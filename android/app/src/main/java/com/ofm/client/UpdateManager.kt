package com.ofm.client

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** 一次检查的结果。remote 只是用来在 UI 上写明「线上最新是 X」，不参与安装。 */
data class UpdateCheck(
    val current: String,
    val remote: String,
    val newer: Boolean,
    val info: UpdateInfo?
)

/** GitHub Release 里挑出来的可安装信息。 */
data class UpdateInfo(
    val version: String,
    val tag: String,
    val name: String,
    val notes: String,
    val htmlUrl: String,
    val apkName: String,
    val apkUrl: String,
    val apkSize: Long,
    val sumsUrl: String?,
    val publishedAt: String
)

/** 设置页「版本更新」卡的展示状态。 */
sealed class UpdateUiState {
    object Idle : UpdateUiState()
    object Checking : UpdateUiState()
    data class UpToDate(val current: String, val remote: String) : UpdateUiState()
    data class Available(val info: UpdateInfo) : UpdateUiState()
    data class Downloading(val progress: Float, val downloaded: Long, val total: Long) : UpdateUiState()
    object Verifying : UpdateUiState()
    /** 已下载并校验通过；needPermission=true 表示还差「安装未知应用」授权。 */
    data class Ready(val info: UpdateInfo, val file: String, val needPermission: Boolean) : UpdateUiState()
    data class Failed(val message: String) : UpdateUiState()
}

/**
 * 应用内更新：检查 GitHub Release → 下载 APK → 用 SHA256SUMS 校验 → 拉起系统安装。
 *
 * 三条硬约束：
 * 1. **不能静默安装**：targetSdk 34 只能 ACTION_VIEW 交给系统安装器，且要
 *    REQUEST_INSTALL_PACKAGES + 用户手动开「允许安装未知来源应用」；
 * 2. **官方优先、镜像兜底**：默认直连 api.github.com / github.com，填了加速前缀后
 *    先试镜像再回退官方，任一成功即可（国内直连经常被 TLS 掐断）；
 * 3. **必须校验完整性**：拿不到 SHA256SUMS.txt 或对不上就删包拒绝安装，
 *    绝不把来路不明的 APK 交给安装器。
 */
object UpdateManager {

    private const val REPO = "hrc-090/ofm-client"
    private const val LATEST_API = "https://api.github.com/repos/$REPO/releases/latest"
    private const val RELEASE_PAGE = "https://github.com/$REPO/releases/latest"
    private const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000

    private const val PREF = "ofm_prefs"
    private const val KEY_LAST_CHECK = "lastUpdateCheck"
    private const val KEY_MIRROR = "updateMirror"

    // ───────────────────────── 偏好 ─────────────────────────

    fun mirror(context: Context): String =
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_MIRROR, "").orEmpty()

    fun saveMirror(context: Context, value: String) {
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(KEY_MIRROR, value.trim()).apply()
    }

    /** 24 小时只自动查一次；手动检查不受此限制。 */
    fun shouldAutoCheck(context: Context): Boolean {
        val last = context.getSharedPreferences(PREF, Context.MODE_PRIVATE).getLong(KEY_LAST_CHECK, 0L)
        return System.currentTimeMillis() - last >= CHECK_INTERVAL_MS
    }

    fun markChecked(context: Context) {
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()
    }

    fun releasePage(): String = RELEASE_PAGE

    // ───────────────────────── 版本 ─────────────────────────

    fun currentVersion(context: Context): String = runCatching {
        val pm = context.packageManager
        val pi = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(context.packageName, 0)
        }
        pi.versionName ?: "0.0.0"
    }.getOrDefault("0.0.0")

    /** 逐段数字比较；「v0.3.0」「0.3.0-beta」「0.10.0」都能正确排序。 */
    fun compareVersions(a: String, b: String): Int {
        fun parts(v: String): List<Long> =
            Regex("\\d+").findAll(v.trim().removePrefix("v").removePrefix("V"))
                .map { it.value.toLong() }.toList()
        val pa = parts(a)
        val pb = parts(b)
        val n = maxOf(pa.size, pb.size)
        for (i in 0 until n) {
            val x = pa.getOrElse(i) { 0L }
            val y = pb.getOrElse(i) { 0L }
            if (x != y) return if (x > y) 1 else -1
        }
        return 0
    }

    // ───────────────────────── 检查 ─────────────────────────

    /**
     * 拉 releases/latest。任一候选返回可解析的 JSON 即成功；全部失败抛最后一个异常。
     * 走 IO 线程调用（MainActivity 里 withContext(Dispatchers.IO)）。
     */
    fun check(context: Context, mirrorPrefix: String): UpdateCheck {
        var lastError: Exception? = null
        for (url in candidates(LATEST_API, mirrorPrefix)) {
            try {
                val json = JSONObject(fetchText(url, 15000))
                val info = parseRelease(json)
                val current = currentVersion(context)
                return UpdateCheck(
                    current = current,
                    remote = info.version,
                    newer = compareVersions(info.version, current) > 0,
                    info = info
                )
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw lastError ?: IllegalStateException("检查更新失败")
    }

    private fun parseRelease(json: JSONObject): UpdateInfo {
        val tag = json.optString("tag_name").ifBlank { json.optString("name") }
        if (tag.isBlank()) throw IllegalStateException("Release 缺少 tag_name")
        val assets = json.optJSONArray("assets")
        var apk: Pair<String, String>? = null   // name -> url
        var apkSize = 0L
        var sumsUrl: String? = null
        var namedApk: Pair<String, String>? = null
        var namedSize = 0L
        if (assets != null) {
            for (i in 0 until assets.length()) {
                val a = assets.optJSONObject(i) ?: continue
                val name = a.optString("name")
                val url = a.optString("browser_download_url")
                if (name.equals("SHA256SUMS.txt", ignoreCase = true) && url.isNotBlank()) {
                    sumsUrl = url
                }
                if (name.endsWith(".apk", ignoreCase = true) && url.isNotBlank()) {
                    val size = a.optLong("size", 0L)
                    if (apk == null || size > apkSize) {
                        apk = name to url
                        apkSize = size
                    }
                    // 优先正式命名，避免选到历史文件名的 AP.apk
                    if (name.startsWith("ofm-client-", ignoreCase = true) &&
                        (namedApk == null || size > namedSize)
                    ) {
                        namedApk = name to url
                        namedSize = size
                    }
                }
            }
        }
        val chosen = namedApk ?: apk
            ?: throw IllegalStateException("这个 Release 里没有 APK 附件")
        val size = if (namedApk != null) namedSize else apkSize
        return UpdateInfo(
            version = tag.trim().removePrefix("v").removePrefix("V"),
            tag = tag,
            name = json.optString("name").ifBlank { tag },
            notes = json.optString("body").take(1500),
            htmlUrl = json.optString("html_url").ifBlank { RELEASE_PAGE },
            apkName = chosen.first,
            apkUrl = chosen.second,
            apkSize = size,
            sumsUrl = sumsUrl,
            publishedAt = json.optString("published_at").take(10)
        )
    }

    // ───────────────────────── 下载 ─────────────────────────

    fun updateDir(context: Context): File =
        File(context.cacheDir, "updates").apply { mkdirs() }

    /**
     * 下载 APK 到 cache/updates。进度回调在 IO 线程触发（Compose state 可跨线程写）。
     * 每次下载前清掉旧包，避免缓存目录堆一堆历史版本。
     */
    fun downloadApk(
        context: Context,
        info: UpdateInfo,
        mirrorPrefix: String,
        onProgress: (progress: Float, downloaded: Long, total: Long) -> Unit
    ): File {
        val dir = updateDir(context)
        dir.listFiles()?.filter { it.name.endsWith(".apk") }?.forEach { it.delete() }
        val target = File(dir, safeFileName(info.apkName))
        var lastError: Exception? = null
        for (url in candidates(info.apkUrl, mirrorPrefix)) {
            try {
                target.delete()
                downloadStreaming(url, target, info.apkSize, onProgress)
                if (sumsUrlMissing(info)) throw IllegalStateException("Release 缺 SHA256SUMS.txt")
                return target
            } catch (e: Exception) {
                target.delete()
                lastError = e
            }
        }
        throw lastError ?: IllegalStateException("下载失败")
    }

    private fun sumsUrlMissing(info: UpdateInfo) = info.sumsUrl.isNullOrBlank()

    /** 下载并校验；校验不过删包并抛可读错误。 */
    fun verifyOrThrow(file: File, info: UpdateInfo, mirrorPrefix: String) {
        if (!file.exists() || file.length() <= 0) throw IllegalStateException("安装包为空")
        if (info.apkSize > 0 && file.length() != info.apkSize) {
            throw IllegalStateException(
                "安装包大小不符（${file.length()} / ${info.apkSize}），可能被镜像截断"
            )
        }
        val sumsUrl = info.sumsUrl ?: throw IllegalStateException("Release 缺 SHA256SUMS.txt")
        val sums = readFromCandidates(sumsUrl, mirrorPrefix)
        val expected = expectedHash(sums, info.apkName)
            ?: throw IllegalStateException("校验文件里没有 ${info.apkName} 的记录")
        val actual = sha256(file)
        if (!actual.equals(expected, ignoreCase = true)) {
            file.delete()
            throw IllegalStateException("SHA256 校验失败，安装包已被删除，请换个镜像重试")
        }
    }

    /** SHA256SUMS.txt 里找 APK 名对应的 hash（兼容 `*` 二进制标记与 ./ 前缀）。 */
    fun expectedHash(sums: String, apkName: String): String? {
        val wanted = apkName.substringAfterLast('/').removePrefix("./").trim()
        for (line in sums.lineSequence()) {
            val parts = line.trim().split(Regex("\\s+"), limit = 2)
            if (parts.size != 2) continue
            val hash = parts[0].trim().lowercase()
            if (!Regex("[0-9a-f]{64}").matches(hash)) continue
            val name = parts[1].trim().removePrefix("*").removePrefix("./").trim()
            if (name == wanted) return hash
        }
        return null
    }

    // ───────────────────────── 安装 ─────────────────────────

    /** Android 8+ 需要用户在系统设置里允许本应用安装未知来源应用。 */
    fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    fun openInstallSettings(context: Context) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { context.startActivity(intent) }.onFailure {
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            runCatching { context.startActivity(fallback) }
        }
    }

    /** 拉起系统安装界面。调用前先确认 canInstall()。 */
    fun install(context: Context, file: File) {
        val uri = FileProvider.getUriForFile(
            context, "${context.packageName}.fileprovider", file
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    // ───────────────────────── 网络底座 ─────────────────────────

    /**
     * 候选 URL：填了加速前缀就先走镜像再回退官方；没填只走官方。
     * ghproxy 类镜像的约定是「前缀 + 原始完整 URL」。
     */
    fun candidates(url: String, mirrorPrefix: String): List<String> {
        val m = normalizeMirror(mirrorPrefix)
        return if (m.isEmpty()) listOf(url) else listOf("$m$url", url)
    }

    fun normalizeMirror(raw: String): String {
        var m = raw.trim().trimEnd('/')
        if (m.isEmpty()) return ""
        if (!m.startsWith("http://", true) && !m.startsWith("https://", true)) m = "https://$m"
        return "$m/"
    }

    private fun readFromCandidates(url: String, mirrorPrefix: String): String {
        var lastError: Exception? = null
        for (u in candidates(url, mirrorPrefix)) {
            try {
                return fetchText(u, 15000)
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw lastError ?: IllegalStateException("下载校验文件失败")
    }

    /** 手动跟随重定向：部分镜像会 302 到不同主机，交给 HttpURLConnection 默认逻辑不保险。 */
    private fun open(
        urlStr: String,
        connectMs: Int,
        readMs: Int = connectMs,
        redirectLeft: Int = 5
    ): HttpURLConnection {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        // 必须在 connect() 之前设；连上之后再改 readTimeout 对部分实现无效，
        // 下载 26MB 时若沿用 15s 读超时会在慢网络下被掐断。
        conn.connectTimeout = connectMs
        conn.readTimeout = readMs
        conn.instanceFollowRedirects = false
        // AGP 8 起 BuildConfig 不再带 VERSION_NAME；UA 只需非空，GitHub API 不校验值
        conn.setRequestProperty("User-Agent", "OFM-Android-Updater")
        conn.setRequestProperty("Accept", "application/vnd.github+json, */*")
        conn.connect()
        val code = conn.responseCode
        if (code in 300..399 && redirectLeft > 0) {
            val loc = conn.getHeaderField("Location")
            conn.disconnect()
            if (!loc.isNullOrBlank()) {
                val next = if (loc.startsWith("http", true)) loc else URL(URL(urlStr), loc).toString()
                return open(next, connectMs, readMs, redirectLeft - 1)
            }
        }
        if (code !in 200..299) {
            conn.disconnect()
            throw IllegalStateException("HTTP $code")
        }
        return conn
    }

    private fun fetchText(urlStr: String, timeoutMs: Int): String {
        val conn = open(urlStr, timeoutMs)
        try {
            return conn.inputStream.use { it.bufferedReader(Charsets.UTF_8).use { r -> r.readText() } }
        } finally {
            conn.disconnect()
        }
    }

    private fun downloadStreaming(
        urlStr: String,
        target: File,
        expectedSize: Long,
        onProgress: (Float, Long, Long) -> Unit
    ) {
        // 连接 15s（镜像挂住快速切下一个），读 60s（26MB 慢网络也不被掐断）
        val conn = open(urlStr, 15000, 60000)
        try {
            val total = if (expectedSize > 0) expectedSize else conn.getHeaderFieldLong("Content-Length", -1L)
            conn.inputStream.use { input ->
                FileOutputStream(target).use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val p = if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else -1f
                        onProgress(p, done, total)
                    }
                    out.flush()
                }
            }
        } finally {
            conn.disconnect()
        }
        if (target.length() <= 0) throw IllegalStateException("下载到空文件")
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private fun safeFileName(name: String): String =
        name.substringAfterLast('/').replace(Regex("[^A-Za-z0-9._-]"), "_")
}
