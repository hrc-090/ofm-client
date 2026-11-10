package com.ofm.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.Process
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File

/**
 * 前台服务：持有 Node 运行时 + 本机 127.0.0.1 HTTP 服务。
 *
 * 二次启动的三条铁律（都是踩过的坑）：
 *  1. 判断 node 是否还活着要用 thread.isAlive，不能用 thread == null ——
 *     线程跑完了引用还在，会导致「服务显示运行中，端口其实没人监听」。
 *  2. 启动时必须删掉上次的 runtime.json 并清空 companion 里的端口/uiToken ——
 *     uiToken 每次 createApp 都重新随机，残留文件会让界面拿旧值请求旧端口。
 *  3. Node/V8 在同一进程里只能初始化一次。node 线程一旦退出就杀掉整个进程，
 *     并把 START_NOT_STICKY 用上，避免系统半吊子重启 Service 造成中间态；
 *     下次用户打开必然是干净进程，node 能重新初始化。
 */
class ApiService : Service() {

    companion object {
        private const val TAG = "ofm-service"
        private const val PREFS = "ofm_state"
        private const val CHANNEL_ID = "ofm_api"
        private const val NOTIFICATION_ID = 18900
        // 被系统杀后台后自动重建的次数上限：10 分钟内最多 3 次。
        // 不设上限的话，node 崩溃会变成「重建 → 崩 → 再重建」的死循环，用户只看到发热。
        private const val RESTART_WINDOW_MS = 10 * 60 * 1000L
        private const val MAX_RESTARTS = 3

        @Volatile var running = false
        @Volatile var port = 0
        @Volatile var apiKey = ""
        @Volatile var uiToken = ""
        @Volatile var lastError: String? = null

        /** 进程内标记：node::Start 只能调用一次 */
        @Volatile private var nodeStartedOnce = false

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, ApiService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ApiService::class.java))
        }

        val baseUrl: String
            get() = "http://127.0.0.1:${if (port > 0) port else 18900}"

        /** 上次退出的原因，跨进程重启后仍可读到 */
        fun readLastError(context: Context): String? =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("lastError", null)

        fun clearLastError(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("lastError").apply()
        }

        /** 系统重建（intent == null）时记一次预算，超了就放弃自动恢复 */
        private fun allowRestart(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val now = System.currentTimeMillis()
            val stamps = (prefs.getString("restartStamps", "") ?: "")
                .split(',')
                .mapNotNull { it.toLongOrNull() }
                .filter { now - it < RESTART_WINDOW_MS }
            if (stamps.size >= MAX_RESTARTS) return false
            prefs.edit().putString("restartStamps", (stamps + now).joinToString(",")).apply()
            return true
        }

        private fun Context.saveLastError(msg: String?) {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("lastError", msg ?: "")
                .apply()
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var nodeThread: Thread? = null
    private var monitorThread: Thread? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "onCreate pid=${Process.myPid()}")
        createChannel()
        startForegroundCompat("正在启动 Node 运行时…")
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val alive = nodeThread?.isAlive == true
        Log.i(TAG, "onStartCommand alive=$alive startedOnce=$nodeStartedOnce port=$port rebuild=${intent == null}")

        if (alive) return START_STICKY

        // intent == null 表示这是系统按 START_STICKY 重建的（用户没点开 App）。
        // 连续重建多次说明 node 起不来，继续拉只会空转，直接停。
        if (intent == null && !allowRestart(this)) {
            Log.w(TAG, "短时间内重建次数过多，停止自动恢复")
            saveLastError("服务多次异常重启，已停止自动恢复。请打开 App 手动启动。")
            updateNotification("服务多次异常重启，已停止自动恢复，请打开 App")
            stopSelf()
            return START_NOT_STICKY
        }

        if (nodeStartedOnce) {
            // 进程还活着但 node 已经退出：V8 不能二次初始化。
            // 干净地结束整个进程，用户下次打开就是全新进程。
            val why = "Node 运行时已退出，请重新打开 App（上次的错误：${lastError ?: "无"}）"
            Log.w(TAG, why)
            saveLastError(why)
            updateNotification("服务已停止，请重新打开 App")
            stopSelf()
            Thread({
                Thread.sleep(200)
                Process.killProcess(Process.myPid())
            }, "ofm-exit").start()
            return START_NOT_STICKY
        }

        nodeStartedOnce = true
        running = true
        lastError = null
        clearLastError(this)

        // 关键：先清掉上次遗留的 runtime.json，再清 companion 状态，最后才起监控线程。
        // 否则 monitor 会立刻读到旧文件，把界面指到旧端口 / 旧 uiToken。
        NodeRuntime.clearRuntime(this)
        port = 0
        apiKey = ""
        uiToken = ""

        NodeRuntime.ensureProject(this)
        monitorRuntime()

        nodeThread = Thread({
            Log.i(TAG, "node thread started")
            val ok = NodeRuntime.startNode(this@ApiService, "main.js")
            running = false
            if (!ok) {
                lastError = NodeRuntime.lastStartError ?: "Node 运行时启动失败"
                Log.e(TAG, "node 启动失败：$lastError")
                saveLastError(lastError)
                updateNotification("启动失败：$lastError")
            } else {
                Log.w(TAG, "node::Start 正常返回（服务已停止）")
                saveLastError("Node 运行时正常退出，服务已停止")
            }
            // 无论成功失败，node 已经不在监听。杀掉进程，保证下次是干净的一次初始化。
            Thread.sleep(250)
            Process.killProcess(Process.myPid())
        }, "ofm-node").also { it.start() }

        return START_STICKY
    }

    /**
     * 用户从最近任务划掉 App。
     *
     * 默认行为是连服务一起结束——但这里服务是给第三方客户端用的，
     * 划掉界面不该让别人的搜索断掉，所以什么都不做，只把通知刷一下。
     * （要真停服务，走设置页的「停止服务」。）
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(TAG, "onTaskRemoved：界面被划掉，服务继续运行")
        updateNotification(if (port > 0) "已就绪 · 127.0.0.1:$port（界面已关闭）" else "正在后台运行")
        super.onTaskRemoved(rootIntent)
    }

    /** runtime.json 里带实际端口与 Key，App 界面要读它 */
    private fun monitorRuntime() {
        if (monitorThread?.isAlive == true) return
        monitorThread = Thread({
            var signature = ""
            while (running) {
                val json: JSONObject? = NodeRuntime.readRuntime(this)
                if (json != null) {
                    val p = json.optInt("port", 0)
                    if (p > 0) {
                        // 每次都刷新全部字段：uiToken 每次启动都会变，
                        // 只在端口变化时更新会导致二次启动后所有 /api/* 401。
                        port = p
                        apiKey = json.optString("key")
                        uiToken = json.optString("uiToken")
                        val sig = "$p|${json.optLong("startedAt")}|$uiToken"
                        if (sig != signature) {
                            signature = sig
                            Log.i(TAG, "runtime ready port=$p")
                            updateNotification("已就绪 · 127.0.0.1:$p")
                        }
                    }
                }
                Thread.sleep(800)
            }
            Log.i(TAG, "monitor thread exit")
        }, "ofm-monitor").also { it.start() }
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ofm:api").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW)
            channel.setShowBadge(false)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        }
    }

    /** Android 14 起 startForeground 必须带类型；不带会抛 MissingForegroundServiceTypeException */
    private fun startForegroundCompat(text: String) {
        val n = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun buildNotification(text: String): Notification {
        val pending = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setContentIntent(pending)
            // 让通知在服务启动后立刻出现，而不是等系统合并（合并期间服务容易被判定为可清理）
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    override fun onDestroy() {
        Log.i(TAG, "onDestroy")
        running = false
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** 供界面显示数据目录用 */
    fun dataDir(): File = File(filesDir, "data")
}
