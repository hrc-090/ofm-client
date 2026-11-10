package com.ofm.client

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * 后台保活相关的系统设置入口。
 *
 * 前台服务只是「声明我想一直跑」，真正决定生死的是三件事：
 *  1. **电池优化白名单**（Doze / 应用待机）—— 不加白名单，息屏几十分钟后网络就被掐，
 *     第三方这时候调 /v1/search 表现成超时，用户看到的是「服务挂了」；
 *  2. **通知权限**（Android 13+）—— 没有通知权限，前台服务的通知不显示，
 *     系统会把服务降级成普通后台服务，随手就被清掉；
 *  3. **厂商自启动/后台限制**（小米/华为/OPPO/vivo…）—— 各家自己一套，只能引导用户去点。
 *
 * 这里只做「检测 + 跳转」，不替用户点：这类权限没有 API 能静默授予，
 * 装作能「一键优化」只会让用户以为已经好了。
 */
object KeepAlive {

    /** 电池优化是否已忽略（= 已加入白名单） */
    fun isIgnoringBattery(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * 拉起系统的「忽略电池优化」确认框。
     * 部分 ROM 把这个对话框藏了，退化成打开应用详情页，用户仍能手动找到。
     */
    fun requestIgnoreBattery(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${activity.packageName}")
            }
            activity.startActivity(intent)
            return
        } catch (_: Exception) {
            // 落到下面的兜底
        }
        openAppDetail(activity)
    }

    /** 通知权限（Android 13+ 需要运行时授予） */
    fun hasNotificationPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 33) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    fun openNotificationSettings(context: Context) {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { context.startActivity(intent) }.onFailure { openAppDetail(context) }
    }

    fun openAppDetail(context: Context) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { context.startActivity(intent) }
    }

    /** 厂商的后台/自启动管理页；找不到就退到应用详情页 */
    fun openAutoStart(context: Context) {
        val candidates = when {
            Build.MANUFACTURER.equals("Xiaomi", true) -> listOf(
                ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
            )
            Build.MANUFACTURER.equals("Huawei", true) || Build.MANUFACTURER.equals("HONOR", true) -> listOf(
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")
            )
            Build.MANUFACTURER.equals("OPPO", true) || Build.MANUFACTURER.equals("realme", true) -> listOf(
                ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity")
            )
            Build.MANUFACTURER.equals("vivo", true) || Build.MANUFACTURER.equals("iQOO", true) -> listOf(
                ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")
            )
            Build.MANUFACTURER.equals("samsung", true) -> listOf(
                ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity")
            )
            Build.MANUFACTURER.equals("Meizu", true) -> listOf(
                ComponentName("com.meizu.safe", "com.meizu.safe.permission.SmartBGActivity")
            )
            else -> emptyList()
        }
        for (c in candidates) {
            val intent = Intent().apply {
                component = c
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            if (context.packageManager.resolveActivity(intent, 0) != null) {
                if (runCatching { context.startActivity(intent) }.isSuccess) return
            }
        }
        openAppDetail(context)
    }

    /** 厂商名，界面上用来显示「小米需要单独开自启动」这类提示 */
    fun vendorLabel(): String = Build.MANUFACTURER?.replaceFirstChar { it.uppercase() } ?: "Android"

    data class Status(
        val batteryOk: Boolean,
        val notificationOk: Boolean,
        val foregroundRunning: Boolean
    ) {
        /** 还差几项就全绿 */
        val allOk: Boolean get() = batteryOk && notificationOk && foregroundRunning
    }

    fun status(context: Context): Status = Status(
        batteryOk = isIgnoringBattery(context),
        notificationOk = hasNotificationPermission(context),
        foregroundRunning = ApiService.running
    )
}
