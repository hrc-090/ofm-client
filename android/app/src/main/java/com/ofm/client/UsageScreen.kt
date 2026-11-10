package com.ofm.client

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 用量看板 + 运行日志。
 *
 * 数据全部来自本机 /api/usage 系列接口，Node 侧按天分片存 JSONL（只存统计，不存正文）。
 * App 只读不写上游，切换时间范围会重新聚合，清空只删本机分片。
 */
@Composable
fun UsageScreen(running: Boolean) {
    var days by remember { mutableStateOf(7) }
    var summary by remember { mutableStateOf<JSONObject?>(null) }
    var logs by remember { mutableStateOf<List<LogEntry>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var showClear by remember { mutableStateOf(false) }
    var logLimit by remember { mutableStateOf(30) }
    var refreshKey by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    // 直接内联加载逻辑，不用局部 suspend lambda：避免 Compose 捕获 lambda 时
    // 把一次加载跨重组重复触发。切范围 / 加载更多 / 点刷新都只改 key。
    LaunchedEffect(days, logLimit, refreshKey) {
        busy = true
        error = ""
        val pair = withContext(Dispatchers.IO) {
            runCatching { ApiClient.usageSummary(days) to ApiClient.usageLog(logLimit) }
                .getOrElse { e ->
                    JSONObject().put("error", e.message ?: "读取用量失败") to JSONObject()
                }
        }
        if (pair.first.has("error")) {
            error = pair.first.optString("error")
        } else {
            summary = pair.first.optJSONObject("value") ?: JSONObject()
            logs = parseLog(pair.second.optJSONObject("value")?.optJSONArray("entries"))
        }
        busy = false
    }

    if (showClear) {
        AlertDialog(
            onDismissRequest = { showClear = false },
            title = { Text("清空用量记录") },
            text = { Text("会删除本机所有按天分片的用量日志，不影响上游账号、余额与配置。") },
            confirmButton = {
                TextButton(onClick = {
                    showClear = false
                    scope.launch {
                        withContext(Dispatchers.IO) { runCatching { ApiClient.clearUsage() } }
                        refreshKey += 1
                    }
                }) { Text("清空") }
            },
            dismissButton = { TextButton(onClick = { showClear = false }) { Text("取消") } }
        )
    }

    val t = summary?.optJSONObject("totals")
    val requests = t?.optLong("requests") ?: 0L
    // 上游是否上报过缓存字段：false = 没数据，不能当成「命中 0」显示。
    // 旧版本服务端没有这个字段，缺省按「未上报」处理，正好对应恒 0 的老看板。
    val cacheReported = t?.optBoolean("cacheReported", false) ?: false
    val cachedTok = t?.optLong("cachedTok") ?: 0L

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            OfmCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("用量看板", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "仅统计本机转发请求，日志不含对话正文",
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                    }
                    TextButton(onClick = { refreshKey += 1 }, enabled = !busy) {
                        Text("刷新", fontSize = 12.sp)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(1 to "今日", 7 to "7 天", 30 to "30 天").forEach { (d, label) ->
                        OutlinedButton(
                            onClick = { days = d },
                            enabled = !busy && days != d,
                            modifier = Modifier.weight(1f),
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 6.dp)
                        ) { Text(label, fontSize = 11.sp) }
                    }
                    Button(
                        onClick = { showClear = true },
                        enabled = !busy,
                        modifier = Modifier.weight(1f),
                        contentPadding = PaddingValues(horizontal = 4.dp, vertical = 6.dp)
                    ) { Text("清空", fontSize = 11.sp) }
                }
                if (!running) {
                    Text(
                        "服务未就绪，读到的是上次运行留下的记录。",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                if (error.isNotBlank()) {
                    Text("读取失败：$error", fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        }

        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatTile(fmtNum(requests), "请求数", Modifier.weight(1f))
                StatTile(pct(t?.optDouble("successRate", Double.NaN) ?: Double.NaN), "成功率", Modifier.weight(1f))
            }
        }
        item {
            Column {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatTile(fmtNum(t?.optLong("inTok") ?: 0L), "输入 token", Modifier.weight(1f))
                    StatTile(fmtNum(t?.optLong("outTok") ?: 0L), "输出 token", Modifier.weight(1f))
                    // 上游没上报缓存字段时显示「—」，不把「无数据」伪装成「命中 0」。
                    StatTile(if (cacheReported) fmtNum(cachedTok) else "—", "缓存命中", Modifier.weight(1f))
                }
                if (!cacheReported && requests > 0) {
                    Text(
                        "当前渠道未上报缓存用量，故无命中数据；上游支持并返回时会自动统计。",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 8.dp)
                    )
                }
            }
        }

        item {
            OfmCard {
                Text("延迟", style = MaterialTheme.typography.titleSmall)
                KeyLine("平均耗时", fmtMs(t?.optLong("avgMs", -1) ?: -1))
                KeyLine("首个片段", fmtMs(t?.optLong("avgFirstMs", -1) ?: -1))
                KeyLine("失败请求", (t?.optLong("failed") ?: 0L).toString())
                KeyLine("缓存命中率", pct(t?.optDouble("cacheHitRate", Double.NaN) ?: Double.NaN))
            }
        }

        val byDay = summary?.optJSONArray("byDay")
        if (byDay != null && byDay.length() > 0) {
            item {
                OfmCard {
                    Text("每日请求", style = MaterialTheme.typography.titleSmall)
                    val max = (0 until byDay.length()).maxOf { byDay.optJSONObject(it).optLong("requests") }
                        .coerceAtLeast(1L)
                    for (i in 0 until byDay.length()) {
                        val d = byDay.optJSONObject(i)
                        DayRow(
                            day = d.optString("day"),
                            requests = d.optLong("requests"),
                            failed = d.optLong("failed"),
                            max = max
                        )
                    }
                }
            }
        }

        val byModel = summary?.optJSONArray("byModel")
        if (byModel != null && byModel.length() > 0) {
            item {
                OfmCard {
                    Text("按模型", style = MaterialTheme.typography.titleSmall)
                    for (i in 0 until byModel.length()) {
                        val m = byModel.optJSONObject(i) ?: continue
                        KeyLine(
                            m.optString("model"),
                            "${m.optLong("requests")} 次 · ${fmtNum(m.optLong("inTok"))}/${fmtNum(m.optLong("outTok"))} tok"
                        )
                    }
                }
            }
        }

        val byProvider = summary?.optJSONArray("byProvider")
        val byUa = summary?.optJSONArray("byUa")
        if ((byProvider?.length() ?: 0) > 0 || (byUa?.length() ?: 0) > 0) {
            item {
                OfmCard {
                    Text("来源分布", style = MaterialTheme.typography.titleSmall)
                    if (byProvider != null) {
                        for (i in 0 until byProvider.length()) {
                            val p = byProvider.optJSONObject(i) ?: continue
                            KeyLine(p.optString("provider"), "${p.optLong("requests")} 次")
                        }
                    }
                    if (byUa != null && byUa.length() > 0) {
                        Text(
                            "客户端",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        for (i in 0 until byUa.length()) {
                            val u = byUa.optJSONObject(i) ?: continue
                            KeyLine(u.optString("ua"), "${u.optLong("count")} 次")
                        }
                    }
                }
            }
        }

        item {
            OfmCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("运行日志", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    Text(
                        "最近 ${logs.size} 条",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (logs.isEmpty()) {
                    Text(
                        "还没有用量记录。用第三方客户端发一条对话后，这里会出现请求状态、耗时与 token 数。",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else {
                    logs.forEach { e -> LogRow(e) }
                    if (logs.size >= logLimit) {
                        OutlinedButton(
                            onClick = { logLimit += 30 },
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("加载更多", fontSize = 11.sp) }
                    }
                }
            }
        }
    }
}

private data class LogEntry(
    val ts: Long,
    val ok: Boolean,
    val status: Int,
    val code: String,
    val model: String,
    val path: String,
    val provider: String,
    val ms: Long,
    val inTok: Long,
    val outTok: Long,
    val ua: String,
    val stream: Boolean
)

private fun parseLog(arr: JSONArray?): List<LogEntry> {
    if (arr == null) return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        LogEntry(
            ts = o.optLong("ts"),
            ok = o.optBoolean("ok", true),
            status = o.optInt("status"),
            code = o.optString("code"),
            model = o.optString("model"),
            path = o.optString("path"),
            provider = o.optString("provider"),
            ms = o.optLong("ms"),
            inTok = o.optLong("inTok"),
            outTok = o.optLong("outTok"),
            ua = o.optString("ua"),
            stream = o.optBoolean("stream")
        )
    }
}

@Composable
private fun KeyLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f)
        )
        Text(value, fontSize = 11.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun DayRow(day: String, requests: Long, failed: Long, max: Long) {
    val label = if (day.length >= 10) day.substring(5) else day
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, fontSize = 10.sp, modifier = Modifier.width(42.dp))
        Box(
            Modifier
                .weight(1f)
                .height(10.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(5.dp))
        ) {
            Box(
                Modifier
                    .fillMaxWidth(if (max > 0) requests.toFloat() / max else 0f)
                    .fillMaxHeight()
                    .background(
                        if (failed > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                        RoundedCornerShape(5.dp)
                    )
            )
        }
        Spacer(Modifier.width(8.dp))
        Text(
            requests.toString(),
            fontSize = 10.sp,
            modifier = Modifier.width(34.dp)
        )
    }
}

@Composable
private fun LogRow(e: LogEntry) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(if (e.ok) StatusTone.Ok else StatusTone.Bad)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(
                e.model.ifBlank { e.path }.ifBlank { "未知请求" },
                fontSize = 11.sp,
                maxLines = 1
            )
            val bits = mutableListOf<String>()
            bits.add(timeOf(e.ts))
            if (e.status > 0) bits.add("HTTP ${e.status}")
            bits.add(fmtMs(e.ms))
            if (e.stream) bits.add("流")
            if (e.ua.isNotBlank()) bits.add(e.ua)
            if (e.code.isNotBlank()) bits.add(e.code)
            Text(
                bits.joinToString(" · "),
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Spacer(Modifier.width(6.dp))
        Text(
            "${fmtNum(e.inTok)}/${fmtNum(e.outTok)}",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

private fun fmtNum(n: Long): String = when {
    n >= 1_000_000 -> String.format(Locale.getDefault(), "%.1fM", n / 1_000_000.0)
    n >= 10_000 -> String.format(Locale.getDefault(), "%.1fK", n / 1_000.0)
    else -> n.toString()
}

private fun fmtMs(ms: Long): String = when {
    ms < 0 -> "—"
    ms >= 10_000 -> String.format(Locale.getDefault(), "%.1fs", ms / 1000.0)
    else -> "${ms}ms"
}

private fun pct(v: Double): String =
    if (v.isNaN() || v.isInfinite()) "—" else String.format(Locale.getDefault(), "%.1f%%", v)

private fun timeOf(ts: Long): String =
    SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(ts))
