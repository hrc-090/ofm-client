package com.ofm.client

import android.util.Log

/**
 * nodejs-mobile 的 libnode.so 只导出 C++ 符号 node::Start(int,char**)，
 * 官方的 NodeJS.java 桥接类并不随 npm 分发包提供，所以这里用自己写的
 * libofmnode.so（见 cpp/ofm_node.cpp）直接调 node::Start。
 */
object NativeNode {
    private const val TAG = "ofm-node"

    @Volatile
    private var loaded = false

    @Volatile
    var lastError: String? = null
        private set

    fun ensureLoaded(): Boolean {
        if (loaded) return true
        return try {
            // libnode.so 的 DT_NEEDED 里已经带了 libc++_shared.so，链接器会自动加载；
            // 这里显式载一次只是让失败信息更清楚，失败也不阻断（由 libnode 自己再解析）。
            runCatching { System.loadLibrary("c++_shared") }
            System.loadLibrary("node")
            System.loadLibrary("ofmnode")
            loaded = true
            true
        } catch (t: Throwable) {
            lastError = t.message ?: t.toString()
            Log.e(TAG, "加载原生库失败", t)
            false
        }
    }

    /** 阻塞调用；必须在独立线程执行。返回 node 进程退出码。 */
    external fun startNode(argv: Array<String>, workDir: String, dataDir: String): Int
}
