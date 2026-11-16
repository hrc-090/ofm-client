package com.ofm.client

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 自动续期状态（与 /api/renew/auto 的 value.autoRenew 对齐）。 */
data class RenewChannelRow(val provider: String, val text: String, val outcome: String)

data class RenewUiState(
    val enabled: Boolean = true,
    val running: Boolean = false,
    val lastAt: Long = 0L,
    val lastResult: String = "",
    val tickMs: Long = 0L,
    val aheadMs: Long = 0L,
    val channels: List<RenewChannelRow> = emptyList()
)

/**
 * 设置页「自动续期」卡。
 *
 * 状态与网络动作全部由 MainActivity 持有，这里只展示与转发，和 UpdateCard 同一套约定。
 * 卡片里绝不出现凭据值（服务端下发的 channels 文案只含账号尾号、结果与有效期）。
 */
@Composable
fun RenewCard(
    state: RenewUiState,
    busy: Boolean,
    onToggle: (Boolean) -> Unit,
    onRun: () -> Unit
) {
    OfmCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("自动续期", style = MaterialTheme.typography.titleSmall)
                Text(
                    if (state.enabled) "后台定时保活已开启" else "已关闭，凭据过期后需重新登录",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Switch(
                checked = state.enabled,
                onCheckedChange = onToggle,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = MaterialTheme.colorScheme.tertiary,
                    checkedTrackColor = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.32f)
                )
            )
        }

        Text(
            "常驻后台定时给「快过期」的账号静默刷新，放着几天不用也不用重新登录；" +
                "刷新失败会如实标「需重新登录」，不绕过上游风控。",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        val tick = state.tickMs / 60000
        val ahead = state.aheadMs / 60000
        if (tick > 0 || ahead > 0) {
            Text(
                "巡检间隔 ${if (tick > 0) "${tick} 分钟" else "—"} · 提前窗口 ${if (ahead > 0) "${ahead} 分钟" else "—"}",
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        if (state.lastAt > 0) {
            val time = runCatching {
                SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(state.lastAt))
            }.getOrDefault("")
            Text(
                "上次巡检 $time · ${state.lastResult.ifBlank { "无账号" }}",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface
            )
        } else {
            Text(
                "尚未巡检；启动约 8 秒后自动跑第一轮。",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        if (state.channels.isNotEmpty()) {
            Spacer(Modifier.height(2.dp))
            for (row in state.channels.take(8)) {
                val color = when (row.outcome) {
                    "ok" -> OfmDesign.Ok
                    "auth-failed", "error" -> MaterialTheme.colorScheme.error
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }
                Text(row.text, fontSize = 10.sp, color = color)
            }
            if (state.channels.size > 8) {
                Text("…另有 ${state.channels.size - 8} 条", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        FilledTonalButton(
            onClick = onRun,
            enabled = !busy && state.enabled,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(if (busy || state.running) "正在续期…" else "立即续期", fontSize = 12.sp)
        }
    }
}
