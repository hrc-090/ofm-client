#!/usr/bin/env bash
# 编译 JNI 桥接层 libofmnode.so。
#
# 背景：nodejs-mobile 的 Gradle 插件（com.janeasystems:nodejs-mobile-gradle）
# 随 JCenter 关站已无法获取，官方也只分发 libnode.so（导出 C++ 符号
# node::Start），不含 Java 桥接类。因此这里自己写一个 JNI 层。
#
# 前置：
#   ANDROID_NDK_HOME 指向 NDK（>= 25），或改下面的默认值
#   app/src/main/jniLibs/arm64-v8a/libnode.so 已存在（tools/fetch-libnode.mjs 生成）
set -euo pipefail

NDK="${ANDROID_NDK_HOME:-/opt/android-sdk/ndk/26.1.10909125}"
API=26
ABI=arm64-v8a
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JNI="$ROOT/android/app/src/main/jniLibs/$ABI"
SRC="$ROOT/android/app/src/main/cpp/ofm_node.cpp"
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"

[ -f "$JNI/libnode.so" ] || { echo "缺少 $JNI/libnode.so，先跑 node tools/fetch-libnode.mjs"; exit 1; }

# libnode.so 的 NEEDED 里有 libc++_shared.so，必须一起进包
cp "$TC/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" "$JNI/"

"$TC/bin/aarch64-linux-android${API}-clang++" \
  -shared -fPIC -O2 -std=c++17 \
  -o "$JNI/libofmnode.so" \
  "$SRC" "$JNI/libnode.so" \
  -Wl,-soname,libofmnode.so -Wl,--no-undefined -llog

echo "OK -> $JNI/libofmnode.so"
"$TC/bin/llvm-readelf" -d "$JNI/libofmnode.so" | grep -E "NEEDED|SONAME"
