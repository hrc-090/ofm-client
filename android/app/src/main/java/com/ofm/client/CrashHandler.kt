package com.ofm.client

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 兜底崩溃记录：未捕获异常先落盘，再交给系统默认处理器。
 *
 * 之前「模型页一直下滑闪退」没有真机 logcat，只能靠静态推断。有了它，
 * 万一还有残留问题，用户能在「设置 → 最近一次崩溃」里直接把完整堆栈复制出来。
 * 只保留最近 5 份，纯本地文件，不上传、不含正文或凭据。
 */
object CrashHandler {
    private const val TAG = "OfmCrash"
    private const val MAX_KEEP = 5
    private var installed = false

    @Synchronized
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, fatal ->
            runCatching { write(app, thread, fatal) }
            previous?.uncaughtException(thread, fatal)
        }
    }

    private fun write(context: Context, thread: Thread, fatal: Throwable) {
        val dir = File(context.filesDir, "crash").apply { mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val stack = StringWriter().also { fatal.printStackTrace(PrintWriter(it)) }.toString()
        val text = buildString {
            append("time: ").append(Date()).append('\n')
            append("thread: ").append(thread.name).append('\n')
            append("device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
                .append(" / Android ").append(Build.VERSION.RELEASE).append('\n')
            append('\n').append(stack)
        }
        File(dir, "crash-$stamp.txt").writeText(text)
        dir.listFiles()
            ?.sortedByDescending { it.name }
            ?.drop(MAX_KEEP)
            ?.forEach { it.delete() }
        Log.e(TAG, text)
    }

    /** 最近一次崩溃全文；没有记录返回 null。 */
    fun latest(context: Context): String? = runCatching {
        File(context.filesDir, "crash").listFiles()
            ?.maxByOrNull { it.name }
            ?.readText()
            ?.takeIf { it.isNotBlank() }
    }.getOrNull()
}
