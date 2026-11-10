package com.ofm.client

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 设计语言：「仪器台 / Instrument Panel」。
 *
 * 不是默认 Material 换色，而是三条明确的取舍：
 * 1. 暖纸底 + 墨色文字 + 朱砂点缀，避开「靛蓝渐变 + 霓虹」那套泛 AI 配色；
 * 2. 用 1px 细线与分层底色建立层级，卡片只在真正需要分组时出现（减少卡片套卡片）；
 * 3. 数据（URL / Key / 数字 / 模型 id）用等宽 + 大字重，正文用系统 sans，
 *    让「可复制的机器字段」和「给人读的说明」一眼可分。
 *
 * 语义状态色（Ok/Warn/Bad）刻意不随主题变成 Material 动态色：
 * 「运行中 / 失败」在各机型上必须是同一个意思。
 */
object OfmDesign {
    val Ink = Color(0xFF1B2430)
    val Paper = Color(0xFFF6F4EF)
    val Surface = Color(0xFFFDFCF9)
    val Accent = Color(0xFFB24A2E)
    val Ok = Color(0xFF2E7D5B)
    val Warn = Color(0xFFA9750F)
    val Bad = Color(0xFFAE3A34)

    val DarkPaper = Color(0xFF12151A)
    val DarkSurface = Color(0xFF1A1E25)
    val DarkAccent = Color(0xFFED9A7C)
    val DarkOk = Color(0xFF6FCBA3)
    val DarkWarn = Color(0xFFE0B45A)
    val DarkBad = Color(0xFFF08C85)

    /** 12dp 是全局基准：卡片大圆、控件中圆、标签小圆，比例固定不随页面漂移 */
    val CardShape = RoundedCornerShape(12.dp)
    val ControlShape = RoundedCornerShape(8.dp)
    val TagShape = RoundedCornerShape(5.dp)
}

private val LightColors = lightColorScheme(
    primary = OfmDesign.Ink,
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFE9E6DE),
    onPrimaryContainer = Color(0xFF1B2430),
    secondary = Color(0xFF4E5561),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFEDEAE3),
    onSecondaryContainer = Color(0xFF252B35),
    tertiary = OfmDesign.Accent,
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFF8E5DD),
    onTertiaryContainer = Color(0xFF7A2E18),
    background = OfmDesign.Paper,
    onBackground = OfmDesign.Ink,
    surface = OfmDesign.Surface,
    onSurface = OfmDesign.Ink,
    surfaceVariant = Color(0xFFEFECE4),
    onSurfaceVariant = Color(0xFF5A6070),
    outline = Color(0xFF7C8290),
    outlineVariant = Color(0xFFDCD8CE),
    error = OfmDesign.Bad,
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFBE3E0),
    onErrorContainer = Color(0xFF7A211C)
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFECE9E1),
    onPrimary = Color(0xFF1B2430),
    primaryContainer = Color(0xFF2C323C),
    onPrimaryContainer = Color(0xFFECE9E1),
    secondary = Color(0xFFB8BCC7),
    onSecondary = Color(0xFF242A33),
    secondaryContainer = Color(0xFF333943),
    onSecondaryContainer = Color(0xFFE2E4EA),
    tertiary = OfmDesign.DarkAccent,
    onTertiary = Color(0xFF3A1A10),
    tertiaryContainer = Color(0xFF4A2A20),
    onTertiaryContainer = Color(0xFFF6CBBB),
    background = OfmDesign.DarkPaper,
    onBackground = Color(0xFFECE9E1),
    surface = OfmDesign.DarkSurface,
    onSurface = Color(0xFFECE9E1),
    surfaceVariant = Color(0xFF272C35),
    onSurfaceVariant = Color(0xFFAEB3BF),
    outline = Color(0xFF9BA1AE),
    outlineVariant = Color(0xFF3A404B),
    error = OfmDesign.DarkBad,
    onError = Color(0xFF4A1210),
    errorContainer = Color(0xFF5A2320),
    onErrorContainer = Color(0xFFF9D6D3)
)

/** 模块化字阶：靠字重 / 字距 / 行高拉开层次，不引入额外字体资源 */
private val OfmType = Typography(
    displayLarge = TextStyle(fontSize = 32.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.8).sp, lineHeight = 38.sp),
    headlineMedium = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp, lineHeight = 28.sp),
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.2).sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.1.sp, lineHeight = 19.sp),
    bodyLarge = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Normal, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Normal, lineHeight = 19.sp),
    bodySmall = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Normal, lineHeight = 17.sp),
    labelLarge = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.1.sp),
    labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.3.sp)
)

private val OfmShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(8.dp),
    large = RoundedCornerShape(12.dp),
    extraLarge = RoundedCornerShape(18.dp)
)

@Composable
fun OfmTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        typography = OfmType,
        shapes = OfmShapes,
        content = content
    )
}

/* ─────────────────────── 状态与标签 ─────────────────────── */

enum class StatusTone { Ok, Wait, Bad }

@Composable
fun toneColor(tone: StatusTone): Color {
    val dark = isSystemInDarkTheme()
    return when (tone) {
        StatusTone.Ok -> if (dark) OfmDesign.DarkOk else OfmDesign.Ok
        StatusTone.Wait -> if (dark) OfmDesign.DarkWarn else OfmDesign.Warn
        StatusTone.Bad -> if (dark) OfmDesign.DarkBad else OfmDesign.Bad
    }
}

/** 仪器灯：外环 + 内点，比一个纯色小方块更像「状态指示」 */
@Composable
fun StatusDot(tone: StatusTone) {
    val color = toneColor(tone)
    Canvas(Modifier.size(12.dp)) {
        val s = size.minDimension
        drawCircle(color.copy(alpha = 0.28f), radius = s * 0.44f, style = Stroke(width = s * 0.09f))
        drawCircle(color, radius = s * 0.24f)
    }
}

/**
 * 小胶囊标签。状态不只用颜色区分：带状态的一律加一枚同色圆点，
 * 色觉障碍与强光下也能读。
 */
@Composable
fun Pill(text: String, tone: StatusTone? = null) {
    val scheme = MaterialTheme.colorScheme
    val fg = if (tone != null) toneColor(tone) else scheme.onSurfaceVariant
    val bg = if (tone != null) fg.copy(alpha = 0.11f) else scheme.surfaceVariant
    val line = if (tone != null) fg.copy(alpha = 0.30f) else scheme.outlineVariant
    Row(
        Modifier
            .clip(OfmDesign.TagShape)
            .background(bg)
            .border(1.dp, line, OfmDesign.TagShape)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (tone != null) {
            Box(Modifier.size(5.dp).background(fg, RoundedCornerShape(3.dp)))
            Spacer(Modifier.width(5.dp))
        }
        Text(text, color = fg, fontSize = 10.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.2.sp)
    }
}

/* ─────────────────────── 容器与数据展示 ─────────────────────── */

/**
 * 统一卡片：12dp 圆角、1px 细描边、极淡底色、零阴影。
 * 细线分组比投影轻，长时间看不累，深浅主题下都清楚。
 * 保留原有 (modifier, container, content) 签名，旧页面无需改动。
 */
@Composable
fun OfmCard(
    modifier: Modifier = Modifier,
    container: Color = MaterialTheme.colorScheme.surface,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(OfmDesign.CardShape)
            .background(container)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.75f), OfmDesign.CardShape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content
    )
}

/** 指标块：左对齐 + 大数字 + 细描边，数字是主角，标签是注脚 */
@Composable
fun StatTile(value: String, label: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Column(
        modifier
            .clip(OfmDesign.CardShape)
            .background(scheme.surfaceVariant.copy(alpha = 0.32f))
            .border(1.dp, scheme.outlineVariant.copy(alpha = 0.6f), OfmDesign.CardShape)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        Text(
            value,
            fontSize = 23.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = (-0.6).sp,
            color = scheme.onSurface
        )
        Text(label, fontSize = 11.sp, color = scheme.onSurfaceVariant)
    }
}

/** 等宽数据字：URL / Key / 模型 id 专用，轻微字距让长串更好扫 */
@Composable
fun MonoText(text: String, size: Int = 12, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Text(text, fontFamily = FontFamily.Monospace, fontSize = size.sp, letterSpacing = 0.15.sp, color = color)
}

/** 分组小标：字距拉开，像仪器面板上的刻度标签 */
@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.5.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

/** 分组标题行：左侧标题，右侧可选操作 */
@Composable
fun SectionLabel(text: String, trailing: @Composable (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}

/**
 * 可复制字段：整行点击即复制，右侧自绘复制图标。
 * 比「一个按钮 + 一行字」少一次视线跳转，也省掉按钮文案。
 */
@Composable
fun CopyField(label: String, value: String, modifier: Modifier = Modifier, onCopy: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier
            .fillMaxWidth()
            .clip(OfmDesign.ControlShape)
            .background(scheme.surfaceVariant.copy(alpha = 0.42f))
            .border(1.dp, scheme.outlineVariant.copy(alpha = 0.6f), OfmDesign.ControlShape)
            .clickable(onClick = onCopy)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, fontSize = 10.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.6.sp, color = scheme.onSurfaceVariant)
            Spacer(Modifier.height(3.dp))
            MonoText(value, 13, scheme.onSurface)
        }
        Spacer(Modifier.width(10.dp))
        CopyGlyph(scheme.onSurfaceVariant)
    }
}

@Composable
private fun CopyGlyph(tint: Color) {
    Canvas(Modifier.size(16.dp)) {
        val s = size.minDimension
        val w = s * 0.1f
        drawRoundRect(
            tint, topLeft = Offset(s * 0.30f, s * 0.14f), size = Size(s * 0.56f, s * 0.62f),
            cornerRadius = CornerRadius(s * 0.09f), style = Stroke(width = w)
        )
        drawRoundRect(
            tint, topLeft = Offset(s * 0.12f, s * 0.30f), size = Size(s * 0.56f, s * 0.62f),
            cornerRadius = CornerRadius(s * 0.09f), style = Stroke(width = w)
        )
    }
}

/**
 * 二段式分段开关：合并页里切「模型目录 / 签到积分」这类同层级内容。
 * 选中段用主色实心填充，未选中只留淡底；整条 1px 描边 + 8dp 圆角，
 * 单段 38dp + 外框内边距，触控目标 ≥44dp。状态除了颜色还有字重差异。
 */
@Composable
fun OfmSegmented(
    items: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier
            .fillMaxWidth()
            .clip(OfmDesign.ControlShape)
            .border(1.dp, scheme.outlineVariant.copy(alpha = 0.75f), OfmDesign.ControlShape)
            .background(scheme.surfaceVariant.copy(alpha = 0.35f))
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp)
    ) {
        items.forEachIndexed { i, label ->
            val active = i == selected
            Box(
                Modifier
                    .weight(1f)
                    .height(38.dp)
                    .clip(OfmDesign.TagShape)
                    .background(if (active) scheme.primary else Color.Transparent)
                    .clickable { onSelect(i) },
                contentAlignment = Alignment.Center
            ) {
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = if (active) FontWeight.Bold else FontWeight.Medium,
                    color = if (active) scheme.onPrimary else scheme.onSurfaceVariant
                )
            }
        }
    }
}

/* ─────────────────────── 导航 ─────────────────────── */

/**
 * 自绘底栏：不依赖 material-icons，图标用 Canvas 画，任何机型渲染一致。
 * 选中态 = 顶部短横线 + 淡色图标底 + 主色文字，不用整块高亮色。
 */
@Composable
fun OfmBottomBar(
    tabs: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit
) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().background(scheme.background)) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(scheme.outlineVariant.copy(alpha = 0.55f))
        )
        Row(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .height(64.dp)
        ) {
            tabs.forEachIndexed { i, label ->
                val active = i == selected
                val tint = if (active) scheme.onSurface else scheme.onSurfaceVariant
                Column(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clickable { onSelect(i) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Box(
                        Modifier
                            .width(20.dp)
                            .height(2.dp)
                            .background(
                                if (active) scheme.tertiary else Color.Transparent,
                                RoundedCornerShape(1.dp)
                            )
                    )
                    Spacer(Modifier.height(5.dp))
                    Box(
                        Modifier
                            .size(26.dp)
                            .background(
                                if (active) scheme.tertiary.copy(alpha = 0.10f) else Color.Transparent,
                                RoundedCornerShape(8.dp)
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        TabGlyph(i, tint)
                    }
                    Spacer(Modifier.height(3.dp))
                    Text(
                        label,
                        fontSize = 11.sp,
                        fontWeight = if (active) FontWeight.Bold else FontWeight.Medium,
                        color = tint
                    )
                }
            }
        }
    }
}

/** 五个 tab 的图标：仪表盘 / 节点 / 列表 / 柱状 / 放大镜，线宽统一、留白一致 */
@Composable
private fun TabGlyph(index: Int, tint: Color) {
    Canvas(Modifier.size(17.dp)) {
        val s = size.minDimension
        val sw = s * 0.09f
        when (index) {
            0 -> {
                drawCircle(tint, radius = s * 0.30f, style = Stroke(width = sw))
                drawCircle(tint, radius = s * 0.075f)
                drawLine(tint, Offset(s * 0.5f, s * 0.5f), Offset(s * 0.72f, s * 0.28f), sw, StrokeCap.Round)
            }
            1 -> {
                drawCircle(tint, radius = s * 0.13f, center = Offset(s * 0.24f, s * 0.28f), style = Stroke(width = sw))
                drawCircle(tint, radius = s * 0.13f, center = Offset(s * 0.76f, s * 0.28f), style = Stroke(width = sw))
                drawCircle(tint, radius = s * 0.13f, center = Offset(s * 0.5f, s * 0.76f), style = Stroke(width = sw))
                drawLine(tint, Offset(s * 0.36f, s * 0.28f), Offset(s * 0.64f, s * 0.28f), sw)
                drawLine(tint, Offset(s * 0.31f, s * 0.39f), Offset(s * 0.43f, s * 0.65f), sw)
                drawLine(tint, Offset(s * 0.69f, s * 0.39f), Offset(s * 0.57f, s * 0.65f), sw)
            }
            2 -> repeat(3) { i ->
                val y = s * (0.22f + i * 0.28f)
                drawCircle(tint, radius = s * 0.055f, center = Offset(s * 0.20f, y))
                drawLine(tint, Offset(s * 0.36f, y), Offset(s * 0.84f, y), sw, StrokeCap.Round)
            }
            3 -> {
                drawLine(tint, Offset(s * 0.10f, s * 0.86f), Offset(s * 0.90f, s * 0.86f), sw, StrokeCap.Round)
                listOf(0.30f, 0.55f, 0.42f, 0.72f).forEachIndexed { j, h ->
                    val x = s * (0.18f + j * 0.21f)
                    drawLine(tint, Offset(x, s * 0.84f), Offset(x, s * (0.84f - h)), s * 0.11f, StrokeCap.Round)
                }
            }
            4 -> {
                // 放大镜：圆环 + 斜柄，右下留白与其它图标一致
                drawCircle(tint, radius = s * 0.26f, center = Offset(s * 0.43f, s * 0.43f), style = Stroke(width = sw))
                drawLine(tint, Offset(s * 0.62f, s * 0.62f), Offset(s * 0.86f, s * 0.86f), sw * 1.2f, StrokeCap.Round)
            }
            else -> drawRoundRect(
                tint,
                topLeft = Offset(s * 0.24f, s * 0.24f),
                size = Size(s * 0.52f, s * 0.52f),
                cornerRadius = CornerRadius(s * 0.12f),
                style = Stroke(width = sw)
            )
        }
    }
}

/** 设置入口：三条带滑块的横线（仪器调参），比齿轮更容易辨认 */
@Composable
fun SettingsGlyph(tint: Color) {
    Canvas(Modifier.size(18.dp)) {
        val s = size.minDimension
        val sw = s * 0.075f
        listOf(0.26f, 0.5f, 0.74f).forEachIndexed { i, y ->
            drawLine(tint, Offset(s * 0.08f, s * y), Offset(s * 0.92f, s * y), sw, StrokeCap.Round)
            val x = when (i) { 0 -> 0.68f; 1 -> 0.32f; else -> 0.56f }
            drawCircle(tint, radius = s * 0.105f, center = Offset(s * x, s * y))
        }
    }
}
