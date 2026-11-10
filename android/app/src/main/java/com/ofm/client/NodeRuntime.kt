package com.ofm.client

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * 资产拷贝 + runtime.json 读取。
 *
 * nodejs-mobile 的 Node 进程 cwd 是 App 的 files 目录，且 APK 里的 assets 不是
 * 真实文件系统，所以启动前必须把 nodejs-project 整个复制到 filesDir。
 */
object NodeRuntime {
    private const val TAG = "ofm-node"
    private const val ASSET_DIR = "nodejs-project"
    private const val MARKER = "version.txt"
    /** assets 里没有 version.txt 时的兜底（老版本兼容） */
    private const val FALLBACK_VERSION = "0.1.0"

    /** 读 APK 内置的内容指纹。JS 一变这个值就变，覆盖安装才会重新解包。 */
    private fun assetVersion(context: Context): String = try {
        context.assets.open("$ASSET_DIR/$MARKER").bufferedReader().use { it.readText().trim() }
    } catch (e: Exception) {
        FALLBACK_VERSION
    }

    @Volatile
    var lastStartError: String? = null
        private set

    /** nodejs-mobile 的 cwd 就是 filesDir，main.js 必须落在这一层 */
    fun projectDir(context: Context): File = context.filesDir

    /** 把 assets/nodejs-project 复制到 filesDir（内容指纹变了或文件不全才重新复制） */
    fun ensureProject(context: Context): File {
        val dest = projectDir(context)
        val expected = assetVersion(context)
        val marker = File(dest, MARKER)
        val current = runCatching { marker.readText().trim() }.getOrDefault("")
        val complete = current == expected &&
            File(dest, "main.js").isFile && File(dest, "src/server.js").isFile
        if (complete) {
            Log.i(TAG, "assets 已是最新（$expected），跳过复制")
            return dest
        }

        // 注意：dest 就是 filesDir，绝不能 deleteRecursively —— 会把 data/ 一起删掉
        Log.i(TAG, "assets 版本 '$current' -> '$expected'，重新复制")
        dest.mkdirs()
        copyAssetFolder(context, ASSET_DIR, dest)
        marker.writeText(expected)
        return dest
    }

    /**
     * 启动时清掉上次遗留的 runtime.json。
     * 它含有上次进程的端口与 uiToken，而 uiToken 每次 createApp 都重新随机；
     * 不删的话界面会在新 node 起来之前就按旧端口/旧 token 发请求 → 连接被拒。
     */
    fun clearRuntime(context: Context) {
        for (f in runtimeCandidates(context)) {
            if (f.exists() && !f.delete()) Log.w(TAG, "无法删除 ${f.absolutePath}")
        }
    }

    private fun runtimeCandidates(context: Context): List<File> = listOf(
        File(projectDir(context), "data/runtime.json"),
        File(context.filesDir, "data/runtime.json"),
        File(context.filesDir, "runtime.json")
    )

    private fun copyAssetFolder(context: Context, from: String, to: File) {
        val assets = context.assets
        val children = assets.list(from) ?: emptyArray()
        if (children.isEmpty()) {
            copyAssetFile(context, from, to)
            return
        }
        to.mkdirs()
        for (name in children) {
            copyAssetFolder(context, "$from/$name", File(to, name))
        }
    }

    private fun copyAssetFile(context: Context, from: String, to: File) {
        to.parentFile?.mkdirs()
        context.assets.open(from).use { input ->
            FileOutputStream(to).use { output -> input.copyTo(output) }
        }
    }

    /** runtime.json 由 main.js 启动成功后写入（含实际端口 / Key / uiToken） */
    fun readRuntime(context: Context): JSONObject? {
        for (f in runtimeCandidates(context)) {
            if (!f.exists()) continue
            runCatching { return JSONObject(f.readText()) }
        }
        return null
    }

    /** 阻塞执行 node::Start，直到 node 进程退出。必须放在独立线程里调用。 */
    fun startNode(context: Context, script: String): Boolean {
        if (!NativeNode.ensureLoaded()) {
            lastStartError = NativeNode.lastError ?: "原生库加载失败"
            return false
        }
        val dir = projectDir(context)
        val dataDir = File(dir, "data")
        dataDir.mkdirs()
        val scriptFile = File(dir, script)
        if (!scriptFile.exists()) {
            lastStartError = "脚本不存在：${scriptFile.absolutePath}"
            return false
        }
        return try {
            val code = NativeNode.startNode(
                arrayOf("node", scriptFile.absolutePath),
                dir.absolutePath,
                dataDir.absolutePath
            )
            if (code != 0) lastStartError = "node 退出码 $code"
            code == 0
        } catch (t: Throwable) {
            lastStartError = t.message ?: t.toString()
            false
        }
    }
}
