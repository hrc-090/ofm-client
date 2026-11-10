package com.ofm.client

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * 「网页搜索与读取」页（底栏一级页，从设置页的二级页提上来的）。
 *
 * 这一页的职责只有三件事：
 *   1. 开关：开/关对外的搜索能力；
 *   2. 告诉用户「第三方该填什么」——地址、Key、请求模板、结果字段，可一键复制；
 *   3. 验证：试搜 / 试读，当场确认链路通不通。
 *
 * **这里不再提供「自定义搜索 / 自定义读取」输入框**：
 * 那两个框是第三方客户端自己的设置页里的东西（用户在那里填本机地址），
 * 我们在自己 App 里再做一份只会让人误以为要填本机地址，反而填出「服务调用自己」的自环。
 * 后端仍保留 custom 引擎能力（老配置继续有效），但界面不再引导用户去配。
 */

private val ENGINE_ORDER = listOf("custom", "bing", "keenable", "exa", "parallel", "anysearch")
private val ENGINE_NAMES = mapOf(
    "custom" to "自定义接口",
    "bing" to "Bing",
    "keenable" to "Keenable",
    "exa" to "Exa",
    "parallel" to "Parallel",
    "anysearch" to "AnySearch"
)

private const val SEARCH_BODY = "{\"query\":\"{{query_json}}\",\"count\":{{count}}}"
private const val READ_BODY = "{\"url\":\"{{raw_url}}\"}"

@Composable
fun WebSearchScreen() {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var loadError by remember { mutableStateOf("") }

    var enabled by remember { mutableStateOf(false) }
    var order by remember { mutableStateOf(ENGINE_ORDER) }
    var disabled by remember { mutableStateOf(setOf<String>()) }
    var maxResults by remember { mutableStateOf(8) }

    // 第三方要填的东西（由服务端按真实端口和本机网卡算出来，不写死）
    var searchUrl by remember { mutableStateOf("") }
    var readUrl by remember { mutableStateOf("") }
    var mcpUrl by remember { mutableStateOf("") }
    var lanUrl by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var warnings by remember { mutableStateOf(emptyList<String>()) }

    var enginesExpanded by remember { mutableStateOf(false) }
    var readGuideExpanded by remember { mutableStateOf(false) }

    var testQuery by remember { mutableStateOf("今天 上海 天气") }
    var readTestUrl by remember { mutableStateOf("https://www.people.com.cn/") }
    var testBusy by remember { mutableStateOf(false) }
    var testReport by remember { mutableStateOf("") }
    var runtimeNote by remember { mutableStateOf("") }

    fun copyToClipboard(label: String, text: String) {
        if (text.isBlank()) return
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
        message = "已复制$label"
    }

    fun applyConfig(v: JSONObject) {
        enabled = v.optBoolean("enabled", false)
        maxResults = v.optInt("maxResults", 8)
        val arr = v.optJSONArray("engineOrder")
        val loaded = ArrayList<String>()
        if (arr != null) for (i in 0 until arr.length()) loaded.add(arr.optString(i))
        ENGINE_ORDER.forEach { if (!loaded.contains(it)) loaded.add(it) }
        order = loaded
        disabled = (v.optJSONArray("disabledEngines")?.let { a ->
            (0 until a.length()).map { a.optString(it) }.toSet()
        } ?: emptySet())

        val ep = v.optJSONObject("endpoints")
        if (ep != null) {
            searchUrl = ep.optString("search")
            readUrl = ep.optString("read")
            mcpUrl = ep.optString("mcp")
            apiKey = ep.optString("apiKey")
            val lans = ep.optJSONArray("lan")
            lanUrl = if (lans != null && lans.length() > 0) lans.optString(0).trimEnd('/') else ""
        }

        val ws = v.optJSONArray("warnings")
        warnings = if (ws == null) emptyList() else (0 until ws.length()).map { ws.optString(it) }

        val chain = v.optJSONObject("runtime")?.optJSONArray("chain")
        val cooling = ArrayList<String>()
        if (chain != null) {
            for (i in 0 until chain.length()) {
                val c = chain.optJSONObject(i) ?: continue
                if (c.optBoolean("cooling")) cooling.add(c.optString("label", c.optString("id")))
            }
        }
        runtimeNote = if (cooling.isEmpty()) "" else "冷却中：${cooling.joinToString("、")}"
    }

    LaunchedEffect(Unit) {
        val r = withContext(Dispatchers.IO) { runCatching { ApiClient.searchConfig() } }
        r.onSuccess {
            if (it.length() == 0) loadError = "服务未就绪，稍后重试" else applyConfig(it)
        }.onFailure { loadError = it.message ?: "读取配置失败" }
        loading = false
    }

    fun buildConfig(): JSONObject = JSONObject()
        .put("enabled", enabled)
        .put("maxResults", maxResults)
        .put("engineOrder", JSONArray(order))
        .put("disabledEngines", JSONArray(disabled.toList()))

    fun save() {
        scope.launch {
            saving = true
            message = ""
            val r = withContext(Dispatchers.IO) {
                runCatching { ApiClient.saveSearchConfig(buildConfig(), JSONObject()) }
            }
            saving = false
            r.onSuccess {
                it.optJSONObject("value")?.let { v -> applyConfig(v) }
                message = "已保存"
            }.onFailure { message = "保存失败：${it.message}" }
        }
    }

    Column(Modifier.fillMaxSize()) {
        /* 提到 dock 后搜索页是常驻一级页，没有「返回上一层」这回事。
           这行改成状态摘要：左侧刻度标签，右侧带圆点的状态胶囊，和仪器台其它页面一致。 */
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Eyebrow("WEB SEARCH  /  READ", Modifier.weight(1f))
            Pill(
                if (enabled) "已开启" else "已关闭",
                if (enabled) StatusTone.Ok else StatusTone.Wait
            )
        }

        LazyColumn(
            Modifier.weight(1f),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (loading) {
                item { Text("读取配置中…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            if (loadError.isNotBlank()) {
                item { Text(loadError, fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
            }

            /* ── 开关 ── */
            item {
                OfmCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("网页搜索与读取", style = MaterialTheme.typography.titleSmall)
                            Text(
                                "开启后第三方客户端可以通过本机接口搜索网页、读取正文",
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(checked = enabled, onCheckedChange = { enabled = it })
                    }
                    if (runtimeNote.isNotBlank()) {
                        Text(runtimeNote, fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
                    }
                    warnings.forEach {
                        Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
                    }
                    Text(
                        "关闭时三个接口都返回 503。搜索走内置回退链，不需要额外配置。",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            /* ── 第三方接入：填什么 ── */
            item {
                OfmCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("第三方怎么填", style = MaterialTheme.typography.titleSmall)
                            Text(
                                "把下面几项填进第三方客户端的「自定义搜索」里，就能直接搜",
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        TextButton(
                            onClick = {
                                copyToClipboard(
                                    "接入配置",
                                    buildString {
                                        appendLine("接口地址  ${searchUrl.ifBlank { "http://127.0.0.1:18900/v1/search" }}")
                                        appendLine("请求方式  POST")
                                        appendLine("API Key  ${apiKey.ifBlank { "ofm-local-key" }}")
                                        appendLine("请求模板  $SEARCH_BODY")
                                        appendLine("结果数组  results")
                                        appendLine("标题字段  title")
                                        appendLine("链接字段  url")
                                        appendLine("摘要字段  snippet")
                                        append("请求头  Authorization: Bearer ${apiKey.ifBlank { "ofm-local-key" }}")
                                    }
                                )
                            },
                            contentPadding = PaddingValues(horizontal = 6.dp)
                        ) { Text("复制", fontSize = 11.sp) }
                    }

                    KvRow("请求方式", "POST")
                    KvRow("接口地址", searchUrl) { copyToClipboard("接口地址", searchUrl) }
                    KvRow("API Key", apiKey) { copyToClipboard("API Key", apiKey) }
                    KvRow("请求模板", SEARCH_BODY, mono = true) { copyToClipboard("请求模板", SEARCH_BODY) }
                    KvRow("结果数组路径", "results")
                    KvRow("标题字段", "title")
                    KvRow("链接字段", "url")
                    KvRow("摘要字段", "snippet")
                    KvRow("请求头", "Authorization: Bearer $apiKey") {
                        copyToClipboard("请求头", "Authorization: Bearer $apiKey")
                    }

                    Text(
                        "第三方的「请求方式」必须选 POST；" +
                            "「请求头」这一栏如果不能填，就把 Key 填进「API Key」框，客户端会自动加 Bearer。" +
                            "两处都不填会返回 401。",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    if (lanUrl.isNotBlank()) {
                        Spacer(Modifier.height(6.dp))
                        Text("第三方在另一台设备（同在局域网）时，把地址换成：", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        KvRow("局域网地址", "$lanUrl/v1/search") { copyToClipboard("局域网地址", "$lanUrl/v1/search") }
                    }
                }
            }

            /* ── 读取怎么填 ── */
            item {
                OfmCard {
                    ExpandableRow(
                        title = "需要读取正文时怎么填",
                        expanded = readGuideExpanded,
                        onToggle = { readGuideExpanded = !readGuideExpanded }
                    )
                    if (readGuideExpanded) {
                        KvRow("请求方式", "POST")
                        KvRow("接口地址", readUrl) { copyToClipboard("接口地址", readUrl) }
                        KvRow("API Key", apiKey) { copyToClipboard("API Key", apiKey) }
                        KvRow("请求模板", READ_BODY, mono = true) { copyToClipboard("请求模板", READ_BODY) }
                        KvRow("正文字段", "text")
                        KvRow("标题字段", "title")
                        KvRow("链接字段", "final_url")
                        KvRow("请求头", "Authorization: Bearer $apiKey") {
                            copyToClipboard("请求头", "Authorization: Bearer $apiKey")
                        }
                        Text(
                            "返回的是正文纯文本，长文会截断；抓不到时自动回退到本地静态抓取。",
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            /* ── 内置引擎 ── */
            item {
                OfmCard {
                    ExpandableRow(
                        title = "内置引擎（顺序即回退顺序）",
                        expanded = enginesExpanded,
                        onToggle = { enginesExpanded = !enginesExpanded }
                    )
                    if (enginesExpanded) {
                        Text(
                            "实测国内可用：Bing、Keenable、Exa、Parallel、AnySearch。" +
                                "DDG / 公共 SearXNG / 百度网页版已被反爬或断连，未内置。",
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        order.forEachIndexed { idx, id ->
                            EngineRow(
                                name = ENGINE_NAMES[id] ?: id,
                                enabled = !disabled.contains(id),
                                canUp = idx > 0,
                                canDown = idx < order.size - 1,
                                onToggle = { on ->
                                    disabled = if (on) disabled - id else disabled + id
                                },
                                onUp = {
                                    val list = order.toMutableList()
                                    list.add(idx - 1, list.removeAt(idx))
                                    order = list
                                },
                                onDown = {
                                    val list = order.toMutableList()
                                    list.add(idx + 1, list.removeAt(idx))
                                    order = list
                                }
                            )
                        }
                        Text("每次搜索最多返回", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf(5, 8, 10).forEach { n ->
                                FilterChip(
                                    selected = maxResults == n,
                                    onClick = { maxResults = n },
                                    label = { Text("$n 条", fontSize = 11.sp) }
                                )
                            }
                        }
                    }
                }
            }

            /* ── 验证 ── */
            item {
                OfmCard {
                    Text("验证一下", style = MaterialTheme.typography.titleSmall)
                    Field("搜索词", testQuery, { testQuery = it }, "今天 上海 天气")
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                testBusy = true
                                testReport = ""
                                val r = withContext(Dispatchers.IO) { runCatching { ApiClient.testSearch(testQuery, maxResults) } }
                                testBusy = false
                                testReport = r.map { formatSearchTest(it) }.getOrElse { "试搜失败：${it.message}" }
                            }
                        },
                        enabled = !testBusy && enabled,
                        modifier = Modifier.fillMaxWidth()
                    ) { Text(if (testBusy) "搜索中…" else "试搜", fontSize = 12.sp) }

                    Field("网页地址", readTestUrl, { readTestUrl = it }, "https://example.com/article")
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                testBusy = true
                                testReport = ""
                                val r = withContext(Dispatchers.IO) { runCatching { ApiClient.testRead(readTestUrl) } }
                                testBusy = false
                                testReport = r.map { formatReadTest(it) }.getOrElse { "试读失败：${it.message}" }
                            }
                        },
                        enabled = !testBusy && enabled,
                        modifier = Modifier.fillMaxWidth()
                    ) { Text(if (testBusy) "读取中…" else "试读", fontSize = 12.sp) }

                    if (testReport.isNotBlank()) {
                        Text(
                            testReport,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    if (!enabled) {
                        Text("先打开上面的总开关，试搜/试读才可用。", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }

        Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
            Column(Modifier.padding(16.dp)) {
                if (message.isNotBlank()) {
                    Text(
                        message,
                        fontSize = 11.sp,
                        color = if (message.startsWith("已")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
                    )
                    Spacer(Modifier.height(8.dp))
                }
                Button(
                    onClick = { save() },
                    enabled = !saving && !loading,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp),
                    shape = RoundedCornerShape(14.dp)
                ) { Text(if (saving) "保存中…" else "保存", fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
            }
        }
    }
}

/** 一行「名称 → 值」，点值可复制 */
@Composable
private fun KvRow(
    label: String,
    value: String,
    mono: Boolean = true,
    onCopy: (() -> Unit)? = null
) {
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onCopy != null) Modifier.clickable { onCopy() } else Modifier)
            .padding(vertical = 3.dp),
        verticalAlignment = Alignment.Top
    ) {
        Text(
            label,
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(84.dp)
        )
        Text(
            value,
            fontSize = 11.sp,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f)
        )
    }
}

@Composable
private fun EngineRow(
    name: String,
    enabled: Boolean,
    canUp: Boolean,
    canDown: Boolean,
    onToggle: (Boolean) -> Unit,
    onUp: () -> Unit,
    onDown: () -> Unit
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            name,
            fontSize = 12.sp,
            modifier = Modifier.weight(1f),
            color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
        )
        TextButton(onClick = onUp, enabled = canUp, contentPadding = PaddingValues(horizontal = 6.dp)) {
            Text("↑", fontSize = 13.sp)
        }
        TextButton(onClick = onDown, enabled = canDown, contentPadding = PaddingValues(horizontal = 6.dp)) {
            Text("↓", fontSize = 13.sp)
        }
        Switch(checked = enabled, onCheckedChange = onToggle)
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    placeholder: String = "",
    mono: Boolean = false,
    minLines: Int = 1
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label, fontSize = 11.sp) },
        placeholder = { if (placeholder.isNotBlank()) Text(placeholder, fontSize = 11.sp) },
        modifier = Modifier.fillMaxWidth(),
        textStyle = if (mono) MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyMedium,
        singleLine = minLines == 1,
        minLines = minLines,
        shape = RoundedCornerShape(12.dp)
    )
}

@Composable
private fun ExpandableRow(title: String, expanded: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onToggle() }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(title, fontSize = 12.sp, modifier = Modifier.weight(1f))
        Text(if (expanded) "▴" else "▾", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun formatSearchTest(o: JSONObject): String {
    if (!o.optBoolean("ok")) return "试搜失败：${o.optString("error", "未知错误")}"
    val v = o.optJSONObject("value") ?: return "试搜失败：无返回"
    val sb = StringBuilder()
    sb.append("来源：").append(v.optString("provider"))
    sb.append(" · ").append(v.optInt("ms")).append("ms")
    sb.append(" · ").append(v.optInt("count", v.optJSONArray("results")?.length() ?: 0)).append(" 条")
    if (v.optBoolean("cached")) sb.append(" · 缓存")
    val note = v.optString("note")
    if (note.isNotBlank()) sb.append("\n").append(note)
    val arr = v.optJSONArray("results")
    if (arr != null) {
        for (i in 0 until minOf(3, arr.length())) {
            val r = arr.optJSONObject(i) ?: continue
            sb.append("\n").append(i + 1).append(". ").append(r.optString("title").take(40))
            sb.append("\n   ").append(r.optString("url").take(70))
        }
    }
    return sb.toString()
}

private fun formatReadTest(o: JSONObject): String {
    if (!o.optBoolean("ok")) return "试读失败：${o.optString("error", "未知错误")}"
    val v = o.optJSONObject("value") ?: return "试读失败：无返回"
    return buildString {
        append("来源：").append(v.optString("provider"))
        append(" · ").append(v.optInt("ms")).append("ms")
        append(" · ").append(v.optInt("chars")).append(" 字符")
        if (v.optBoolean("truncated")) append("（已截断）")
        val title = v.optString("title")
        if (title.isNotBlank()) append("\n标题：").append(title.take(50))
        val sample = v.optString("sample")
        if (sample.isNotBlank()) append("\n").append(sample.take(200))
    }
}
