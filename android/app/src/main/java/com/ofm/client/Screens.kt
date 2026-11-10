package com.ofm.client

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 模型目录条目。UI 只读它，不再把整行拼成字符串。 */
data class ModelItem(
    val id: String,            // trae/Doubao-Seed-Code
    val model: String,         // Doubao-Seed-Code
    val name: String,          // 显示名
    val rate: String,          // ×0.08 / 免费 / 空
    val originalRate: String,  // ×0.13 / 空
    val images: Boolean,
    val reasoning: Boolean,
    val fallback: Boolean,
    val contextWindow: Long,
    val reasoningOptions: List<EffortOption> = emptyList(),
    val channel: String = ""      // 渠道显示名，如「TRAE」；展示在模型名前
)

/** 可选思考档位。value 原样回填给上游，label 只用于界面显示。 */
data class EffortOption(val value: String, val label: String)

private fun copyToClipboard(context: Context, text: String, tip: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("ofm", text))
    Toast.makeText(context, tip, Toast.LENGTH_SHORT).show()
}

private fun shortExpiry(ms: Long): String =
    SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(ms))

/* ───────────────────────── 概览 ───────────────────────── */

@Composable
fun OverviewScreen(
    running: Boolean,
    port: Int,
    apiKey: String,
    enabled: Boolean,
    accounts: List<Account>,
    providers: List<Provider>,
    models: List<ModelItem>,
    message: String,
    onToggleEnabled: (Boolean) -> Unit,
    onGoto: (Int) -> Unit
) {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val baseUrl = "http://127.0.0.1:${if (port > 0) port else 18900}"
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp)
    ) {
        /* 首屏：状态是主角，不套卡片 */
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Eyebrow("LOCAL API  /  本机服务")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (running) "服务运行中" else "服务启动中",
                        style = MaterialTheme.typography.displayLarge,
                        color = scheme.onSurface,
                        modifier = Modifier.weight(1f)
                    )
                    Switch(
                        checked = enabled,
                        onCheckedChange = onToggleEnabled,
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = MaterialTheme.colorScheme.tertiary,
                            checkedTrackColor = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.32f)
                        )
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(if (running) StatusTone.Ok else StatusTone.Wait)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (running) "$baseUrl/v1  ·  已就绪" else "正在拉起 Node 运行时…",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        color = scheme.onSurfaceVariant
                    )
                }
            }
        }

        item { HairLine() }

        /* 接入凭据：整行可复制，省掉「按钮 + 文字」两次视线跳转 */
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("接入凭据") { Eyebrow("点击复制") }
                CopyField("BASE URL", "$baseUrl/v1") {
                    copyToClipboard(context, "$baseUrl/v1", "Base URL 已复制")
                }
                CopyField("API KEY", apiKey.ifBlank { "（等待启动）" }) {
                    if (apiKey.isNotBlank()) copyToClipboard(context, apiKey, "API Key 已复制")
                }
                Text(
                    "第三方客户端填这两项即可，模型列表会自动出现在它的模型选择器里。",
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                    color = scheme.onSurfaceVariant
                )
            }
        }

        item { HairLine() }

        /* 指标：一行读完，用竖线分组，不做三个方块 */
        item {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Eyebrow("运行概览")
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                    Metric(accounts.size.toString(), "账号", Modifier.weight(1f))
                    VLine()
                    Metric(models.size.toString(), "模型", Modifier.weight(1f))
                    VLine()
                    Metric(providers.size.toString(), "渠道", Modifier.weight(1f))
                }
            }
        }

        if (message.isNotBlank()) {
            item {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(scheme.secondaryContainer)
                        .padding(horizontal = 12.dp, vertical = 10.dp)
                ) {
                    Text(message, fontSize = 12.sp, color = scheme.onSecondaryContainer)
                }
            }
        }

        item { HairLine() }

        /* 下一步：文字链比并排大按钮轻，也不会和主操作抢注意力 */
        item {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Eyebrow("开始使用")
                Spacer(Modifier.height(4.dp))
                LinkRow("连接渠道", "登录并管理上游账号") { onGoto(1) }
                LinkRow("查看模型与积分", "目录、积分倍率与每日签到") { onGoto(2) }
                LinkRow("用量与日志", "调用统计和运行状态") { onGoto(3) }
                LinkRow("网页搜索", "第三方接入字段与试搜") { onGoto(4) }
            }
        }

        item { HairLine() }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Eyebrow("最近状态")
                Text(
                    if (accounts.isEmpty()) "还没有连接任何渠道，先去「渠道」页登录一个。"
                    else "${accounts.count { it.enabled }} 个账号启用中，${models.count { !it.fallback }} 个远端模型可用",
                    fontSize = 13.sp,
                    color = if (accounts.isEmpty()) scheme.onSurface else scheme.onSurfaceVariant
                )
            }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
}

/** 分组之间的细线：比卡片留白更明确，也比阴影轻 */
@Composable
private fun HairLine() {
    Box(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f))
    )
}

@Composable
private fun VLine() {
    Box(
        Modifier
            .width(1.dp)
            .fillMaxHeight()
            .padding(vertical = 4.dp)
            .background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f))
    )
}

@Composable
private fun Metric(value: String, label: String, modifier: Modifier = Modifier) {
    Column(modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            value,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = (-1).sp,
            color = MaterialTheme.colorScheme.onSurface
        )
        Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** 带箭头的操作行：整行 ≥56dp，满足触控目标 */
@Composable
private fun LinkRow(label: String, hint: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.titleSmall)
            Text(hint, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        ArrowGlyph(MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ArrowGlyph(tint: Color) {
    Canvas(Modifier.size(16.dp)) {
        val s = size.minDimension
        val sw = s * 0.1f
        drawLine(tint, Offset(s * 0.32f, s * 0.22f), Offset(s * 0.68f, s * 0.5f), sw, StrokeCap.Round)
        drawLine(tint, Offset(s * 0.68f, s * 0.5f), Offset(s * 0.32f, s * 0.78f), sw, StrokeCap.Round)
    }
}

/* ───────────────────────── 渠道 ───────────────────────── */

@Composable
fun ChannelsScreen(
    providers: List<Provider>,
    accounts: List<Account>,
    useExternalBrowser: Boolean,
    callbackListening: Boolean,
    running: Boolean,
    onToggleBrowser: (Boolean) -> Unit,
    onLogin: (Provider) -> Unit,
    onToggleAccount: (Account, Boolean) -> Unit,
    onDeleteAccount: (Account) -> Unit,
    onPaste: () -> Unit
) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            OfmCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("用系统浏览器登录", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "OAuth 页在 Chrome 里兼容性更好",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Switch(checked = useExternalBrowser, onCheckedChange = onToggleBrowser)
                }
            }
        }

        item {
            Text("添加渠道", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 4.dp))
        }
        items(providers, key = { it.id }) { p ->
            OfmCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(p.displayName, fontWeight = FontWeight.Medium)
                        if (p.note.isNotBlank()) {
                            Text(
                                p.note,
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    if (p.loginMode == "none") {
                        Pill("内置")
                    } else {
                        FilledTonalButton(onClick = { onLogin(p) }, enabled = running) {
                            Text("连接", fontSize = 12.sp)
                        }
                    }
                }
            }
        }

        item {
            Spacer(Modifier.height(4.dp))
            Text(
                "已连接账号（${accounts.size}）",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(start = 4.dp)
            )
        }

        if (accounts.isEmpty()) {
            item {
                Text(
                    "还没有账号。上面选一个渠道点「连接」。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 4.dp)
                )
            }
        }
        items(accounts, key = { it.id }) { a ->
            OfmCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            a.nickname.ifBlank { a.id },
                            fontWeight = FontWeight.Medium
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Pill(a.provider)
                            if (a.pending) Pill("登录中", StatusTone.Wait)
                            if (a.needsLogin) Pill("需重新登录", StatusTone.Bad)
                            if (!a.enabled) Pill("已停用")
                        }
                        val meta = buildString {
                            if (a.expiresAt > 0) append("有效期至 ${shortExpiry(a.expiresAt)} · ")
                            append(if (a.enabled) "参与调度" else "不参与调度")
                        }
                        Text(meta, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Switch(checked = a.enabled, onCheckedChange = { onToggleAccount(a, it) })
                        TextButton(onClick = { onDeleteAccount(a) }) {
                            Text("删除", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }

        item {
            OfmCard {
                Text("登录回调打不开？", style = MaterialTheme.typography.titleSmall)
                Text(
                    "授权后浏览器若显示「无法打开 / ERR_CONNECTION_REFUSED」，把地址栏整条 " +
                        "127.0.0.1:18080/authorize?… 链接复制过来即可完成登录，端口通不通都行，在电脑上授权也同样适用。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (!callbackListening) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StatusDot(StatusTone.Bad)
                        Spacer(Modifier.width(6.dp))
                        Text("18080 当前未监听，建议直接用粘贴方式", fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
                    }
                }
                OutlinedButton(onClick = onPaste, enabled = running, modifier = Modifier.fillMaxWidth()) {
                    Text("粘贴回调链接完成登录", fontSize = 12.sp)
                }
            }
        }
    }
}

/* ───────────────────────── 模型 ───────────────────────── */

@Composable
fun ModelsScreen(
    models: List<ModelItem>,
    hint: String,
    running: Boolean,
    effort: Map<String, String>,
    query: String,
    onQueryChange: (String) -> Unit,
    onSetEffort: (String, String?) -> Unit,
    onRefresh: () -> Unit
) {
    val filtered = remember(models, query) {
        val base = if (query.isBlank()) models
        else models.filter {
            it.id.contains(query, true) || it.name.contains(query, true) ||
                it.channel.contains(query, true)
        }
        // 上游目录偶尔有重复项；LazyColumn 的 key 必须唯一，否则滚动位置恢复错乱
        base.distinctBy { it.id }
    }
    val hasRate = models.any { it.rate.isNotBlank() }

    // 标题 / 提示 / 搜索框放固定区。OutlinedTextField 一旦放进 LazyColumn 的 item，
    // 滚出屏幕就被回收，焦点与软键盘状态在 fling 中反复重建，是滚动期崩溃高发点。
    // 顺带让搜索框常驻，长目录里改关键词不用来回滚回顶部。
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("模型目录", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        "${models.size} 个模型" + if (models.any { it.fallback }) " · 兜底目录" else "",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                OutlinedButton(onClick = onRefresh, enabled = running) { Text("重新拉取", fontSize = 12.sp) }
            }

            if (hint.isNotBlank()) {
                // 空列表才是错误；只是「兜底目录」时用普通提示色，别整块标红
                OfmCard(
                    container = if (models.isEmpty()) MaterialTheme.colorScheme.errorContainer
                    else MaterialTheme.colorScheme.secondaryContainer
                ) {
                    Text(
                        hint.take(200),
                        fontSize = 11.sp,
                        // 固定区不能无限长：极端情况下异常提示会把整个列表挤出屏幕
                        maxLines = 4,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        color = if (models.isEmpty()) MaterialTheme.colorScheme.onErrorContainer
                        else MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
            }

            if (models.isNotEmpty()) {
                OutlinedTextField(
                    value = query,
                    onValueChange = onQueryChange,
                    placeholder = { Text("搜索模型名 / 渠道", fontSize = 13.sp) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        LazyColumn(
            Modifier
                .fillMaxWidth()
                .weight(1f),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (models.isEmpty()) {
                item {
                    OfmCard {
                        Text("还没有模型", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "连接渠道后会自动拉取；第三方用 Base URL + Key 访问 /v1/models 也能拿到同一份列表。",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            } else if (filtered.isEmpty()) {
                item {
                    Text(
                        "没有匹配「$query」的模型",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            items(filtered, key = { it.id }) { m ->
            OfmCard {
                Row(verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        // 渠道名放模型名前面：同一个模型可能同时出现在多个渠道，光看 id 不够直观
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            if (m.channel.isNotBlank()) Pill(m.channel)
                            Text(
                                m.name,
                                fontWeight = FontWeight.Medium,
                                fontSize = 14.sp,
                                modifier = Modifier.weight(1f, fill = false)
                            )
                        }
                        MonoText(m.id, 11)
                        if (m.images || m.reasoning || m.contextWindow > 0 || m.fallback) {
                            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                if (m.fallback) Pill("兜底", StatusTone.Bad)
                                if (m.images) Pill("图片")
                                if (m.reasoning) Pill("推理")
                                if (m.contextWindow > 0) Pill(compactTokens(m.contextWindow))
                            }
                        }
                    }
                    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        if (m.rate.isNotBlank()) {
                            Text(
                                m.rate,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = if (m.rate == "免费") toneColor(StatusTone.Ok) else MaterialTheme.colorScheme.primary
                            )
                        }
                        if (m.originalRate.isNotBlank()) {
                            Text(
                                "原 ${m.originalRate}",
                                fontSize = 10.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
                if (m.reasoningOptions.isNotEmpty()) {
                    val current = effort[m.id]
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "思考强度",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(Modifier.height(5.dp))
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        EffortChip("自动", current == null) { onSetEffort(m.id, null) }
                        m.reasoningOptions.forEach { o ->
                            EffortChip(o.label.ifBlank { o.value }, current == o.value) {
                                onSetEffort(m.id, o.value)
                            }
                        }
                    }
                }
            }
        }

        if (hasRate) {
            item {
                Text(
                    "×N = 每次调用消耗 N 倍积分（×1 为原价，×0.5 为半价）；「原 ×Y」是当前活动折扣前的价格。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp)
                )
            }
        }

        if (models.any { it.reasoningOptions.isNotEmpty() }) {
            item {
                Text(
                    "思考强度是按模型保存的默认档位，只在第三方客户端未指定 reasoning_effort 时生效，" +
                        "客户端显式传值优先。「自动」= 清除默认值。档位值原样来自上游模型目录；" +
                        "上游未列可选值时提供通用 low / medium / high，未声明支持推理的模型可能忽略该字段。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp)
                )
            }
        }
        } // LazyColumn
    } // 固定区 + 列表的外层 Column
}

@Composable
private fun EffortChip(text: String, selected: Boolean, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Box(
        Modifier
            .clip(RoundedCornerShape(9.dp))
            .background(if (selected) scheme.primary else scheme.surfaceVariant)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp)
    ) {
        Text(
            text,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) scheme.onPrimary else scheme.onSurfaceVariant
        )
    }
}

private fun compactTokens(n: Long): String = when {
    n >= 1_000_000 -> "${n / 1_000_000}M"
    n >= 1_000 -> "${n / 1_000}K"
    else -> n.toString()
}

/* ───────────────────────── 积分 ───────────────────────── */

@Composable
fun CreditsScreen(accounts: List<Account>) {
    // 不用 LazyColumn：签到区是一整块带内部状态的组件，一旦被回收
    // （滚出屏幕）状态就丢了，重新滚回来会重置展开项与已加载的余额。
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        Text("签到 / 积分", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(
            "余额按 token / 积分分桶统计，配额类渠道单独标注",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(10.dp))
        CheckinSection(accounts = accounts)
    }
}

/* ─────────────── 模型 + 积分（合并后的 dock 页） ─────────────── */

/**
 * 原来「模型」和「积分」各占一个底栏项，两页其实都在回答同一个问题：
 * 「这个渠道能用什么、要花多少、还剩多少」。合并后底栏空出一格给网页搜索。
 *
 * 两点实现约束：
 * 1. 用分段开关而不是把签到区塞进模型列表下面。`CheckinSection` 是一整块带
 *    内部状态的组件，放进 LazyColumn 的 item 里滚出屏幕就会被回收，展开项和
 *    已加载的余额全丢。分段切换时它独占整个内容区，不会被列表复用机制碰。
 * 2. `section` 与 `query` 用 rememberSaveable 提到这一层：切去签到再切回来，
 *    模型搜索词还在；旋屏 / 进程重建后也不会退回默认段。
 */
@Composable
fun ModelsAndCreditsScreen(
    models: List<ModelItem>,
    hint: String,
    running: Boolean,
    effort: Map<String, String>,
    accounts: List<Account>,
    onSetEffort: (String, String?) -> Unit,
    onRefresh: () -> Unit
) {
    var section by rememberSaveable { mutableStateOf(0) }   // 0 模型目录 / 1 签到积分
    var query by rememberSaveable { mutableStateOf("") }

    Column(Modifier.fillMaxSize()) {
        OfmSegmented(
            items = listOf("模型目录", "签到积分"),
            selected = section,
            onSelect = { section = it },
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
        )
        Box(Modifier.weight(1f)) {
            if (section == 0) {
                ModelsScreen(
                    models = models,
                    hint = hint,
                    running = running,
                    effort = effort,
                    query = query,
                    onQueryChange = { query = it },
                    onSetEffort = onSetEffort,
                    onRefresh = onRefresh
                )
            } else {
                CreditsScreen(accounts = accounts)
            }
        }
    }
}

/* ───────────────────────── 设置 ───────────────────────── */

@Composable
fun SettingsScreen(
    apiKey: String,
    port: Int,
    running: Boolean,
    enabled: Boolean,
    lastError: String?,
    netBusy: Boolean,
    chatBusy: Boolean,
    toolBusy: Boolean,
    onToggleEnabled: (Boolean) -> Unit,
    onSetKey: () -> Unit,
    onRotateKey: () -> Unit,
    onNetworkDiagnose: () -> Unit,
    onChatDiagnose: () -> Unit,
    onToolDiagnose: () -> Unit,
    onRestart: () -> Unit
) {
    val context = LocalContext.current
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            OfmCard {
                Text("接口凭据", style = MaterialTheme.typography.titleSmall)
                MonoText(apiKey.ifBlank { "（等待启动）" }, 13, MaterialTheme.colorScheme.onSurface)
                Text(
                    "固定 Key 清数据 / 重装后也不变，第三方只需配置一次。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(onClick = onSetKey, enabled = running, modifier = Modifier.weight(1f)) {
                        Text("设固定 Key", fontSize = 12.sp)
                    }
                    OutlinedButton(onClick = onRotateKey, enabled = running, modifier = Modifier.weight(1f)) {
                        Text("随机换 Key", fontSize = 12.sp)
                    }
                }
                TextButton(
                    onClick = { copyToClipboard(context, apiKey, "API Key 已复制") },
                    enabled = apiKey.isNotBlank()
                ) { Text("复制 Key", fontSize = 12.sp) }
            }
        }

        item {
            KeepAliveCard(context)
        }

        // 崩溃记录：只有真出过未捕获异常才出现，方便一次复制完整堆栈定位
        item {
            val crash = remember { CrashHandler.latest(context) }
            if (!crash.isNullOrBlank()) {
                OfmCard {
                    Text("最近一次崩溃", style = MaterialTheme.typography.titleSmall)
                    Text(
                        crash.lineSequence().take(5).joinToString("\n"),
                        fontSize = 10.sp,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        "把完整堆栈发给开发者可以一次定位问题；日志只存在本机，不含正文与凭据。",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedButton(
                        onClick = { copyToClipboard(context, crash, "崩溃堆栈已复制") },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("复制完整堆栈", fontSize = 12.sp) }
                }
            }
        }

        item {
            OfmCard {
                Text("诊断", style = MaterialTheme.typography.titleSmall)
                Text(
                    "模型 / 余额同时失败时先做网络自检（DNS → TCP → TLS → HTTPS，并体检账号）；" +
                        "第三方能列模型但没回复时做对话自检。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedButton(
                    onClick = onNetworkDiagnose,
                    enabled = running && !netBusy,
                    modifier = Modifier.fillMaxWidth()
                ) { Text(if (netBusy) "检测中…（最多约 20 秒）" else "网络 / 账号自检", fontSize = 12.sp) }
                OutlinedButton(
                    onClick = onChatDiagnose,
                    enabled = running && !chatBusy,
                    modifier = Modifier.fillMaxWidth()
                ) { Text(if (chatBusy) "检测中…（最多约 75 秒）" else "对话链路自检", fontSize = 12.sp) }
                OutlinedButton(
                    onClick = onToolDiagnose,
                    enabled = running && !toolBusy,
                    modifier = Modifier.fillMaxWidth()
                ) { Text(if (toolBusy) "检测中…（最多约 75 秒）" else "工具调用自检", fontSize = 12.sp) }
                Text(
                    "对话自检会向上游发一条 hi 测试消息；工具自检会要求模型调用 ofm_echo。" +
                        "两者各消耗一次真实额度，用于区分「上游不支持工具」与「本机转换出错」。",
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        item {
            OfmCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("转发服务", style = MaterialTheme.typography.titleSmall)
                        Text(
                            if (running) "运行中 · 端口 $port" else "未就绪",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Switch(
                        checked = enabled,
                        onCheckedChange = onToggleEnabled,
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = MaterialTheme.colorScheme.tertiary,
                            checkedTrackColor = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.32f)
                        )
                    )
                }
                val err = lastError?.takeIf { it.isNotBlank() }
                if (err != null) {
                    Text("上次退出：$err", fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
                }
                OutlinedButton(onClick = onRestart, modifier = Modifier.fillMaxWidth()) {
                    Text("重启 App（会退出，请重新打开）", fontSize = 12.sp)
                }
            }
        }

        item {
            OfmCard {
                Text("关于", style = MaterialTheme.typography.titleSmall)
                Text(
                    "OFM 渠道 0.1.0 · 内嵌 Node 转发，所有流量只在本机与上游之间",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                MonoText("Base URL：http://127.0.0.1:${if (port > 0) port else 18900}/v1", 11)
            }
        }
    }
}


/**
 * 后台保活状态卡。
 *
 * 前台服务只是「声明想一直跑」，真正决定死活的是电池优化白名单和通知权限，
 * 再加各家 ROM 自己的自启动开关。这里把四项状态摊开，缺哪项给哪个入口，
 * 不做「一键优化」的假动作 —— 这些权限没有能静默授予的 API。
 */
@Composable
private fun KeepAliveCard(context: Context) {
    var status by remember { mutableStateOf(KeepAlive.status(context)) }
    var tick by remember { mutableStateOf(0) }

    // 从系统设置页返回时自动刷新，用户不用手动点
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, tick) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) status = KeepAlive.status(context)
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    OfmCard {
        Text("后台保活", style = MaterialTheme.typography.titleSmall)
        Text(
            "划掉最近任务不会停止服务。但息屏后系统可能限制网络，第三方调用会超时 —— " +
                "下面三项都变成「已开启」才稳。",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        KeepAliveRow(
            label = "电池优化",
            ok = status.batteryOk,
            okText = "已加入白名单",
            badText = "未加入（息屏会断网）",
            onClick = { (context as? Activity)?.let { KeepAlive.requestIgnoreBattery(it) } ?: KeepAlive.openAppDetail(context) }
        )
        KeepAliveRow(
            label = "通知权限",
            ok = status.notificationOk,
            okText = "已授予",
            badText = "未授予（服务易被降级）",
            onClick = { KeepAlive.openNotificationSettings(context) }
        )
        KeepAliveRow(
            label = "自启动管理",
            ok = null,
            okText = "",
            badText = "手动确认（${KeepAlive.vendorLabel()}）",
            onClick = { KeepAlive.openAutoStart(context) }
        )
        KeepAliveRow(
            label = "前台服务",
            ok = status.foregroundRunning,
            okText = "运行中",
            badText = "未运行",
            onClick = null
        )

        Text(
            "「自启动管理」各家界面不同：把本应用加进白名单、允许后台运行，" +
                "并把省电策略设为「无限制」，否则锁屏一会儿就被清掉。",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        TextButton(onClick = { tick += 1; status = KeepAlive.status(context) }) {
            Text("刷新状态", fontSize = 11.sp)
        }
    }
}

@Composable
private fun KeepAliveRow(
    label: String,
    ok: Boolean?,
    okText: String,
    badText: String,
    onClick: (() -> Unit)?
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, fontSize = 12.sp, modifier = Modifier.width(84.dp))
        Text(
            text = when (ok) {
                true -> okText
                false -> badText
                null -> badText
            },
            fontSize = 11.sp,
            modifier = Modifier.weight(1f),
            color = when (ok) {
                true -> MaterialTheme.colorScheme.primary
                false -> MaterialTheme.colorScheme.error
                null -> MaterialTheme.colorScheme.onSurfaceVariant
            }
        )
        if (onClick != null) {
            TextButton(onClick = onClick, contentPadding = PaddingValues(horizontal = 6.dp)) {
                Text("去设置", fontSize = 11.sp)
            }
        }
    }
}
