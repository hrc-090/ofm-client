package com.ofm.client

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * 可选思考档位来自上游模型目录，值原样透传、不做映射。
 * 多数模型目录并不列可选值，这时统一给一组通用档位兜底，
 * 否则界面上一个可选项都没有，等于没法改思考强度。
 */
private fun parseEffortOptions(arr: JSONArray?): List<EffortOption> {
    val out = ArrayList<EffortOption>()
    if (arr != null) {
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i)
            val value = if (o != null) {
                o.optString("value").ifBlank { o.optString("effort") }
                    .ifBlank { o.optString("level") }.ifBlank { o.optString("id") }
            } else arr.optString(i)
            if (value.isBlank()) continue
            val label = o?.optString("label")?.ifBlank { value } ?: value
            if (out.none { it.value == value }) out.add(EffortOption(value, label))
        }
    }
    if (out.isEmpty()) {
        listOf("low", "medium", "high").forEach { out.add(EffortOption(it, it)) }
    }
    return out
}

/** 展示字段长度上限：超长脏串会让单个 Text 的 StaticLayout 撑爆内存。 */
private fun String.safeField(max: Int): String =
    if (length <= max) this else "${take(max - 1)}…"

class MainActivity : ComponentActivity() {

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashHandler.install(this)
        if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        ApiService.start(this)
        setContent { OfmTheme { AppScreen() } }
    }
}

/* 底栏固定五项：模型与积分合并成一项，腾出的一格给网页搜索（原来是设置里的二级页）。
   设置仍用 tab=5 由右上角齿轮进入，不占底栏位置。 */
private val TABS = listOf("概览", "渠道", "模型", "用量", "搜索")
/* 顶栏用完整页名，底栏标签要短才排得下；只有搜索页两者不同 */
private val TAB_TITLES = listOf("概览", "渠道", "模型", "用量", "网页搜索与读取")
private val TAB_SUBTITLES = listOf(
    "服务状态与接入信息",
    "登录渠道与管理账号",
    "模型目录、积分倍率与每日签到",
    "用量看板与运行日志",
    "第三方接入字段与试搜"
)
private const val SETTINGS_SUBTITLE = "凭据、诊断与运行"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var running by remember { mutableStateOf(ApiService.running) }
    var port by remember { mutableStateOf(ApiService.port) }
    var apiKey by remember { mutableStateOf(ApiService.apiKey) }
    var enabled by remember { mutableStateOf(true) }
    var accounts by remember { mutableStateOf<List<Account>>(emptyList()) }
    var providers by remember { mutableStateOf<List<Provider>>(emptyList()) }
    var models by remember { mutableStateOf<List<ModelItem>>(emptyList()) }
    var message by remember { mutableStateOf("") }
    // 上次进程退出的原因（跨进程重启后仍可读），便于定位「第二次打不开」
    var lastError by remember { mutableStateOf(ApiService.readLastError(context)) }
    val prefs = remember { context.getSharedPreferences("ofm_prefs", Context.MODE_PRIVATE) }
    // 默认用系统浏览器登录：OAuth 页在 Chrome 里兼容性更好，回调由本机 18080 端口接住
    var useExternalBrowser by remember { mutableStateOf(prefs.getBoolean("externalBrowser", true)) }
    // 短信登录用状态驱动对话框：Composable 只能在 Composable 作用域里调用
    var smsAccount by remember { mutableStateOf<String?>(null) }
    // 18080 是否真的在听；没在听就引导用户改用「粘贴回调链接」
    var callbackListening by remember { mutableStateOf(false) }
    var showPasteDialog by remember { mutableStateOf(false) }
    var modelsHint by remember { mutableStateOf("") }
    // 按模型保存的默认思考档位，来自 /api/status，客户端未显式传值时生效
    var modelEffort by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var showKeyDialog by remember { mutableStateOf(false) }
    // 自检报告（可复制）：网络/账号自检定位「模型 / 余额拉取失败」，
    // 对话自检定位「第三方接入 API 无回复」。两者共用一个报告对话框。
    var netBusy by remember { mutableStateOf(false) }
    var chatBusy by remember { mutableStateOf(false) }
    var toolBusy by remember { mutableStateOf(false) }
    var reportTitle by remember { mutableStateOf("自检结果") }
    var reportText by remember { mutableStateOf<String?>(null) }
    // 最近一次 callback 登录的 accountId。持久化只为给出准确提示，
    // 真正的会话在 Node 内存里，App 被杀后仍须重新点「连接」。
    var lastCallbackAccountId by remember { mutableStateOf(prefs.getString("lastCallbackAccountId", null)) }
    var tab by remember { mutableStateOf(0) }
    // 底栏固定五个内容页（0..4，含独立的网页搜索）；设置用 tab=5 表示，
    // 由右上角齿轮进入，这样不用把整棵页面树重排，底栏也不会高亮任何一项。
    val settingsOpen = tab == 5
    // 首次启动引导：只在「还没问过」且电池优化没进白名单时弹一次。
    // 不弹的后果很具体 —— 息屏十几分钟后系统掐掉网络，第三方调用全超时，
    // 用户以为是 App 坏了。
    var showKeepAliveTip by remember {
        mutableStateOf(!prefs.getBoolean("keepAliveAsked", false) && !KeepAlive.isIgnoringBattery(context))
    }

    /**
     * 轮询刷新。**内容不变就不替换 state 实例**：模型页是 LazyColumn，之前每 1.5s
     * 无条件换一份新 List，fling 期间会触发全量重组；某次请求抖动拿到 null 时又把
     * 列表瞬间清空，item 数在 0 与 N 之间跳，滚动位置反复越界 —— 表现就是
     * 「一直下滑就闪退」。这里做三件事：幂等赋值、失败保留旧目录、降低轮询频率。
     */
    suspend fun refresh() = withContext(Dispatchers.IO) {
        runCatching {
            val status = ApiClient.get("/api/status")
            enabled = status.optBoolean("enabled", true)
            callbackListening = status.optJSONObject("callback")?.optBoolean("listening") == true
            val effObj = status.optJSONObject("modelEffort")
            val nextEffort = if (effObj == null) emptyMap() else {
                val m = HashMap<String, String>()
                val keys = effObj.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    val v = effObj.optString(k)
                    if (k.isNotBlank() && v.isNotBlank()) m[k] = v
                }
                m
            }
            if (nextEffort != modelEffort) modelEffort = nextEffort
            port = ApiService.port
            apiKey = ApiService.apiKey
            val nextAccounts = ApiClient.accounts()
            if (nextAccounts != accounts) accounts = nextAccounts
            val nextProviders = ApiClient.providers().filter { it.supported }
            if (nextProviders != providers) providers = nextProviders

            // 一次请求同时取列表和「为什么是空的」提示，避免第三方拿到空列表时以为坏了
            val modelResp = ApiClient.get("/api/models")
            val arr = modelResp.optJSONArray("data")
            // data 缺失/解析失败时保留上一份目录，绝不在滚动中把列表抖成空
            if (arr != null) {
                val next = (0 until arr.length()).mapNotNull { i ->
                    val o = arr.getJSONObject(i)
                    val id = o.optString("id").safeField(160)
                    if (id.isBlank()) null else ModelItem(
                        id = id,
                        model = o.optString("model").ifBlank { id.substringAfter('/') }.safeField(120),
                        name = o.optString("display_name").ifBlank {
                            o.optString("model").ifBlank { id.substringAfter('/') }
                        }.safeField(120),
                        rate = formatCreditsRate(o).safeField(24),
                        originalRate = formatOriginalRate(o).safeField(24),
                        images = o.optBoolean("supports_images"),
                        reasoning = o.optBoolean("supports_reasoning"),
                        fallback = o.optBoolean("fallback"),
                        contextWindow = o.optLong("context_window", 0L),
                        reasoningOptions = parseEffortOptions(o.optJSONArray("reasoning_options")).take(12),
                        channel = o.optString("provider_name").ifBlank {
                            o.optString("provider").ifBlank { id.substringBefore('/') }
                        }.safeField(24)
                    )
                }.distinctBy { it.id }
                if (next != models) models = next
            }
            modelsHint = modelResp.optString("hint").safeField(400)
        }.onFailure { message = it.message ?: "连接本地服务失败" }
    }

    LaunchedEffect(Unit) {
        while (true) {
            running = ApiService.running
            lastError = ApiService.lastError ?: ApiService.readLastError(context)
            if (ApiService.running) refresh()
            // 3s 而不是 1.5s：模型页 fling 期间每轮都会解析整份目录并重组整棵树，
            // 减半后滚动动画不再被周期性打断，状态刷新仍足够及时。
            delay(3000)
        }
    }

    /** 设备码 / 扫码 / 系统浏览器回调：统一轮询到会话结束 */
    suspend fun awaitLoginDone(accountId: String, name: String) {
        var done = false
        for (i in 0 until 300) {
            delay(1000)
            val r2 = withContext(Dispatchers.IO) { ApiClient.get("/api/login/poll?accountId=$accountId") }
            if (r2.optBoolean("done")) {
                done = true
                message = if (r2.optBoolean("success")) "$name 已连接" else r2.optString("error")
                break
            }
        }
        if (!done) message = "登录等待超时。若浏览器提示无法打开，复制地址栏整条链接，点「粘贴回调链接完成登录」"
    }

    fun startLogin(p: Provider) {
        scope.launch {
            runCatching {
                val r = withContext(Dispatchers.IO) { ApiClient.post("/api/accounts", JSONObject().put("provider", p.id)) }
                val accountId = r.optString("accountId")
                val loginUrl = r.optString("loginUrl")
                val mode = r.optString("mode")
                message = "已发起 ${p.displayName} 登录"
                if (mode == "callback" && !useExternalBrowser) {
                    // App 内 WebView：拦 127.0.0.1:18080 回调后交给 Node
                    context.startActivity(LoginWebViewActivity.intent(context, accountId, loginUrl))
                } else if (mode == "sms") {
                    smsAccount = accountId
                } else {
                    if (mode == "callback") {
                        // 先登记会话，18080 端口收到浏览器回调时才知道该写哪个账号
                        lastCallbackAccountId = accountId
                        prefs.edit().putString("lastCallbackAccountId", accountId).apply()
                        withContext(Dispatchers.IO) {
                            ApiClient.post("/api/login/browser-target", JSONObject().put("accountId", accountId))
                        }
                        message = "已在浏览器打开。授权后若提示「无法打开 / ERR_CONNECTION_REFUSED」，" +
                            "复制地址栏整条链接，回 App 点「粘贴回调链接完成登录」"
                    }
                    if (loginUrl.isNotBlank()) {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse(loginUrl))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                    }
                    awaitLoginDone(accountId, p.displayName)
                }
                refresh()
            }.onFailure { message = it.message ?: "登录失败" }
        }
    }

    fun toggleService(v: Boolean) {
        enabled = v
        scope.launch {
            withContext(Dispatchers.IO) { ApiClient.post("/api/settings", JSONObject().put("enabled", v)) }
        }
    }

    smsAccount?.let { id ->
        SmsDialog(
            accountId = id,
            onDone = { refresh(); smsAccount = null },
            onDismiss = { smsAccount = null }
        )
    }

    if (showPasteDialog) {
        PasteCallbackDialog(
            initialAccountId = lastCallbackAccountId,
            onDone = { refresh() },
            onDismiss = { showPasteDialog = false }
        )
    }

    if (showKeyDialog) {
        ApiKeyDialog(
            current = apiKey,
            onDone = { refresh() },
            onDismiss = { showKeyDialog = false }
        )
    }

    if (showKeepAliveTip) {
        AlertDialog(
            onDismissRequest = {
                prefs.edit().putBoolean("keepAliveAsked", true).apply()
                showKeepAliveTip = false
            },
            title = { Text("让服务不在后台被清掉") },
            text = {
                Column {
                    Text(
                        "本机 API 是给第三方客户端长期调用的，息屏后如果被系统限制，" +
                            "对方会一直超时。建议做三件事：",
                        fontSize = 12.sp
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("1. 允许本应用忽略电池优化", fontSize = 12.sp)
                    Text("2. 允许发送通知（前台服务需要它才不会被降级）", fontSize = 12.sp)
                    Text("3. 在系统的自启动管理里允许后台运行", fontSize = 12.sp)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "点「去设置」会打开电池优化页；后两项在 App 的「设置 → 后台保活」里也能进。",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    prefs.edit().putBoolean("keepAliveAsked", true).apply()
                    showKeepAliveTip = false
                    (context as? Activity)?.let { KeepAlive.requestIgnoreBattery(it) }
                        ?: KeepAlive.openAppDetail(context)
                }) { Text("去设置") }
            },
            dismissButton = {
                TextButton(onClick = {
                    prefs.edit().putBoolean("keepAliveAsked", true).apply()
                    showKeepAliveTip = false
                }) { Text("以后再说") }
            }
        )
    }

    reportText?.let { report ->
        AlertDialog(
            onDismissRequest = { reportText = null },
            title = { Text(reportTitle) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(report, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                }
            },
            confirmButton = { TextButton(onClick = { reportText = null }) { Text("关闭") } },
            dismissButton = {
                TextButton(onClick = {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("ofm-report", report))
                    Toast.makeText(context, "已复制，可发给开发者", Toast.LENGTH_SHORT).show()
                }) { Text("复制报告") }
            }
        )
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            val scheme = MaterialTheme.colorScheme
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(scheme.background)
                    .statusBarsPadding()
                    .padding(horizontal = 20.dp, vertical = 12.dp)
            ) {
                /* 第一行：品牌小标 + 状态芯片（端口常显，排查时不用再翻设置） */
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Eyebrow("OFM  /  LOCAL API", Modifier.weight(1f))
                    Row(
                        Modifier
                            .clip(RoundedCornerShape(20.dp))
                            .background(scheme.surface)
                            .border(1.dp, scheme.outlineVariant.copy(alpha = 0.85f), RoundedCornerShape(20.dp))
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        StatusDot(if (running) StatusTone.Ok else StatusTone.Wait)
                        Spacer(Modifier.width(6.dp))
                        Text(
                            if (running) "运行中" else "启动中",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Medium,
                            color = scheme.onSurface
                        )
                        if (port > 0) {
                            Spacer(Modifier.width(5.dp))
                            Text(":$port", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = scheme.onSurfaceVariant)
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                /* 第二行：当前页标题（用户始终知道自己在哪）+ 返回 / 设置 */
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            if (settingsOpen) "设置" else TAB_TITLES.getOrElse(tab) { "概览" },
                            style = MaterialTheme.typography.titleLarge,
                            color = scheme.onSurface
                        )
                        Text(
                            if (settingsOpen) SETTINGS_SUBTITLE else TAB_SUBTITLES.getOrElse(tab) { "" },
                            fontSize = 11.sp,
                            color = scheme.onSurfaceVariant
                        )
                    }
                    if (settingsOpen) {
                        TextButton(
                            onClick = { tab = 0 },
                            contentPadding = PaddingValues(horizontal = 8.dp)
                        ) { Text("返回", fontSize = 12.sp) }
                    } else {
                        IconButton(onClick = { tab = 5 }) {
                            SettingsGlyph(scheme.onSurfaceVariant)
                        }
                    }
                }
            }
        },
        bottomBar = {
            OfmBottomBar(
                tabs = TABS,
                selected = if (settingsOpen) -1 else tab,
                onSelect = { tab = it }
            )
        }
    ) { inner ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(inner)
        ) {
            when (tab) {
                0 -> OverviewScreen(
                    running = running,
                    port = port,
                    apiKey = apiKey,
                    enabled = enabled,
                    accounts = accounts,
                    providers = providers,
                    models = models,
                    message = message,
                    onToggleEnabled = { toggleService(it) },
                    onGoto = { tab = it }
                )

                1 -> ChannelsScreen(
                    providers = providers,
                    accounts = accounts,
                    useExternalBrowser = useExternalBrowser,
                    callbackListening = callbackListening,
                    running = running,
                    onToggleBrowser = { v ->
                        useExternalBrowser = v
                        prefs.edit().putBoolean("externalBrowser", v).apply()
                    },
                    onLogin = { startLogin(it) },
                    onToggleAccount = { a, v ->
                        scope.launch {
                            withContext(Dispatchers.IO) {
                                ApiClient.patch("/api/accounts/${a.id}", JSONObject().put("enabled", v))
                            }
                            refresh()
                        }
                    },
                    onDeleteAccount = { a ->
                        scope.launch {
                            withContext(Dispatchers.IO) { runCatching { ApiClient.delete("/api/accounts/${a.id}") } }
                            refresh()
                        }
                    },
                    onPaste = { showPasteDialog = true }
                )

                2 -> ModelsAndCreditsScreen(
                    models = models,
                    hint = modelsHint,
                    running = running,
                    effort = modelEffort,
                    accounts = accounts,
                    onSetEffort = { id, value ->
                        scope.launch {
                            withContext(Dispatchers.IO) {
                                runCatching { ApiClient.setModelEffort(id, value) }
                            }
                            refresh()
                        }
                    },
                    onRefresh = {
                        scope.launch {
                            withContext(Dispatchers.IO) { runCatching { ApiClient.get("/api/models?refresh=1") } }
                            refresh()
                        }
                    }
                )

                3 -> UsageScreen(running = running)

                4 -> WebSearchScreen()

                else -> SettingsScreen(
                    apiKey = apiKey,
                    port = port,
                    running = running,
                    enabled = enabled,
                    lastError = lastError,
                    netBusy = netBusy,
                    chatBusy = chatBusy,
                    toolBusy = toolBusy,
                    onToggleEnabled = { toggleService(it) },
                    onSetKey = { showKeyDialog = true },
                    onRotateKey = {
                        scope.launch {
                            withContext(Dispatchers.IO) { runCatching { ApiClient.post("/api/settings/key/rotate") } }
                            refresh()
                        }
                    },
                    onNetworkDiagnose = {
                        scope.launch {
                            netBusy = true
                            val r = withContext(Dispatchers.IO) {
                                runCatching { ApiClient.networkDiagnose() }
                                    .getOrElse { JSONObject().put("summary", "自检请求失败：${it.message}") }
                            }
                            netBusy = false
                            reportTitle = "网络 / 账号自检结果"
                            reportText = formatNetworkReport(r)
                        }
                    },
                    onChatDiagnose = {
                        scope.launch {
                            chatBusy = true
                            val r = withContext(Dispatchers.IO) {
                                runCatching { ApiClient.chatDiagnose() }
                                    .getOrElse { JSONObject().put("summary", "自检请求失败：${it.message}") }
                            }
                            chatBusy = false
                            reportTitle = "对话链路自检结果"
                            reportText = formatChatReport(r)
                        }
                    },
                    onToolDiagnose = {
                        scope.launch {
                            toolBusy = true
                            val r = withContext(Dispatchers.IO) {
                                runCatching { ApiClient.chatDiagnose(probeTools = true) }
                                    .getOrElse { JSONObject().put("summary", "自检请求失败：${it.message}") }
                            }
                            toolBusy = false
                            reportTitle = "工具调用自检结果"
                            reportText = formatChatReport(r)
                        }
                    },
                    onRestart = {
                        // Node/V8 在同一进程只能初始化一次，重启必须换干净进程
                        ApiService.clearLastError(context)
                        android.os.Process.killProcess(android.os.Process.myPid())
                    }
                )
            }
        }
    }
}

/** Loomy 的短信登录：手机号 + 验证码 */
@Composable
fun SmsDialog(accountId: String, onDone: suspend () -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var phone by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var sent by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("短信登录") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = phone, onValueChange = { phone = it }, label = { Text("手机号") })
                if (sent) OutlinedTextField(value = code, onValueChange = { code = it }, label = { Text("验证码") })
                if (message.isNotBlank()) Text(message, fontSize = 12.sp)
            }
        },
        confirmButton = {
            TextButton(onClick = {
                scope.launch {
                    val r = runCatching {
                        withContext(Dispatchers.IO) {
                            if (!sent) {
                                ApiClient.post("/api/login/sms/send", JSONObject().put("accountId", accountId).put("phone", phone))
                            } else {
                                ApiClient.post(
                                    "/api/login/sms/verify",
                                    JSONObject().put("accountId", accountId).put("phone", phone).put("code", code)
                                )
                            }
                        }
                    }
                    val err = r.exceptionOrNull()?.message
                    if (err != null) {
                        message = err
                    } else if (sent) {
                        onDone()
                    } else {
                        sent = true
                        message = "验证码已发送"
                    }
                }
            }) { Text(if (sent) "登录" else "发送验证码") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

/**
 * 18080 端口不通时的兜底：把浏览器地址栏整条回调 URL 直接送回 Node。
 * 自动从剪贴板预填，支持完整 URL / ?query / 裸 key=value 三种形态。
 */
@Composable
fun PasteCallbackDialog(
    initialAccountId: String?,
    onDone: suspend () -> Unit,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    fun clipText(): String {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        return runCatching { cm.primaryClip?.getItemAt(0)?.text?.toString().orEmpty() }.getOrDefault("")
    }

    LaunchedEffect(Unit) {
        val c = clipText().trim()
        if (c.contains("=") && (c.contains("://") || c.startsWith("?"))) text = c
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("粘贴回调链接") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("把浏览器地址栏里那整条链接复制过来。里面已含登录凭据，端口打不开也没关系。", fontSize = 12.sp)
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it; message = "" },
                    label = { Text("回调链接") },
                    minLines = 3,
                    maxLines = 6,
                    modifier = Modifier.fillMaxWidth()
                )
                TextButton(onClick = {
                    val c = clipText().trim()
                    if (c.isBlank()) message = "剪贴板是空的，请先从浏览器地址栏复制"
                    else { text = c; message = "" }
                }) { Text("从剪贴板粘贴") }
                if (message.isNotBlank()) {
                    Text(message, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && text.isNotBlank(),
                onClick = {
                    scope.launch {
                        busy = true
                        val r = runCatching {
                            withContext(Dispatchers.IO) { ApiClient.completeLogin(text.trim(), initialAccountId) }
                        }
                        busy = false
                        val e = r.exceptionOrNull()
                        val j = r.getOrNull()
                        when {
                            e != null -> message = "请求失败：${e.message ?: "本地服务未就绪"}"
                            j?.optBoolean("ok") == true -> { onDone(); onDismiss() }
                            else -> message = j?.optString("error")?.takeIf { it.isNotBlank() } ?: "登录未完成"
                        }
                    }
                }
            ) { Text(if (busy) "处理中…" else "完成登录") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

/** 设置固定 API Key：留空保存 = 恢复默认值；改完第三方客户端要同步更新。 */
@Composable
fun ApiKeyDialog(current: String, onDone: suspend () -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf(current) }
    var message by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("设置固定 API Key") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("填自己的固定值并保存；留空保存则恢复默认。改完请把新 Key 重新填到第三方客户端。", fontSize = 12.sp)
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it; message = "" },
                    label = { Text("API Key（6-128 位字母数字 . _ - ~）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                TextButton(onClick = { text = ""; message = "" }) { Text("留空 = 恢复固定默认值") }
                if (message.isNotBlank()) {
                    Text(message, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                scope.launch {
                    busy = true
                    val r = runCatching { withContext(Dispatchers.IO) { ApiClient.setApiKey(text.trim()) } }
                    busy = false
                    val e = r.exceptionOrNull()
                    val j = r.getOrNull()
                    when {
                        e != null -> message = "请求失败：${e.message}"
                        j?.optBoolean("ok") == true -> { onDone(); onDismiss() }
                        else -> message = j?.optString("error")?.takeIf { it.isNotBlank() } ?: "保存失败"
                    }
                }
            }) { Text(if (busy) "保存中…" else "保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

/**
 * 模型行的积分消耗倍率：`×0.08` / `免费`。倍率由渠道目录提供
 * （TRAE 取自 display_contact_config），没有就返回空串，不做任何推算。
 */
private fun formatCreditsRate(o: JSONObject): String {
    if (!o.has("credits_rate")) return ""
    val rate = o.optDouble("credits_rate", -1.0)
    if (rate < 0 || rate.isNaN()) return ""
    return if (rate == 0.0) "免费" else "×${trimRate(rate)}"
}

/** 活动折扣前的原价；只有确实高于现价时才返回，否则会出现「×0.13 → ×0.13」。 */
private fun formatOriginalRate(o: JSONObject): String {
    if (!o.has("original_credits_rate")) return ""
    val original = o.optDouble("original_credits_rate", -1.0)
    val rate = o.optDouble("credits_rate", -2.0)
    if (original < 0 || original.isNaN() || original <= rate) return ""
    return "×${trimRate(original)}"
}

/** 0.08 不要显示成 0.08000000000000001；1.0 显示成 1 而不是 1.0 */
private fun trimRate(v: Double): String =
    java.math.BigDecimal.valueOf(v).stripTrailingZeros().toPlainString()

/** 把 /api/network/diagnose 的 JSON 排成可复制的纯文本报告（不含任何凭据）。 */
private fun formatNetworkReport(o: JSONObject): String {
    val sb = StringBuilder()
    sb.append("结论：").append(o.optString("summary").ifBlank { "（自检未返回结果）" }).append('\n')
    val ca = o.optJSONObject("ca")
    if (ca != null) {
        val bundle = ca.optString("bundle").takeIf { it.isNotBlank() && it != "null" } ?: "未加载"
        sb.append("根证书：内置 ").append(ca.optInt("builtinRootCerts"))
            .append(" + 打包 ").append(ca.optInt("bundledRootCerts"))
            .append(" = ").append(ca.optInt("total"))
            .append(" 张（").append(bundle).append("）\n")
    }
    val targets = o.optJSONArray("targets")
    if (targets != null) {
        for (i in 0 until targets.length()) {
            val t = targets.optJSONObject(i) ?: continue
            sb.append("\n● ").append(t.optString("host"))
                .append(" [").append(t.optString("label")).append("] ")
                .append(if (t.optBoolean("ok")) "通过" else "失败@" + t.optString("failedAt"))
                .append('\n')
            val steps = t.optJSONObject("steps") ?: JSONObject()
            for (key in listOf("dns", "tcp", "tls", "https")) {
                val s = steps.optJSONObject(key) ?: continue
                sb.append("   ").append(key).append(": ")
                    .append(if (s.optBoolean("ok")) "OK" else "FAIL")
                    .append(" ").append(s.optLong("ms")).append("ms")
                val code = s.optString("code")
                if (code.isNotBlank()) sb.append(" [").append(code).append("]")
                val status = s.optInt("status", 0)
                if (status > 0) sb.append(" HTTP ").append(status)
                val msg = s.optString("message")
                if (msg.isNotBlank()) sb.append(" ").append(msg)
                sb.append('\n')
            }
            val reason = t.optString("reason")
            if (reason.isNotBlank()) sb.append("   原因：").append(reason).append('\n')
            val tls = steps.optJSONObject("tls")
            if (tls != null && tls.optString("certIssuer").isNotBlank()) {
                sb.append("   证书：").append(tls.optString("certCN"))
                    .append(" / ").append(tls.optString("certIssuer"))
                    .append(" / ").append(tls.optString("protocol"))
                    .append(" / 到期 ").append(tls.optString("certValidTo")).append('\n')
            }
        }
    }
    val acc = o.optJSONObject("accounts")
    if (acc != null) {
        sb.append("\n账号 / 凭据：").append(acc.optInt("count"))
            .append(" 个账号，").append(acc.optInt("usable")).append(" 个可用\n")
        val rows = acc.optJSONArray("accounts")
        if (rows != null) {
            for (i in 0 until rows.length()) {
                val a = rows.optJSONObject(i) ?: continue
                sb.append("  ● ").append(a.optString("provider"))
                    .append(" [").append(a.optString("state")).append("]")
                val missing = a.optJSONArray("missing")
                if (missing != null && missing.length() > 0) {
                    val ms = (0 until missing.length())
                        .mapNotNull { missing.optString(it).takeIf { s -> s.isNotBlank() } }
                    if (ms.isNotEmpty()) sb.append(" 缺 ").append(ms.joinToString("、"))
                }
                val hours = a.optDouble("expiresInHours", Double.NaN)
                if (!hours.isNaN()) sb.append(" token剩余 ").append(hours).append("h")
                sb.append('\n')
            }
        }
        val hint = acc.optString("hint")
        if (hint.isNotBlank()) sb.append("  → ").append(hint).append('\n')
    }
    // 旧版登录写丢的设备标识会在启动 / 自检时自动补齐，明确告知用户不用重登
    val repair = o.optJSONObject("credentialRepair")
    if (repair != null && repair.optInt("repaired") > 0) {
        val fields = repair.optJSONArray("added")
        val names = if (fields != null) {
            (0 until fields.length()).mapNotNull { fields.optString(it).takeIf { s -> s.isNotBlank() } }
                .joinToString("、")
        } else ""
        sb.append("\n凭据自愈：已自动补齐 ").append(repair.optInt("repaired"))
            .append(" 个账号").append(if (names.isNotEmpty()) " 的 $names" else "")
            .append("（无需重新登录，补齐后点「重新拉取」即可）\n")
    }
    val relogin = repair?.optJSONArray("needsRelogin")
    if (relogin != null && relogin.length() > 0) {
        sb.append("  → 有 ").append(relogin.length())
            .append(" 个账号连 uid 也缺失，只能重新点「连接」登录一次\n")
    }
    if (targets == null && o.optString("raw").isNotBlank()) sb.append(o.optString("raw"))
    return sb.toString().trimEnd()
}

/** 对话链路自检报告：把「请求到没到、上游回了什么、解析出几帧正文」摊开给人看。 */
private fun formatChatReport(o: JSONObject): String {
    val sb = StringBuilder()
    sb.append("结论：").append(o.optString("summary").ifBlank { "（自检未返回结果）" }).append('\n')
    sb.append("模型：").append(o.optString("model").ifBlank { "（未选定）" }).append('\n')
    sb.append("总耗时：").append(o.optLong("totalMs")).append("ms")
    val first = o.optLong("firstDeltaMs", -1)
    if (first >= 0) sb.append("，首个正文片段：").append(first).append("ms")
    sb.append('\n')
    // 只有工具探针才会带回这个字段：>0 说明上游确实支持 function calling，
    // 0 说明模型/渠道没回工具调用（客户端会表现为「AI 不会用工具」）。
    val toolCalls = o.optInt("toolCalls", -1)
    if (toolCalls >= 0) {
        sb.append("工具调用帧：").append(toolCalls)
            .append(if (toolCalls > 0) "（上游支持工具调用）" else "（上游没有返回工具调用）")
            .append('\n')
    }
    val err = o.optJSONObject("error")
    if (err != null) {
        sb.append("错误：[").append(err.optString("code")).append("] ")
            .append(err.optString("message")).append('\n')
        val st = err.optInt("status", 0)
        if (st > 0) sb.append("  HTTP ").append(st).append('\n')
    }
    val t = o.optJSONObject("trace")
    if (t != null) {
        sb.append("\n链路：")
            .append(t.optString("channel").ifBlank { t.optString("provider") })
            .append(" / ").append(t.optString("modelId")).append('\n')
        sb.append("  可用账号：").append(t.optInt("accountCount"))
        val aid = t.optString("accountId")
        if (aid.isNotBlank()) sb.append("，本次选中 ").append(aid)
        sb.append('\n')
        val url = t.optString("url")
        if (url.isNotBlank()) sb.append("  上游：").append(url).append('\n')
        // 发出去了什么：模型 / 通道 / max_tokens 是「只回 metadata 就断流」最容易出错的三个参数
        val req = t.optJSONObject("request")
        if (req != null) {
            sb.append("  请求：model=").append(req.optString("model"))
                .append(" / function=").append(req.optString("function"))
                .append(" / max_tokens=").append(req.optInt("max_tokens"))
                .append(" / messages=").append(req.optInt("messages")).append('\n')
        }
        val attempts = t.optInt("attempts", 0)
        if (attempts > 1) {
            sb.append("  重试：共 ").append(attempts).append(" 次")
            val emptyAttempts = t.optInt("emptyAttempts", 0)
            if (emptyAttempts > 0) sb.append("（零正文 ").append(emptyAttempts).append(" 次）")
            sb.append('\n')
        }
        if (t.has("modelInCatalog") && !t.optBoolean("modelInCatalog")) {
            sb.append("  ⚠ 该模型不在目录里，可能不可调用（换一个模型再试）\n")
        }
        val status = t.optInt("httpStatus", 0)
        val ct = t.optString("contentType")
        val shape = t.optString("shape")
        if (status > 0 || ct.isNotBlank() || shape.isNotBlank()) {
            sb.append("  响应：HTTP ").append(if (status > 0) status.toString() else "?")
            if (ct.isNotBlank()) sb.append(" / ").append(ct)
            if (shape.isNotBlank()) sb.append(" / 形状 ").append(shape)
            sb.append('\n')
        }
        sb.append("  帧数：").append(t.optInt("frames"))
            .append("，有效帧：").append(t.optInt("validFrames"))
            .append("，正文片段：").append(t.optInt("contentDeltas"))
            .append("，正文长度：").append(t.optInt("textLength")).append('\n')
        val textSample = t.optString("textSample")
        if (textSample.isNotBlank()) sb.append("  正文样本：").append(textSample).append('\n')
        val sample = t.optString("sample")
        if (sample.isNotBlank()) sb.append("  上游响应样本：").append(sample).append('\n')
    }
    val note = o.optString("note")
    if (note.isNotBlank()) sb.append("\n提示：").append(note).append('\n')
    if (t == null && o.optString("raw").isNotBlank()) sb.append(o.optString("raw"))
    return sb.toString().trimEnd()
}
