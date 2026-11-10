package com.ofm.client

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

/**
 * 签到 / 领取积分区块（说明书 §5）。
 *
 * 纪律：
 *  - 渠道列表**按能力渲染**：有 dailyCheckin 才给「一键签到」；raccoon 给「新手任务」；
 *    cline/gemini/opencode 不给按钮并注明「该渠道没有每日签到」。
 *  - 余额卡片按 windowDays **渲染时现算**分「临时 / 长期」两桶（分类是时间的函数，不能存）。
 *  - `total===0 && packages 为空` 显示「查询失败」而不是 0；null 与 0 严格区分。
 *  - `actionRequired / riskControlled` 单独醒目红条，不混进计数行。
 *  - 单位显式：token 压缩成 M/K，积分保留两位小数不压缩，绝不跨单位相加。
 *  - 手动结果提示按时自动消失；自动签到状态文字常驻、按用户手动关闭（不合并）。
 */
@Composable
fun CheckinSection(accounts: List<Account>) {
    val scope = rememberCoroutineScope()
    var caps by remember { mutableStateOf<List<CreditCapability>>(emptyList()) }
    var auto by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var manualNotice by remember { mutableStateOf("") }
    var actionRequired by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf<String?>(null) }
    val balances = remember { mutableStateMapOf<String, JSONObject>() }
    val statuses = remember { mutableStateMapOf<String, JSONObject>() }
    var windowDays by remember { mutableStateOf(15) }
    // 余额默认自动加载（不再需要逐个点开「查看状态 / 余额」）
    var refreshBalances by remember { mutableStateOf(0) }
    var loadingBalances by remember { mutableStateOf(false) }
    var balanceLoadKey by remember { mutableStateOf("") }
    // Qoder machine 头：Android 拿不到官方 UMID，允许手工粘贴（Pluggable）
    var showMachine by remember { mutableStateOf(false) }
    var machineToken by remember { mutableStateOf("") }
    var machineType by remember { mutableStateOf("") }
    var machineConfigured by remember { mutableStateOf(false) }
    // 签到日志卡片的刷新信号：手动签到结束、或后台自动签到跑完一轮时自增
    var logRefresh by remember { mutableStateOf(0) }
    var lastAutoAt by remember { mutableStateOf(0L) }

    val ownedProviders = accounts.map { it.provider }.distinct().sorted()
    val claimable = ownedProviders.filter { p ->
        val c = caps.find { it.provider == p }
        c != null && (c.dailyCheckin || c.onboardingTasks)
    }

    suspend fun loadAuto(): JSONObject? = withContext(Dispatchers.IO) {
        runCatching { ApiClient.checkinAuto() }.getOrNull()
    }

    suspend fun loadProvider(provider: String) {
        val st = withContext(Dispatchers.IO) { runCatching { ApiClient.checkinStatus(provider) }.getOrNull() }
        val bal = withContext(Dispatchers.IO) { runCatching { ApiClient.checkinBalances(provider) }.getOrNull() }
        if (st != null) statuses[provider] = st
        if (bal != null) {
            balances[provider] = bal
            windowDays = bal.optJSONObject("value")?.optInt("windowDays", 15) ?: 15
        }
    }

    suspend fun claimOne(provider: String): JSONObject? = withContext(Dispatchers.IO) {
        runCatching { ApiClient.checkinClaim(provider) }.getOrNull()
    }

    // 能力表 + 自动签到状态：轮询只读本地文档，不打上游
    LaunchedEffect(Unit) {
        caps = withContext(Dispatchers.IO) { runCatching { ApiClient.creditCapabilities() }.getOrElse { emptyList() } }
        auto = loadAuto()
        machineConfigured = withContext(Dispatchers.IO) {
            runCatching { ApiClient.get("/api/status").optBoolean("qoderMachineConfigured") }.getOrElse { false }
        }
        while (true) {
            delay(10000)
            val next = loadAuto()
            val at = next?.optJSONObject("value")?.optJSONObject("autoCheckin")?.optLong("lastAt", 0L) ?: 0L
            // 自动签到在后台跑完一轮（lastAt 变了）→ 日志卡片跟着刷新
            if (at > 0L && at != lastAutoAt) {
                lastAutoAt = at
                logRefresh += 1
            }
            auto = next
        }
    }

    // 账号 / 能力表变化或手动刷新时，自动把「有余额能力」的渠道全拉一遍。
    // 之前只有点开某个渠道的展开才发请求，看起来像「余额没显示」。
    LaunchedEffect(ownedProviders, caps, refreshBalances) {
        if (ownedProviders.isEmpty() || caps.isEmpty()) return@LaunchedEffect
        val key = ownedProviders.joinToString(",") + "#" + refreshBalances
        if (key == balanceLoadKey) return@LaunchedEffect
        balanceLoadKey = key
        loadingBalances = true
        for (p in ownedProviders) {
            if (caps.find { it.provider == p }?.balance == true) loadProvider(p)
        }
        loadingBalances = false
    }

    // 手动签到结果：按时自动消失（自动签到的状态文字不走这里）
    LaunchedEffect(manualNotice) {
        if (manualNotice.isNotBlank()) {
            delay(6000)
            manualNotice = ""
        }
    }

    fun runClaim(providers: List<String>, label: String) {
        if (busy != null || providers.isEmpty()) return
        scope.launch {
            busy = label
            actionRequired = ""
            val totals = ClaimTotals()
            for (p in providers) {
                val r = claimOne(p)
                absorbClaim(r, totals)
                if (expanded == p) loadProvider(p)
            }
            manualNotice = "$label：${describeClaim(totals)}"
            if (totals.actions.isNotEmpty()) actionRequired = totals.actions.joinToString("\n")
            auto = loadAuto()
            logRefresh += 1 // 刚跑完一轮手动签到，日志立刻跟上
            busy = null
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("签到 / 领取积分", style = MaterialTheme.typography.titleMedium)

        // ── 余额总览：默认自动加载，按单位分桶，明细仍在各渠道展开里 ──
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("余额总览", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    TextButton(onClick = { refreshBalances += 1 }, enabled = !loadingBalances) {
                        Text(if (loadingBalances) "获取中…" else "刷新")
                    }
                }
                val sum = sumBalances(balances, caps)
                when {
                    ownedProviders.isEmpty() -> Text("连接账号后，这里会自动汇总各渠道余额。", fontSize = 12.sp)
                    sum.ok == 0 && sum.failed == 0 -> Text(
                        if (loadingBalances) "正在获取各渠道余额…" else "暂无余额数据，点「刷新」重试。",
                        fontSize = 12.sp
                    )
                    else -> {
                        // 大数字是「剩余」，小字补「共多少 / 已用多少」，避免只剩一个孤立数字
                        if (sum.credit > 0 || sum.creditLimit > 0) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                Text("剩余 ", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(formatUnitAmount(sum.credit, "credit"), fontSize = 20.sp, fontWeight = FontWeight.Bold)
                            }
                            val detail = usageDetail(sum.creditUsed, sum.creditLimit, "credit")
                            if (detail.isNotBlank()) {
                                Text(detail, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        if (sum.token > 0 || sum.tokenLimit > 0) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                Text("剩余 ", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(formatUnitAmount(sum.token, "token"), fontSize = 20.sp, fontWeight = FontWeight.Bold)
                            }
                            val detail = usageDetail(sum.tokenUsed, sum.tokenLimit, "token")
                            if (detail.isNotBlank()) {
                                Text(detail, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        // 各渠道明细：总数看不出哪家还剩多少，这里逐账号列一行
                        val perProvider = providerUsageLines(balances, caps)
                        if (perProvider.isNotEmpty()) {
                            Spacer(Modifier.height(2.dp))
                            Text(
                                perProvider.joinToString("\n"),
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Text(
                            buildString {
                                append("${sum.ok} 个账号")
                                if (sum.failed > 0) append(" · ${sum.failed} 个查询失败")
                                if (sum.quotaOnly > 0) append(" · ${sum.quotaOnly} 个仅配额（未计入）")
                            },
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                Text(
                    "token 与积分分开展示，不跨单位相加；各渠道明细在下方展开查看。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        // ── 自动签到状态行（常驻，按用户手动关闭）──
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val st = auto?.optJSONObject("value")?.optJSONObject("autoCheckin")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("自动签到", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    Switch(
                        checked = st?.optBoolean("enabled", true) ?: true,
                        onCheckedChange = { v ->
                            scope.launch {
                                auto = withContext(Dispatchers.IO) {
                                    runCatching { ApiClient.checkinAuto(enabled = v) }.getOrNull()
                                }
                                if (v) auto = loadAuto()
                            }
                        }
                    )
                }
                Text(
                    "默认开启：启动后约 30 秒、以及常驻期间每 2.5 小时检查一次当天额度；" +
                        "ZCode 等需验证码的渠道会自动跳过，可在下方手动领取。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                val dismissed = st?.optBoolean("dismissed", false) ?: false
                val resultText = st?.optString("lastResult").orEmpty()
                if (!dismissed && resultText.isNotBlank()) {
                    Text(resultText, fontSize = 12.sp)
                    val channels = st?.optJSONArray("channels")
                    if (channels != null && channels.length() > 0) {
                        // 单个 Text 排版超长日志会把 StaticLayout 撑到 OOM：限行 + 每行限长 + 总长兜底
                        val lines = (0 until minOf(channels.length(), 60)).mapNotNull { i ->
                            val c = channels.optJSONObject(i) ?: return@mapNotNull null
                            "${c.optString("provider")}：${c.optString("text")}".take(200)
                        }
                        Text(
                            lines.joinToString("\n").take(6000),
                            fontSize = 11.sp,
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace
                        )
                    }
                    TextButton(onClick = {
                        scope.launch {
                            auto = withContext(Dispatchers.IO) { runCatching { ApiClient.checkinAuto(dismiss = true) }.getOrNull() }
                        }
                    }) { Text("关闭这轮提示", fontSize = 11.sp) }
                } else if (st?.optBoolean("running") == true) {
                    Text("正在进行一轮签到…", fontSize = 12.sp)
                }
            }
        }

        // ── Qoder 设备头（Pluggable，可选）──
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Qoder 设备头（可选）", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    TextButton(onClick = { showMachine = !showMachine }) {
                        Text(if (showMachine) "收起" else if (machineConfigured) "已配置 · 修改" else "设置", fontSize = 11.sp)
                    }
                }
                Text(
                    "Qoder 官方客户端的 Cosy-MachineToken / MachineType 决定是否下发可领活动。" +
                        "Android 拿不到，可从桌面端 Qoder 的 machine_token.json 里取出后粘贴；" +
                        "留空则保守降级，显示「未下发可领活动」而不是「今天已领」。不会自造 token。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (showMachine) {
                    OutlinedTextField(
                        value = machineToken,
                        onValueChange = { machineToken = it },
                        label = { Text("Cosy-MachineToken") },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp)
                    )
                    OutlinedTextField(
                        value = machineType,
                        onValueChange = { machineType = it },
                        label = { Text("Cosy-MachineType") },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp)
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            scope.launch {
                                val r = withContext(Dispatchers.IO) {
                                    runCatching {
                                        ApiClient.post(
                                            "/api/settings",
                                            JSONObject().put(
                                                "credits",
                                                JSONObject().put(
                                                    "qoderMachine",
                                                    JSONObject().put("token", machineToken).put("type", machineType)
                                                )
                                            )
                                        )
                                    }.getOrNull()
                                }
                                machineConfigured = r?.optBoolean("qoderMachineConfigured") == true
                                machineToken = ""
                                machineType = ""
                                showMachine = false
                            }
                        }) { Text("保存", fontSize = 11.sp) }
                        OutlinedButton(onClick = {
                            scope.launch {
                                withContext(Dispatchers.IO) {
                                    runCatching {
                                        ApiClient.post(
                                            "/api/settings",
                                            JSONObject().put(
                                                "credits",
                                                JSONObject().put("qoderMachine", JSONObject().put("token", "").put("type", ""))
                                            )
                                        )
                                    }
                                }
                                machineConfigured = false
                                machineToken = ""
                                machineType = ""
                            }
                        }) { Text("清除", fontSize = 11.sp) }
                    }
                }
            }
        }

        // ── 一键全部签到 ──
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = { runClaim(claimable, "全部渠道签到") },
                enabled = busy == null && claimable.isNotEmpty()
            ) { Text("全部渠道签到") }
            if (busy != null) Text("进行中…", fontSize = 12.sp)
            else if (claimable.isEmpty()) Text("还没有可签到的渠道，先连接账号", fontSize = 11.sp)
        }

        // ── 手动结果（按时自动消失）与 actionRequired 红条（不自动消失）──
        if (manualNotice.isNotBlank()) {
            Text(manualNotice, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
        }
        if (actionRequired.isNotBlank()) {
            Surface(
                color = MaterialTheme.colorScheme.errorContainer,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text("需要你先去别处操作", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    Spacer(Modifier.height(4.dp))
                    Text(actionRequired, fontSize = 12.sp)
                    TextButton(onClick = { actionRequired = "" }) { Text("知道了", fontSize = 11.sp) }
                }
            }
        }

        // ── 渠道列表：按能力渲染 ──
        if (ownedProviders.isEmpty()) {
            Text("连接账号后，这里会按渠道显示签到与余额。", fontSize = 12.sp)
        }
        for (p in ownedProviders) {
            val cap = caps.find { it.provider == p }
            val isOpen = expanded == p
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(providerLabel(p), style = MaterialTheme.typography.titleSmall)
                            val note = cap?.note.orEmpty()
                            if (note.isNotBlank()) Text(note, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        when {
                            cap?.dailyCheckin == true -> Button(
                                onClick = { runClaim(listOf(p), "$p 签到") },
                                enabled = busy == null
                            ) { Text("一键签到", fontSize = 11.sp) }
                            cap?.onboardingTasks == true -> Button(
                                onClick = { runClaim(listOf(p), "$p 新手任务") },
                                enabled = busy == null
                            ) { Text("新手任务", fontSize = 11.sp) }
                            else -> Text("该渠道没有每日签到", fontSize = 11.sp)
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = {
                            if (isOpen) expanded = null
                            else {
                                expanded = p
                                scope.launch { loadProvider(p) }
                            }
                        }) { Text(if (isOpen) "收起" else "查看状态 / 余额", fontSize = 11.sp) }
                        if (cap?.autoExcluded == true) Text("自动签到已跳过（需手动）", fontSize = 11.sp)
                    }
                    if (isOpen) {
                        CheckinStatusBlock(statuses[p])
                        BalanceBlock(balances[p], windowDays, cap?.quotaOnly == true)
                    }
                }
            }
        }

        // ── 签到日志：排查「今天为什么没领到」，可一键复制纯文本报告 ──
        CheckinLogCard(refreshKey = logRefresh)
    }
}

/** 一批量领取的累计口径（跨渠道、按单位分开，绝不把 token 和积分相加）。 */
private class ClaimTotals {
    var claimed = 0
    var already = 0
    var failed = 0
    var inactive = 0
    var token = 0.0
    var credit = 0.0
    val actions = mutableListOf<String>()
}

private fun absorbClaim(r: JSONObject?, t: ClaimTotals) {
    if (r == null || !r.optBoolean("ok", false)) return // 无签到能力：不计入
    val value = r.optJSONObject("value") ?: return
    val s = value.optJSONObject("summary") ?: return
    t.claimed += s.optInt("claimed")
    t.already += s.optInt("alreadyClaimed")
    t.failed += s.optInt("failed")
    t.inactive += s.optInt("inactive")
    val by = s.optJSONObject("totalByUnit")
    t.token += by?.optDouble("token", 0.0) ?: 0.0
    t.credit += by?.optDouble("credit", 0.0) ?: 0.0
    val results = value.optJSONArray("results") ?: return
    for (i in 0 until results.length()) {
        val row = results.optJSONObject(i) ?: continue
        val o = row.optJSONObject("outcome") ?: continue
        // ⚠️ 不能靠「message 是否非空」去猜，只认这两个显式标记
        if (o.optBoolean("actionRequired") || o.optBoolean("riskControlled")) {
            val msg = o.optString("message").ifBlank { "该账号需要在官方客户端完成一次操作" }
            t.actions.add("${row.optString("nickname").ifBlank { row.optString("accountId") }}：$msg")
        }
    }
}

private fun describeClaim(t: ClaimTotals): String {
    val parts = mutableListOf<String>()
    if (t.claimed > 0) {
        val gains = formatClaimGains(t.token, t.credit)
        parts.add("${t.claimed} 个账号领取成功${if (gains == null) "" else "（$gains）"}")
    }
    if (t.already > 0) parts.add("${t.already} 个今天已领")
    if (t.failed > 0) parts.add("${t.failed} 个失败")
    if (t.inactive > 0) parts.add("${t.inactive} 个未开启")
    return if (parts.isEmpty()) "没有需要领取的账号" else parts.joinToString("，")
}

/** 与 Node 侧 formatClaimGains 逐字对齐：token → credit，只列非零，各带一个 +。 */
private fun formatClaimGains(token: Double, credit: Double): String? {
    val parts = mutableListOf<String>()
    if (token > 0) parts.add("+" + formatUnitAmount(token, "token"))
    if (credit > 0) parts.add("+" + formatUnitAmount(credit, "credit"))
    return parts.takeIf { it.isNotEmpty() }?.joinToString(", ")
}

/** 余额总览：token / 积分两桶分别求和，配额百分比与查询失败都不混进积分 */
private data class BalanceSum(
    val token: Double,
    val credit: Double,
    val tokenLimit: Double,
    val tokenUsed: Double,
    val creditLimit: Double,
    val creditUsed: Double,
    val ok: Int,
    val failed: Int,
    val quotaOnly: Int
)

/** 一个资源包的「剩余 / 总量 / 已用」三元组（缺失的 used 用总量减剩余兜底）。 */
private data class PackageUsage(val remaining: Double, val limit: Double, val used: Double)

private fun usageOf(balance: JSONObject?, packages: org.json.JSONArray?): PackageUsage {
    val b = balance ?: return PackageUsage(0.0, 0.0, 0.0)
    var limit = 0.0
    var used = 0.0
    if (packages != null) {
        for (j in 0 until packages.length()) {
            val p = packages.optJSONObject(j) ?: continue
            limit += p.optDouble("total", 0.0)
            used += p.optDouble("used", 0.0)
        }
    }
    // Node 侧已给出汇总；旧版 / 其它 provider 没有就按包现算
    if (b.has("limitTotal")) limit = b.optDouble("limitTotal", limit)
    if (b.has("usedTotal")) used = b.optDouble("usedTotal", used)
    val remaining = b.optDouble("total", 0.0)
    if (used <= 0 && limit > remaining) used = limit - remaining
    return PackageUsage(remaining, limit, used.coerceAtLeast(0.0))
}

/** 「共 1000 · 已用 200（20%）」——总量未知时返回空串，绝不编数字。 */
private fun usageDetail(used: Double, limit: Double, unit: String): String {
    if (limit <= 0) return ""
    val pct = if (limit > 0) (used / limit * 100).coerceIn(0.0, 100.0) else 0.0
    val pctText = if (pct >= 10) String.format(Locale.US, "%.0f%%", pct) else String.format(Locale.US, "%.1f%%", pct)
    return "共 ${formatPackageAmount(limit, unit)} · 已用 ${formatPackageAmount(used, unit)}（$pctText）"
}

private fun sumBalances(balances: Map<String, JSONObject>, caps: List<CreditCapability>): BalanceSum {
    var token = 0.0
    var credit = 0.0
    var tokenLimit = 0.0
    var tokenUsed = 0.0
    var creditLimit = 0.0
    var creditUsed = 0.0
    var ok = 0
    var failed = 0
    var quotaOnly = 0
    for ((provider, response) in balances) {
        // Gemini 之类只有 5h / 周配额窗口（单位 %），不是积分，不能相加
        if (caps.find { it.provider == provider }?.quotaOnly == true) {
            quotaOnly += 1
            continue
        }
        val arr = response.optJSONObject("value")?.optJSONArray("accounts") ?: continue
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            val b = row.optJSONObject("balance")
            if (b == null) { // null（查不到）与 0（用光）严格区分
                failed += 1
                continue
            }
            val packages = b.optJSONArray("packages")
            val total = b.optDouble("total", 0.0)
            if (total == 0.0 && (packages == null || packages.length() == 0)) {
                failed += 1
                continue
            }
            val u = usageOf(b, packages)
            val unit = packages?.optJSONObject(0)?.optString("unit").takeUnless { it.isNullOrBlank() } ?: "credit"
            if (unit == "token") {
                token += total
                tokenLimit += u.limit
                tokenUsed += u.used
            } else {
                credit += total
                creditLimit += u.limit
                creditUsed += u.used
            }
            ok += 1
        }
    }
    return BalanceSum(token, credit, tokenLimit, tokenUsed, creditLimit, creditUsed, ok, failed, quotaOnly)
}

/**
 * 每个渠道一行「剩余 / 共 / 已用」——总览只给总数，不知道哪家还剩多少。
 * 查询失败与配额类按各自口径单列，不混进 token / 积分。
 */
private fun providerUsageLines(balances: Map<String, JSONObject>, caps: List<CreditCapability>): List<String> {
    val lines = mutableListOf<String>()
    for ((provider, response) in balances) {
        if (caps.find { it.provider == provider }?.quotaOnly == true) {
            val arr = response.optJSONObject("value")?.optJSONArray("accounts")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val row = arr.optJSONObject(i) ?: continue
                    val name = row.optString("nickname").ifBlank { row.optString("accountId") }
                    val b = row.optJSONObject("balance")
                    if (b == null) {
                        lines.add("$name：${row.optString("error").ifBlank { "查询失败" }}")
                    } else {
                        val packages = b.optJSONArray("packages")
                        val first = packages?.optJSONObject(0)
                        val unit = first?.optString("unit").takeUnless { it.isNullOrBlank() } ?: "%"
                        lines.add("$name：配额 ${formatPackageAmount(b.optDouble("total", 0.0), unit)}")
                    }
                }
            }
            continue
        }
        val arr = response.optJSONObject("value")?.optJSONArray("accounts") ?: continue
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            val name = row.optString("nickname").ifBlank { row.optString("accountId") }
            val b = row.optJSONObject("balance")
            if (b == null) {
                lines.add("$name：${row.optString("error").ifBlank { "查询失败" }}")
                continue
            }
            val packages = b.optJSONArray("packages")
            val u = usageOf(b, packages)
            val unit = packages?.optJSONObject(0)?.optString("unit").takeUnless { it.isNullOrBlank() } ?: "credit"
            val detail = usageDetail(u.used, u.limit, unit)
            lines.add(
                buildString {
                    append(name).append("：剩余 ").append(formatUnitAmount(u.remaining, unit))
                    if (detail.isNotBlank()) append(" · ").append(detail)
                }
            )
        }
    }
    return lines
}

private fun formatUnitAmount(v: Double, unit: String): String {
    val text = if (unit == "token") formatToken(v) else formatCredit(v)
    return text + if (unit == "token") "Token" else "积分"
}

private fun formatCredit(v: Double): String =
    if (v == kotlin.math.floor(v) && abs(v) < 1e15) v.toLong().toString()
    else String.format(Locale.US, "%.2f", v)

private fun formatToken(v: Double): String = when {
    abs(v) >= 1e6 -> String.format(Locale.US, "%.2fM", v / 1e6)
    abs(v) >= 1e3 -> String.format(Locale.US, "%.2fK", v / 1e3)
    else -> v.toLong().toString()
}

private fun formatPackageAmount(v: Double, unit: String): String {
    val num = if (unit == "token") formatToken(v) else formatCredit(v)
    return when (unit) {
        "token" -> num + "Token"
        "%" -> num + "%"
        "USD" -> "$num USD"
        else -> num + "积分"
    }
}

private fun providerLabel(p: String): String = when (p) {
    "trae" -> "TRAE"
    "qoder" -> "Qoder"
    "qodercn" -> "Qoder 中国版"
    "lobsterai" -> "LobsterAI"
    "loomy" -> "Loomy"
    "minimax" -> "MiniMax Code"
    "zcode" -> "ZCode"
    "raccoon" -> "Raccoon"
    "cline" -> "Cline"
    "gemini" -> "Gemini"
    "opencode" -> "OpenCode"
    else -> p
}

@Composable
private fun CheckinStatusBlock(response: JSONObject?) {
    val value = response?.optJSONObject("value")
    val arr = value?.optJSONArray("accounts")
    if (arr == null) {
        Text("状态：${response?.optString("error").takeUnless { it.isNullOrBlank() } ?: "加载中…"}", fontSize = 11.sp)
        return
    }
    for (i in 0 until arr.length()) {
        val row = arr.optJSONObject(i) ?: continue
        val name = row.optString("nickname").ifBlank { row.optString("accountId") }
        val st = row.optJSONObject("status")
        val onboarding = row.optJSONObject("onboarding")
        val text = when {
            st == null && onboarding != null ->
                if (onboarding.optBoolean("claimed")) "新手任务：已领取（每号一次）" else "新手任务：可领取"
            st == null -> "该渠道没有独立签到状态（判定在领取时完成）"
            else -> buildString {
                append(if (st.optBoolean("todayCheckedIn")) "今天已签到" else "今天未签到")
                val daily = st.optDouble("dailyCredit", 0.0)
                if (daily > 0) append(" · 今日可领 ${formatUnitAmount(daily, "credit")}")
                if (st.optBoolean("actionRequired")) append(" · 需要先去官方客户端操作")
            }
        }
        Text("$name：$text", fontSize = 11.sp)
    }
}

@Composable
private fun BalanceBlock(response: JSONObject?, windowDays: Int, quotaOnly: Boolean) {
    val value = response?.optJSONObject("value")
    val arr = value?.optJSONArray("accounts")
    if (arr == null || arr.length() == 0) {
        Text("余额：${response?.optString("error").takeUnless { it.isNullOrBlank() } ?: "暂无账号或该渠道不提供余额"}", fontSize = 11.sp)
        return
    }
    val now = System.currentTimeMillis()
    val horizon = if (windowDays > 0) now + windowDays * 86400000L else Long.MIN_VALUE
    val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())

    for (i in 0 until arr.length()) {
        val row = arr.optJSONObject(i) ?: continue
        val name = row.optString("nickname").ifBlank { row.optString("accountId") }
        val balance = row.optJSONObject("balance")
        if (balance == null) {
            // ⚠️ null（查不到）与 0（已用光）严格区分：显示原因，不显示 0
            Text("$name：${row.optString("error").ifBlank { "查询失败" }}", fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
            continue
        }
        val packages = balance.optJSONArray("packages")
        val total = balance.optDouble("total", 0.0)
        if (total == 0.0 && (packages == null || packages.length() == 0)) {
            Text("$name：查询失败（未获取到额度）", fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
            continue
        }
        val unitOf = { p: JSONObject -> p.optString("unit").ifBlank { "credit" } }
        val firstUnit = unitOf(packages?.optJSONObject(0) ?: JSONObject())
        val usage = usageOf(balance, packages)
        if (quotaOnly) {
            Text("$name · 配额 ${formatCredit(total)}%", fontSize = 11.sp, fontWeight = FontWeight.Bold)
        } else {
            Text(
                "$name · 剩余 ${formatUnitAmount(usage.remaining, firstUnit)}",
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold
            )
            val detail = usageDetail(usage.used, usage.limit, firstUnit)
            if (detail.isNotBlank()) {
                Text(detail, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (packages == null) continue
        // 按到期远近渲染时现算分桶（分类是时间的函数，不能存下来）
        val temporary = mutableListOf<JSONObject>()
        val longTerm = mutableListOf<JSONObject>()
        for (j in 0 until packages.length()) {
            val p = packages.optJSONObject(j) ?: continue
            val d = p.optLong("deductionEndTime", 0L)
            if (d > 0 && d <= horizon) temporary.add(p) else longTerm.add(p)
        }
        BalanceGroup("临时（${windowDays} 天内到期）", temporary, fmt, quotaOnly)
        BalanceGroup("长期 / 永久", longTerm, fmt, quotaOnly)
    }
}

@Composable
private fun BalanceGroup(title: String, list: List<JSONObject>, fmt: SimpleDateFormat, quotaOnly: Boolean) {
    if (list.isEmpty()) return
    Text(title, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    for (p in list) {
        val unit = p.optString("unit").ifBlank { "credit" }
        val remaining = p.optDouble("remaining", 0.0)
        val total = p.optDouble("total", 0.0)
        var used = p.optDouble("used", 0.0)
        if (used <= 0 && total > remaining) used = total - remaining
        val exp = p.optLong("deductionEndTime", 0L)
        val expText = if (exp > 0) " · 到期 ${fmt.format(Date(exp))}" else " · 永久"
        if (quotaOnly) {
            // 配额类只有百分比窗口，没有「共 / 已用」语义
            Text("  ${p.optString("name")}：${formatPackageAmount(remaining, unit)}$expText", fontSize = 11.sp)
            continue
        }
        val pct = if (total > 0) (used / total * 100).coerceIn(0.0, 100.0) else 0.0
        val pctText = if (pct >= 10) String.format(Locale.US, "%.0f%%", pct) else String.format(Locale.US, "%.1f%%", pct)
        Text(
            "  ${p.optString("name")}：剩余 ${formatPackageAmount(remaining, unit)}" +
                " · 已用 ${formatPackageAmount(used, unit)} / 共 ${formatPackageAmount(total, unit)}（$pctText）$expText",
            fontSize = 11.sp
        )
        if (total > 0) {
            LinearProgressIndicator(
                progress = (pct / 100.0).toFloat(),
                modifier = Modifier
                    .padding(start = 8.dp, top = 3.dp, bottom = 3.dp)
                    .fillMaxWidth(),
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}

/* ─────────────────── 签到日志（排查用） ─────────────────── */

private data class CheckinLogEntry(
    val ts: Long,
    val source: String,
    val trigger: String,
    val type: String,
    val level: String,
    val provider: String,
    val account: String,
    val outcome: String,
    val message: String,
    val ms: Long
)

private fun parseCheckinLog(arr: JSONArray?): List<CheckinLogEntry> {
    if (arr == null) return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        CheckinLogEntry(
            ts = o.optLong("ts"),
            source = o.optString("source"),
            trigger = o.optString("trigger"),
            type = o.optString("type"),
            level = o.optString("level"),
            provider = o.optString("provider"),
            account = o.optString("account"),
            outcome = o.optString("outcome"),
            message = o.optString("message"),
            ms = o.optLong("ms")
        )
    }
}

/**
 * 积分页底部的签到日志卡片。数据全部来自本机 /api/checkin/log，
 * 「复制日志」拿的是 Node 侧排好版、已脱敏的纯文本，粘给开发者即可定位。
 */
@Composable
private fun CheckinLogCard(refreshKey: Int) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var limit by remember { mutableStateOf(30) }
    var localRefresh by remember { mutableStateOf(0) }
    var entries by remember { mutableStateOf<List<CheckinLogEntry>>(emptyList()) }
    var summaryText by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var showClear by remember { mutableStateOf(false) }

    LaunchedEffect(refreshKey, limit, localRefresh) {
        busy = true
        error = ""
        val r = withContext(Dispatchers.IO) {
            runCatching { ApiClient.checkinLog(limit) }
                .getOrElse { JSONObject().put("error", it.message ?: "读取签到日志失败") }
        }
        if (r.has("error")) {
            error = r.optString("error")
        } else {
            val v = r.optJSONObject("value")
            entries = parseCheckinLog(v?.optJSONArray("entries"))
            val s = v?.optJSONObject("summary")
            summaryText = if (s == null) "" else buildString {
                append("今日：轮次 ").append(s.optInt("runs"))
                append(" · 领取成功 ").append(s.optInt("claimed"))
                append(" · 失败 ").append(s.optInt("failed"))
                append(" · 跳过 ").append(s.optInt("skipped"))
            }
        }
        busy = false
    }

    if (showClear) {
        AlertDialog(
            onDismissRequest = { showClear = false },
            title = { Text("清空签到日志") },
            text = { Text("只删除本机按天分片的签到日志，不影响账号、余额与自动签到状态。") },
            confirmButton = {
                TextButton(onClick = {
                    showClear = false
                    scope.launch {
                        withContext(Dispatchers.IO) { runCatching { ApiClient.clearCheckinLog() } }
                        localRefresh += 1
                    }
                }) { Text("清空") }
            },
            dismissButton = { TextButton(onClick = { showClear = false }) { Text("取消") } }
        )
    }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("签到日志", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "逐渠道记录成功 / 跳过 / 失败原因，日志已脱敏、不含凭据",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (busy) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(6.dp))
                }
                TextButton(onClick = { localRefresh += 1 }, enabled = !busy) {
                    Text("刷新", fontSize = 11.sp)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = {
                    scope.launch {
                        val text = withContext(Dispatchers.IO) {
                            runCatching { ApiClient.checkinLogText(200) }.getOrDefault("读取失败")
                        }
                        withContext(Dispatchers.Main) {
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            cm.setPrimaryClip(ClipData.newPlainText("ofm-checkin-log", text))
                            Toast.makeText(
                                context,
                                if (text == "读取失败") text else "已复制签到日志，可发给开发者",
                                Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                }) { Text("复制日志", fontSize = 11.sp) }
                OutlinedButton(onClick = { showClear = true }) { Text("清空", fontSize = 11.sp) }
            }
            if (summaryText.isNotBlank()) {
                Text(summaryText, fontSize = 11.sp, fontWeight = FontWeight.Medium)
            }
            if (error.isNotBlank()) {
                Text("读取失败：$error", fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
            }
            if (entries.isEmpty() && !busy) {
                Text(
                    "还没有签到记录。点一次「全部渠道签到」，或等自动签到跑完一轮，" +
                        "这里会写下每个渠道成功 / 跳过 / 失败的原因。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                for (e in entries) CheckinLogRow(e)
                if (entries.size >= limit) {
                    OutlinedButton(
                        onClick = { limit += 30 },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("加载更多", fontSize = 11.sp) }
                }
            }
        }
    }
}

@Composable
private fun CheckinLogRow(e: CheckinLogEntry) {
    val tone = when (e.level) {
        "ok" -> StatusTone.Ok
        "error" -> StatusTone.Bad
        else -> StatusTone.Wait
    }
    Row(verticalAlignment = Alignment.Top) {
        StatusDot(tone)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            val who = listOf(
                checkinSourceLabel(e.source, e.trigger),
                checkinTypeLabel(e.type),
                listOf(e.provider, e.account).filter { it.isNotBlank() }.joinToString("/")
            ).filter { it.isNotBlank() }.joinToString(" · ")
            Text(
                "${checkinLogTime(e.ts)}  $who",
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            val outcome = checkinOutcomeLabel(e.outcome)
            val tail = if (e.ms > 0) "（${e.ms}ms）" else ""
            Text(
                "${if (outcome.isBlank()) "" else "$outcome："}${e.message}$tail",
                fontSize = 11.sp,
                color = if (e.level == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
            )
        }
    }
}

private fun checkinLogTime(ts: Long): String =
    SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(Date(ts))

private fun checkinSourceLabel(source: String, trigger: String): String {
    val s = when (source) {
        "auto" -> "自动"
        "manual" -> "手动"
        else -> source
    }
    val t = when (trigger) {
        "startup" -> "启动"
        "tick" -> "巡检"
        "toggle" -> "开关"
        "app" -> "App"
        "schedule" -> "排定"
        else -> trigger
    }
    return if (t.isBlank()) s else "$s/$t"
}

private fun checkinTypeLabel(type: String): String = when (type) {
    "run" -> "本轮"
    "channel" -> "渠道"
    "account" -> "账号"
    "query" -> "查询"
    else -> type
}

private fun checkinOutcomeLabel(outcome: String): String = when (outcome) {
    "claimed" -> "领取成功"
    "already-claimed" -> "今天已领"
    "inactive" -> "未开启"
    "failed" -> "失败"
    "skipped" -> "跳过"
    "excluded" -> "需手动"
    "empty" -> "无可领"
    "started" -> "开始"
    "finished" -> "结束"
    else -> ""
}
