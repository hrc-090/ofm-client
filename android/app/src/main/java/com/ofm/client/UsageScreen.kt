package com.ofm.client

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * 用量看板 + 运行日志（对照上游「数据看板 / 用量看板 / 运行日志」三块）。
 *
 * 数据全部来自本机 /api/usage 系列接口，Node 侧按天分片存 JSONL（只存统计，不存正文）。
 * App 只读不写上游，切换时间范围会重新聚合，清空只删本机分片。
 *
 * 三个刻意保留的口径（都是踩过坑的）：
 *  - 缓存未上报显示「—」，不是 0；
 *  - 输出速度按总 token / 总生成窗口加权，无有效时间窗显示「—」；
 *  - 平均耗时只统计成功请求，超时失败不混进来。
 */
@Composable
fun UsageScreen(running: Boolean) {
    var days by rememberSaveable { mutableStateOf(7) }
    var metric by rememberSaveable { mutableStateOf(0) } // 0=请求数 1=Token
    var summary by remember { mutableStateOf<JSONObject?>(null) }
    var logs by remember { mutableStateOf<List<LogEntry>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var showClear by remember { mutableStateOf(false) }
    var logLimit by rememberSaveable { mutableStateOf(30) }
    var refreshKey by rememberSaveable { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    // 直接内联加载，不用局部 suspend lambda：避免 Compose 捕获 lambda 时把一次
    // 加载跨重组重复触发。切范围 / 加载更多 / 点刷新都只改 key。
    LaunchedEffect(days, logLimit, refreshKey) {
        busy = true
        error = ""
        val pair = withContext(Dispatchers.IO) {
            runCatching { ApiClient.usageSummary(days) to ApiClient.usageLog(logLimit, days) }
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
    // 上游是否上报过缓存字段：false = 没数据，不能当成「命中 0」。
    val cacheReported = t?.optBoolean("cacheReported", false) ?: false
    val cachedTok = t?.optLong("cachedTok") ?: 0L
    val speed = nullableDouble(t, "speedTokPerSec")
    val speedSamples = t?.optLong("speedSamples") ?: 0L
    val byDay = summary?.optJSONArray("byDay")

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // ── 控制区 ──
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
                    listOf(1 to "今日", 7 to "7 天", 30 to "30 天", 119 to "17 周").forEach { (d, label) ->
                        OutlinedButton(
                            onClick = { days = d },
                            enabled = !busy && days != d,
                            modifier = Modifier.weight(1f),
                            contentPadding = PaddingValues(horizontal = 2.dp, vertical = 6.dp)
                        ) { Text(label, fontSize = 10.sp, maxLines = 1) }
                    }
                    Button(
                        onClick = { showClear = true },
                        enabled = !busy,
                        modifier = Modifier.weight(1f),
                        contentPadding = PaddingValues(horizontal = 2.dp, vertical = 6.dp)
                    ) { Text("清空", fontSize = 10.sp, maxLines = 1) }
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

        // ── 核心指标 ──
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatTile(fmtNum(requests), "请求数", Modifier.weight(1f))
                StatTile(pct(t?.optDouble("successRate", Double.NaN) ?: Double.NaN), "成功率", Modifier.weight(1f))
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatTile(fmtNum(t?.optLong("inTok") ?: 0L), "输入 token", Modifier.weight(1f))
                StatTile(fmtNum(t?.optLong("outTok") ?: 0L), "输出 token", Modifier.weight(1f))
                // 上游没上报缓存字段时显示「—」，不把「无数据」伪装成「命中 0」。
                StatTile(if (cacheReported) fmtNum(cachedTok) else "—", "缓存命中", Modifier.weight(1f))
            }
        }
        if (!cacheReported && requests > 0) {
            item {
                Text(
                    "当前渠道未上报缓存用量，故无命中数据；上游支持并返回时会自动统计。",
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 4.dp)
                )
            }
        }

        // ── 性能（上游「平均生成速度 / 首字延迟逐次采样」）──
        item {
            OfmCard {
                Text("性能", style = MaterialTheme.typography.titleSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatTile(fmtSpeed(speed), "生成速度 tok/s", Modifier.weight(1f))
                    StatTile(fmtMs(t?.optLong("avgFirstMs", -1) ?: -1), "平均首字", Modifier.weight(1f))
                }
                Spacer(Modifier.height(2.dp))
                // 平均耗时只算成功请求：一次 75s 超时反映的是故障，不是日常体验。
                KeyLine("平均耗时（成功）", fmtMs(t?.optLong("avgMs", -1) ?: -1))
                KeyLine("缓存命中率", pct(t?.optDouble("cacheHitRate", Double.NaN) ?: Double.NaN))
                // 省 Token：只统计 RTK 压缩掉的工具输出，按 4 字节/token 估算
                val savedTokens = t?.optLong("savedTokens") ?: 0L
                if (savedTokens > 0) {
                    KeyLine("省 Token（工具输出压缩）", fmtNum(savedTokens))
                }
                KeyLine("失败请求", (t?.optLong("failed") ?: 0L).toString())
                if ((t?.optLong("truncated") ?: 0L) > 0) {
                    KeyLine("半截流（已吐正文后断开）", (t?.optLong("truncated") ?: 0L).toString())
                }
                if ((t?.optLong("noUsage") ?: 0L) > 0) {
                    KeyLine("上游未报 token", (t?.optLong("noUsage") ?: 0L).toString())
                }
                Text(
                    if (speedSamples > 0) {
                        "速度按总输出 token / 总生成窗口加权，基于 $speedSamples 次有效采样；" +
                            "单大帧或纯思考静默没有时间窗，不计入也不折算。"
                    } else {
                        "暂无有效速度采样：答案集中在一两帧、或上游未报 token 时，看板宁可留空。"
                    },
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        // ── 趋势：请求数 / Token 切换 ──
        if (byDay != null && byDay.length() > 0) {
            item {
                OfmCard {
                    Text("每日趋势", style = MaterialTheme.typography.titleSmall)
                    OfmSegmented(listOf("请求数", "Token"), metric, onSelect = { metric = it })
                    val values = (0 until byDay.length()).map { i ->
                        val d = byDay.optJSONObject(i)
                        if (metric == 0) (d?.optLong("requests") ?: 0L)
                        else (d?.optLong("tok") ?: 0L)
                    }
                    val max = values.maxOrNull()?.coerceAtLeast(1L) ?: 1L
                    // 17 周档有 119 天，逐条画会太密：只画最近 30 天，全貌交给热力图。
                    val start = (byDay.length() - 30).coerceAtLeast(0)
                    for (i in start until byDay.length()) {
                        val d = byDay.optJSONObject(i) ?: continue
                        TrendRow(
                            day = d.optString("day"),
                            value = values[i],
                            failed = d.optLong("failed"),
                            ok = d.optLong("ok"),
                            max = max,
                            tokenMode = metric == 1
                        )
                    }
                    if (start > 0) {
                        Text(
                            "仅显示最近 30 天，完整 ${byDay.length()} 天见下方热力图。",
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            // ── 17 周 Token 热力图 ──
            item {
                OfmCard {
                    Text("Token 热力图", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "每格一天、颜色越深 token 越多；按周排列，最近 ${byDay.length()} 天",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Heatmap(byDay)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("少", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(5.dp))
                        for (a in listOf(0f, 0.25f, 0.5f, 0.75f, 1f)) {
                            Box(
                                Modifier
                                    .size(11.dp)
                                    .clip(OfmDesign.TagShape)
                                    .background(heatColor(a, a > 0f))
                            )
                            Spacer(Modifier.width(3.dp))
                        }
                        Text("多", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }

        // ── 模型性能表 ──
        val byModel = summary?.optJSONArray("byModel")
        if (byModel != null && byModel.length() > 0) {
            item {
                OfmCard {
                    Text("模型性能", style = MaterialTheme.typography.titleSmall)
                    for (i in 0 until byModel.length()) {
                        val m = byModel.optJSONObject(i) ?: continue
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                m.optString("model"),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1
                            )
                            Text(
                                "${m.optLong("requests")} 次 · 成功率 " +
                                    "${pct(m.optDouble("successRate", Double.NaN))} · " +
                                    "首字 ${fmtMs(m.optLong("avgFirstMs", -1))} · " +
                                    "速度 ${fmtSpeed(nullableDouble(m, "speedTokPerSec"))} tok/s",
                                fontSize = 10.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Text(
                                "入 ${fmtNum(m.optLong("inTok"))} / 出 ${fmtNum(m.optLong("outTok"))} tok" +
                                    if (m.optLong("cachedTok") > 0) " · 命中 ${fmtNum(m.optLong("cachedTok"))}" else "",
                                fontSize = 10.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        if (i < byModel.length() - 1) {
                            Spacer(Modifier.height(2.dp))
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .height(1.dp)
                                    .background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                            )
                        }
                    }
                }
            }
        }

        // ── 账号透视 ──
        val byAccount = summary?.optJSONArray("byAccount")
        if (byAccount != null && byAccount.length() > 0) {
            item {
                OfmCard {
                    Text("账号透视", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "仅显示脱敏后的「渠道#尾4位」",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    for (i in 0 until byAccount.length()) {
                        val a = byAccount.optJSONObject(i) ?: continue
                        val req = a.optLong("requests")
                        KeyLine(
                            a.optString("account"),
                            "$req 次 · 成功 ${a.optLong("ok")} · ${fmtNum(a.optLong("inTok") + a.optLong("outTok"))} tok"
                        )
                    }
                }
            }
        }

        // ── 失败原因 ──
        val byCode = summary?.optJSONArray("byCode")
        if (byCode != null && byCode.length() > 0) {
            item {
                OfmCard {
                    Text("失败原因", style = MaterialTheme.typography.titleSmall)
                    for (i in 0 until byCode.length()) {
                        val c = byCode.optJSONObject(i) ?: continue
                        val code = c.optString("code")
                        KeyLine("$code · ${explainCode(code)}", "${c.optLong("count")} 次")
                    }
                }
            }
        }

        // ── 来源分布 ──
        val byProvider = summary?.optJSONArray("byProvider")
        val byUa = summary?.optJSONArray("byUa")
        if ((byProvider?.length() ?: 0) > 0 || (byUa?.length() ?: 0) > 0) {
            item {
                OfmCard {
                    Text("来源分布", style = MaterialTheme.typography.titleSmall)
                    if (byProvider != null) {
                        for (i in 0 until byProvider.length()) {
                            val p = byProvider.optJSONObject(i) ?: continue
                            val req = p.optLong("requests")
                            val okc = p.optLong("ok")
                            KeyLine(
                                p.optString("provider"),
                                "$req 次" + if (req > 0) " · 成功 ${pct(okc * 100.0 / req)}" else ""
                            )
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

        // ── 运行日志 ──
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

/* ───────── 数据解析 ───────── */

private data class LogEntry(
    val ts: Long,
    val ok: Boolean,
    val status: Int,
    val code: String,
    val model: String,
    val path: String,
    val provider: String,
    val account: String,
    val ms: Long,
    val firstMs: Long,
    val genMs: Long,
    val deltas: Long,
    val inTok: Long,
    val outTok: Long,
    val cachedTok: Long,
    val ua: String,
    val stream: Boolean,
    val truncated: Boolean,
    val noUsage: Boolean
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
            account = o.optString("account"),
            ms = o.optLong("ms"),
            firstMs = o.optLong("firstMs", -1),
            genMs = o.optLong("genMs", -1),
            deltas = o.optLong("deltas"),
            inTok = o.optLong("inTok"),
            outTok = o.optLong("outTok"),
            cachedTok = o.optLong("cachedTok"),
            ua = o.optString("ua"),
            stream = o.optBoolean("stream"),
            truncated = o.optBoolean("truncated"),
            noUsage = o.optBoolean("noUsage")
        )
    }
}

/** JSONObject 里可能是 JSON null，optDouble 的 fallback 兜成 NaN，统一转 null。 */
private fun nullableDouble(o: JSONObject?, key: String): Double? {
    if (o == null || o.isNull(key)) return null
    val v = o.optDouble(key, Double.NaN)
    return if (v.isNaN() || v.isInfinite()) null else v
}

/** 把内部错误码翻成人能看的一句话。 */
private fun explainCode(code: String): String = when {
    code == "AUTH" -> "需重新登录"
    code == "QUOTA_EXCEEDED" -> "额度用尽"
    code == "MODEL_QUEUED" -> "上游排队"
    code == "RATE_LIMITED" -> "渠道限流"
    code == "TRANSPORT" -> "连接中断/断流"
    code == "TIMEOUT" -> "超时"
    code == "SERVER" -> "上游 5xx"
    code == "INVALID_REQUEST" -> "请求不合法"
    code == "NO_ACCOUNT" -> "无可用账号"
    code == "UNSUPPORTED" -> "能力未实现"
    code == "EMPTY_REPLY" -> "空回复"
    code == "UPSTREAM" -> "上游错误"
    code.startsWith("HTTP_") -> "状态码 ${code.removePrefix("HTTP_")}"
    else -> "其它"
}

/* ───────── 展示组件 ───────── */

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

/** 趋势条：失败段单独叠红，不再因为一天有一次失败就把整条染红。 */
@Composable
private fun TrendRow(day: String, value: Long, failed: Long, ok: Long, max: Long, tokenMode: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val label = if (day.length >= 10) day.substring(5) else day
    val ratio = (value.toFloat() / max).coerceIn(0f, 1f)
    val failedRatio = if (value > 0) (failed.toFloat() / value).coerceIn(0f, 1f) else 0f
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, fontSize = 10.sp, modifier = Modifier.width(42.dp))
        Box(
            Modifier
                .weight(1f)
                .height(10.dp)
                .clip(RoundedCornerShape(5.dp))
                .background(scheme.surfaceVariant)
        ) {
            Box(
                Modifier
                    .fillMaxWidth(ratio)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(5.dp))
                    .background(scheme.primary)
            )
            if (failedRatio > 0f) {
                Box(
                    Modifier
                        .fillMaxWidth(ratio * failedRatio)
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(5.dp))
                        .background(scheme.error)
                )
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(
            if (tokenMode) fmtNum(value) else value.toString(),
            fontSize = 10.sp,
            modifier = Modifier.width(38.dp)
        )
    }
}

/** 17 周热力图：每列一周、每行一天，颜色按 token 相对峰值分档。 */
@Composable
private fun Heatmap(byDay: JSONArray) {
    val cells = (0 until byDay.length()).mapNotNull { i ->
        val d = byDay.optJSONObject(i) ?: return@mapNotNull null
        d.optString("day") to d.optLong("tok")
    }
    if (cells.isEmpty()) return
    val max = cells.maxOf { it.second }.coerceAtLeast(1L)
    val offset = dayOfWeek(cells[0].first)
    val columns = (offset + cells.size + 6) / 7
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        for (c in 0 until columns) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                for (r in 0 until 7) {
                    val idx = c * 7 + r - offset
                    val cell = cells.getOrNull(idx)
                    val intensity = if (cell == null || cell.second <= 0) 0f
                    else (cell.second.toFloat() / max).coerceIn(0.08f, 1f)
                    Box(
                        Modifier
                            .size(12.dp)
                            .clip(OfmDesign.TagShape)
                            .background(heatColor(intensity, intensity > 0f))
                            .then(
                                if (intensity == 0f && cell != null)
                                    Modifier.border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, OfmDesign.TagShape)
                                else Modifier
                            )
                    )
                }
            }
        }
    }
}

@Composable
private fun heatColor(intensity: Float, hasData: Boolean): Color {
    val scheme = MaterialTheme.colorScheme
    if (!hasData) return scheme.surfaceVariant.copy(alpha = 0.45f)
    return scheme.primary.copy(alpha = 0.18f + 0.82f * intensity)
}

private fun dayOfWeek(day: String): Int {
    return try {
        val d = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).parse(day) ?: return 0
        val cal = Calendar.getInstance()
        cal.time = d
        (cal.get(Calendar.DAY_OF_WEEK) + 5) % 7 // 周一 = 0
    } catch (e: Exception) {
        0
    }
}

@Composable
private fun LogRow(e: LogEntry) {
    Column(Modifier.fillMaxWidth()) {
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
                if (e.firstMs >= 0) bits.add("首字 ${fmtMs(e.firstMs)}")
                if (e.stream) bits.add("流")
                if (e.ua.isNotBlank()) bits.add(e.ua)
                if (e.code.isNotBlank()) bits.add("${e.code} ${explainCode(e.code)}".trim())
                if (e.truncated) bits.add("半截流")
                if (e.noUsage) bits.add("上游未报 token")
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
        // 第二行：速度、缓存命中、账号，只有有值才出现，避免噪声。
        val extra = mutableListOf<String>()
        val spd = if (e.genMs > 0 && e.outTok > 0 && e.deltas >= 2) e.outTok * 1000.0 / e.genMs else null
        if (spd != null) extra.add("${fmtSpeed(spd)} tok/s")
        if (e.cachedTok > 0) extra.add("命中 ${fmtNum(e.cachedTok)}")
        if (e.account.isNotBlank()) extra.add(e.account)
        if (extra.isNotEmpty()) {
            Text(
                extra.joinToString(" · "),
                fontSize = 9.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 16.dp, top = 1.dp)
            )
        }
    }
}

/* ───────── 格式化 ───────── */

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

/** 速度保留 1 位；null（无有效时间窗）显示「—」，绝不折算成 0。 */
private fun fmtSpeed(v: Double?): String =
    if (v == null || v.isNaN() || v.isInfinite()) "—"
    else String.format(Locale.getDefault(), "%.1f", v)

private fun pct(v: Double): String =
    if (v.isNaN() || v.isInfinite()) "—" else String.format(Locale.getDefault(), "%.1f%%", v)

private fun timeOf(ts: Long): String =
    SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(ts))
