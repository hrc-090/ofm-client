#include <jni.h>
#include <android/log.h>
#include <unistd.h>
#include <cstdlib>
#include <string>
#include <vector>

#define LOG_TAG "ofm-node"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// libnode.so 导出的是 C++ 符号 _ZN4node5StartEiPPc，这里用相同的
// C++ 链接名声明，交给链接器解析。
namespace node {
int Start(int argc, char* argv[]);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_ofm_client_NativeNode_startNode(JNIEnv* env, jclass clazz, jobjectArray args,
                                         jstring workDir, jstring dataDir) {
    if (args == nullptr) {
        LOGE("argv is null");
        return -1;
    }
    const jsize argc = env->GetArrayLength(args);
    if (argc == 0) {
        LOGE("argv is empty");
        return -1;
    }

    // node 的 cwd 决定 main.js 相对路径、require 解析与默认数据目录
    if (workDir != nullptr) {
        const char* wd = env->GetStringUTFChars(workDir, nullptr);
        if (wd) {
            if (chdir(wd) == 0) {
                LOGI("chdir -> %s", wd);
            } else {
                LOGE("chdir failed: %s", wd);
            }
            env->ReleaseStringUTFChars(workDir, wd);
        }
    }
    if (dataDir != nullptr) {
        const char* dd = env->GetStringUTFChars(dataDir, nullptr);
        if (dd) {
            setenv("OFM_DATA_DIR", dd, 1);
            LOGI("OFM_DATA_DIR=%s", dd);
            env->ReleaseStringUTFChars(dataDir, dd);
        }
    }
    // nodejs-mobile 需要这些环境变量才能正确解析内建模块与临时文件
    setenv("NODE_PATH", "/data/local/tmp", 0);

    // 先把所有 jstring 拷成 std::string，保证指针在整个 Start 期间有效
    std::vector<std::string> store;
    store.reserve(static_cast<size_t>(argc));
    for (jsize i = 0; i < argc; ++i) {
        auto js = static_cast<jstring>(env->GetObjectArrayElement(args, i));
        if (js == nullptr) {
            store.emplace_back("");
            continue;
        }
        const char* utf = env->GetStringUTFChars(js, nullptr);
        store.emplace_back(utf ? utf : "");
        if (utf) env->ReleaseStringUTFChars(js, utf);
        env->DeleteLocalRef(js);
    }

    std::vector<char*> argv;
    argv.reserve(store.size() + 1);
    for (auto& s : store) argv.push_back(const_cast<char*>(s.c_str()));
    argv.push_back(nullptr);

    LOGI("node::Start(argc=%d, argv[0]=%s, argv[1]=%s)", argc,
         argv.size() > 0 ? argv[0] : "", argc > 1 ? argv[1] : "");
    int code = node::Start(argc, argv.data());
    LOGI("node::Start returned %d", code);
    return code;
}
