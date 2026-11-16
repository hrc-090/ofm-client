package com.ofm.client

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale

/**
 * 设置页「版本更新」卡。
 *
 * 状态全部由 MainActivity 持有，这里只做展示；所有网络/下载/安装动作都通过回调抛出，
 * 卡片自己不启动协程、不碰 Context（除了取字符串资源式的格式化）。
 */
@Composable
fun UpdateCard(
    currentVersion: String,
    state: UpdateUiState,
    mirror: String,
    onCheck: () -> Unit,
    onDownloadInstall: () -> Unit,
    onRetryInstall: () -> Unit,
    onOpenInstallSettings: () -> Unit,
    onMirrorChange: (String) -> Unit,
    onOpenRelease: () -> Unit
) {
    OfmCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("版本更新", style = MaterialTheme.typography.titleSmall)
                Text(
                    "当前 v$currentVersion · 从 GitHub Releases 拉取",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        when (state) {
            is UpdateUiState.Idle -> {
                Hint("启动后每 24 小时自动检查一次；也可以手动查。")
            }
            is UpdateUiState.Checking -> {
                Hint("正在检查新版本…")
            }
            is UpdateUiState.UpToDate -> {
                Text(
                    "已是最新版本（线上 ${state.remote.ifBlank { state.current }}）",
                    fontSize = 12.sp,
                    color = OfmDesign.Ok
                )
            }
            is UpdateUiState.Available -> {
                Text(
                    "发现新版本 ${state.info.tag}",
                    fontSize = 14.sp,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.tertiary
                )
                val meta = listOfNotNull(
                    state.info.publishedAt.takeIf { it.isNotBlank() },
                    if (state.info.apkSize > 0) formatSize(state.info.apkSize) else null
                ).joinToString(" · ")
                if (meta.isNotBlank()) {
                    Text(meta, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (state.info.notes.isNotBlank()) {
                    Text(
                        state.info.notes.trim(),
                        fontSize = 11.sp,
                        maxLines = 8,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Button(onClick = onDownloadInstall, modifier = Modifier.fillMaxWidth()) {
                    Text("下载并安装", fontSize = 12.sp)
                }
            }
            is UpdateUiState.Downloading -> {
                Text("正在下载安装包…", fontSize = 12.sp)
                val p = state.progress
                // 不用 LinearProgressIndicator：不同 material3 版本的 progress 参数签名不一致，
                // 自己画一条细条更稳，也和看板里的进度条一致。
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(6.dp)
                        .clip(OfmDesign.ControlShape)
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth(if (p >= 0f) p.coerceIn(0.02f, 1f) else 0.12f)
                            .fillMaxHeight()
                            .clip(OfmDesign.ControlShape)
                            .background(MaterialTheme.colorScheme.tertiary)
                    )
                }
                Text(
                    if (p >= 0f) "${(p * 100).toInt()}% · ${formatSize(state.downloaded)} / ${formatSize(state.total)}"
                    else "已下载 ${formatSize(state.downloaded)}",
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            is UpdateUiState.Verifying -> {
                Hint("正在用 SHA256SUMS.txt 校验安装包…")
            }
            is UpdateUiState.Ready -> {
                if (state.needPermission) {
                    Text(
                        "安装包已校验通过，还差一步：允许本应用安装未知来源应用。",
                        fontSize = 12.sp,
                        color = OfmDesign.Warn
                    )
                    Button(onClick = onOpenInstallSettings, modifier = Modifier.fillMaxWidth()) {
                        Text("去开启安装权限", fontSize = 12.sp)
                    }
                    OutlinedButton(onClick = onRetryInstall, modifier = Modifier.fillMaxWidth()) {
                        Text("已开启，重试安装", fontSize = 12.sp)
                    }
                } else {
                    Text(
                        "安装包已校验，系统安装界面已拉起。若被取消可重试。",
                        fontSize = 12.sp,
                        color = OfmDesign.Ok
                    )
                    OutlinedButton(onClick = onRetryInstall, modifier = Modifier.fillMaxWidth()) {
                        Text("重试安装", fontSize = 12.sp)
                    }
                }
            }
            is UpdateUiState.Failed -> {
                Text(
                    state.message,
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = onCheck,
                enabled = state !is UpdateUiState.Checking && state !is UpdateUiState.Downloading &&
                    state !is UpdateUiState.Verifying,
                modifier = Modifier.weight(1f)
            ) { Text("检查更新", fontSize = 12.sp) }
            TextButton(onClick = onOpenRelease, modifier = Modifier.weight(1f)) {
                Text("打开 Release 页", fontSize = 12.sp)
            }
        }

        OutlinedTextField(
            value = mirror,
            onValueChange = onMirrorChange,
            label = { Text("GitHub 加速前缀（可选）", fontSize = 11.sp) },
            placeholder = { Text("https://ghproxy.net/", fontSize = 11.sp) },
            supportingText = {
                Text(
                    "国内直连 GitHub 超时才需要填；填了会先走镜像、失败自动回退官方。" +
                        "留空 = 只走官方。安装包一律校验 SHA256，镜像无法伪造。",
                    fontSize = 10.sp
                )
            },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
            modifier = Modifier.fillMaxWidth()
        )

        Hint("安装包与本版本同签名，可直接覆盖安装；不会静默安装，每一步都由系统安装器确认。")
    }
}

@Composable
private fun Hint(text: String) {
    Text(text, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

private fun formatSize(bytes: Long): String =
    if (bytes <= 0) "—" else String.format(Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0)
