# OFM · 手机上的本机模型网关

> **下载安装包**：[Releases · v0.2.0](https://github.com/hrc-090/ofm-client/releases/latest) ·
> [源码仓库](https://github.com/hrc-090/ofm-client)

在 Android 手机上登录各家 AI 渠道账号，App 会在本机 `127.0.0.1:18900` 起一个 HTTP 服务，对外提供 **OpenAI / Anthropic 兼容接口**。手机上的 ChatBox、OpenAI SDK、Claude Code 之类客户端填一个地址和一个 Key，就能直接用这些账号的模型额度，不需要把凭据交给任何第三方服务器。

服务只监听回环地址，凭据只存在 App 私有目录，用量与日志全部留在本机。

> ⚠️ 这是 **debug 签名的 arm64-v8a 自用构建**（`minSdk 26 / targetSdk 34`，约 30 MB）。与旧版本签名冲突时请先卸载再装。渠道协议来自对官方桌面客户端的逆向实现，存在被判定为非官方客户端的风险，且随时可能变更——详见文末「已知限制与合规」。

---

## 快速开始

**1. 安装**

从 [Releases](https://github.com/hrc-090/ofm-client/releases/latest) 下载 `ofm-client-0.2.0-debug.apk`，允许「安装未知来源应用」后安装。附件里的 `SHA256SUMS.txt` 可校验完整性；`AP.apk` 是同一文件的历史文件名。

**2. 启动并登录**

打开 App，按引导授予**通知权限**并把应用加入**电池优化白名单**（否则息屏十几分钟后服务会被系统掐断），然后在「渠道」页点「连接」登录至少一个渠道。

登录默认走系统浏览器，回调地址是 `http://127.0.0.1:18080/authorize`。如果是在电脑浏览器完成的授权、或 App 切后台被回收导致页面报 `ERR_CONNECTION_REFUSED`，**授权其实已经成功**——复制地址栏整条链接，回 App 点「粘贴回调链接完成登录」即可，不用重来。

**3. 配置第三方客户端**

| 字段 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:18900/v1`（以 App 概览页显示的实际端口为准） |
| API Key | `ofm-local-key`（默认固定值，清数据 / 重装不变） |
| 模型 | 从模型列表选，形如 `trae/xxx` |

ChatBox、DSH、OpenAI SDK 填这三个就能用。装完先在 App「概览」页确认端口和 Key，再用 curl 验证：

```bash
curl -s http://127.0.0.1:18900/health
curl -s -H "Authorization: Bearer ofm-local-key" http://127.0.0.1:18900/v1/models
curl -N -H "Authorization: Bearer ofm-local-key" -H 'Content-Type: application/json' \
  -d '{"model":"mock/echo","stream":true,"messages":[{"role":"user","content":"你好"}]}' \
  http://127.0.0.1:18900/v1/chat/completions
```

`mock/echo` 是内置的本地回显渠道，不联网、不需要账号，专门用来验证链路是否通。

---

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 兼容接口 | `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/models`，流式与非流式、工具调用、思考档位透传 |
| 多渠道 | TRAE、Qoder / Qoder CN、Cline、LobsterAI、Loomy、Raccoon、MiniMax、ZCode，外加 **Kilo 免费池**（免账号）与 `mock` 本地回显；多账号选号、自动续期、失败换号 |
| 省 Token | RTK 压缩工具输出（git diff / 构建日志 / grep / ls / tree，默认开）；回答风格可选精简 / 极简 / 文言（默认关）；看板统计累计节省 |
| 签到积分 | 逐账号签到 / 领取、余额（剩余·共·已用）、自动签到与跨天巡检、按天分片的签到日志 |
| 用量看板 | 今日 / 7 天 / 30 天请求数、成功率、token、缓存命中、生成速度、按模型与渠道分布；只存统计不存正文 |
| 网页搜索 | `/v1/search`、`/v1/read`、`/mcp`，多源回退链，供第三方客户端直接调用 |
| 诊断 | 网络自检（DNS→TCP→TLS→HTTPS + 账号凭据体检）、对话自检、崩溃堆栈落盘与一键复制 |
| 后台保活 | 前台服务 + 电池白名单引导 + 厂商自启动入口 + 划掉任务不停服务 |
| 界面 | 「仪器台」设计，底栏五项：概览 / 渠道 / 模型 / 用量 / 搜索 |

「模型」页用分段切换「模型目录 / 签到积分」，可按渠道筛选、设默认思考档位；设置页在右上角齿轮，可改固定 Key、看后台保活状态、复制崩溃堆栈。

---

## 本机 API

### 鉴权

- 业务接口支持 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、`?key=`，常量时间比较。
- 默认 Key 固定为 `ofm-local-key`；可用环境变量 `OFM_API_KEY` 覆盖，或在 App 里改成自己的值（落盘）。改 Key 会同步写进 `runtime.json`。
- `/api/*` 管理接口额外要求 `x-ofm-ui-token`（进程内随机生成，防同机其它 App 读走 Key）。
- 只监听回环；端口被占用时会退到系统分配端口，并把实际端口写进 UI 与 `runtime.json`。
- CORS 预检放行任意请求头（官方 SDK 会带 `x-stainless-*`），SSE 首 token 期间每 15s 发心跳注释帧。

### 给第三方客户端用

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/`、`/health` | 存活探测，无需鉴权 |
| GET | `/v1/models`、`/models` | 模型目录，`provider/model` 形式 |
| POST | `/v1/chat/completions` | OpenAI Chat，流式 / 非流式 |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/messages/count_tokens` | 本地估算，不发上游 |
| POST/GET | `/v1/search` | 网页搜索（默认关闭） |
| POST/GET | `/v1/read` | 网页正文读取（默认关闭） |
| POST | `/mcp` | MCP JSON-RPC，工具 `web_search` / `web_read`（默认关闭） |

### 给 App 界面用（摘要）

| 路径 | 用途 |
| --- | --- |
| `GET /api/status`、`/api/models` | 状态、模型目录与诊断信息 |
| `POST /api/settings/key`、`/api/settings` | 固定 Key、模型默认思考档位 |
| `POST /api/login/browser-target`、`/api/login/complete`、`GET /api/login/poll` | 浏览器登录登记、粘贴兜底、轮询会话 |
| `POST /api/checkin/{capabilities,status,claim,balances,auto}` | 签到能力、状态、领取、余额、自动开关 |
| `GET /api/checkin/log`、`DELETE /api/checkin/log` | 签到日志（支持 `format=text` 排查报告） |
| `GET /api/usage/summary?days=1\|7\|30`、`/api/usage/log`、`DELETE /api/usage` | 用量聚合、明细、清空 |
| `GET /api/network/diagnose`、`POST /api/chat/diagnose` | 网络与账号体检、对话链路自检 |
| `GET /api/search/config` | 搜索配置（只回 Key 尾 4 位） |

完整路由见 `core/src/server.js`。

### 模型 id 的几个约定

- **`id` 恒为真实 `provider/model`，永不装饰**，它同时是路由键；渠道名只放在 `display_name`（形如 `[TRAE] Seed-Code`）。多数客户端把两者渲染成两行，两个字段都带渠道名就会出现重复和 ` :: ` 脏串。
- 客户端偶尔把 `display_name`、URL 编码过的 id、带引号的 id 当 `model` 回传，三个协议入口会统一归一化：解码、去引号、剥装饰前缀，只剩模型名时查目录且**唯一命中才还原**，歧义宁可报错也不猜渠道。
- 没有账号时 `/v1/models` 返回空列表是**正常的**，响应带 `hint` 说明原因；登录成功后会主动失效缓存并预热，不用手动刷新。
- 远端目录拉取失败时降级为静态兜底表（带 `fallback:true`）并附 `diagnostics`，界面会明确提示「当前是兜底目录」。兜底只保证列表不空，能否对话仍取决于凭据与网络。
- 缓存命中显示「—」表示**上游没上报**缓存用量，不是 0；命中率分母只算上报过的请求。

### 思考档位

**怎么读**：`/v1/models` 里每个模型同一份档位数据给三种形状，第三方按自己认识的字段取即可。

| 字段 | 形状 | 说明 |
| --- | --- | --- |
| `supported_reasoning_efforts` | `["low","medium","high"]` | 最省事的扁平值数组 |
| `default_reasoning_effort` | `"high"` | 只在目录明确声明且真在菜单里时才下发 |
| `reasoning.supported_efforts` / `.default_effort` | 对象 | OpenRouter / LiteLLM 形状 |
| `reasoning_options` | `[{value,label}]` | 带原始文案，App 用它渲染芯片（`Extra Light` 不会被改写） |
| `supported_parameters` | `["reasoning","reasoning_effort"]` | 有档位菜单时才出现 |

**怎么写**：`reasoning_effort`（OpenAI / Responses）、`reasoning.effort`（Responses 原生）、`thinking.budget_tokens`（Anthropic 形状，按预算换算 Light/Balanced/Deep）、`output_config.effort`（Anthropic 新版）、模型名尾部 `xxx(high)`，五种入口都认，显式字段 **优先**且原样透传；客户端没带时才用 App 模型页设的默认值。

下发前会做一次**软对齐**：`HIGH` → `high`（大小写不同不该变 400）、`deep` → 菜单里的 `max`（同义档位互认）；对不上就原样放行，不猜也不拦 —— 目录菜单可能不全，拦下来只会把能用的请求变成错误。

模型名尾部的 `(level)` 只在括号里是已知档位时才会被剥掉 —— `vendor/model (preview)` 这种名字保持原样。设置页还有一个**思考预算阶梯**开关（默认关）：模型目录没声明档位菜单时，把 `Light / Balanced / Deep` 换算成 `max_tokens` 预算（2048 / 8192 / 模型上限），思考不可关闭的模型翻倍；声明了档位菜单的模型永远原值下发，不会被替换。

### 失败返回真实状态码

流式响应头**延迟提交**：首帧正文到达前失败（鉴权、限流、上游 5xx、空回复），返回的是真实的 4xx/5xx + `retry-after`，而不是「200 + 一条错误帧」。超过 15 秒还没出正文时会先提交响应头并用 SSE 注释帧保活，避免长思考把客户端拖超时；一旦提交，失败就只能写在流里（这时才是 200）。

客户端中途断开时，`req.aborted` / `socket.close` / `res.close` 三路都会立刻取消上游请求，不会继续白烧额度。

### 省 Token

设置页「省 Token」卡片，默认只开第一项：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 压缩工具输出 | 开 | RTK 规则重写 `role:"tool"` / `tool_result` / `function_call_output` 的内容：长 diff 只留变更行、构建日志按重复折叠、`ls` / `tree` / `grep` 汇总成紧凑形状 |
| 回答风格 | 关 | `精简 / 极简 / 文言`，压缩**输出** token；代码、命令、报错、安全警告保持原样 |
| 思考预算阶梯 | 关 | 无档位模型把 `Light/Balanced/Deep` 换算成输出预算 |

边界很硬：**只动工具输出**，系统提示、用户消息、助手正文一律不碰；错误结果（`is_error`）不压，那是模型判断故障的唯一证据；替换结果必须严格更短才生效；任何一步失败都原样发送（fail-open）。累计节省的字节数记在用量看板「省 Token」一行，只存数字不存内容。

---

## 网页搜索

默认关闭，需在 App 底栏「搜索」页打开；关闭时三个出口都回 503。

| 出口 | 给谁用 | 返回 |
| --- | --- | --- |
| `/v1/search` | ChatBox 等「自定义搜索」 | `{provider, note, results:[{title,url,snippet}]}` |
| `/v1/read` | 同上「自定义读取」 | 正文纯文本 + `final_url`，长文截断 |
| `/mcp` | Claude Code / DSH 等 MCP 客户端 | JSON-RPC 2.0，`web_search` / `web_read`，无状态 |

**第三方设置页该填什么**（App 搜索页可一键复制）：

```text
接口地址   http://127.0.0.1:18900/v1/search
API Key    ofm-local-key
请求方式   POST
请求模板   {"query":"{{query_json}}","count":{{count}}}
响应字段   results / title / url / snippet
请求头     Authorization: Bearer ofm-local-key
```

读取侧填 `/v1/read`，模板 `{"url":"{{raw_url}}"}`、字段 `text` / `title`；MCP 客户端填 `http://127.0.0.1:18900/mcp`。

> App 里**没有**「自定义搜索 / 自定义读取」输入框——那两个框属于第三方客户端自己的设置页，在自家 App 里再做一份只会诱导用户把地址填成自己，造成自环。搜索页只做三件事：开关、字段对照、试搜试读。

回退链 `custom → bing → keenable → exa → parallel → anysearch`，`note` 会写明「谁挂了、现在用的是谁」。安全边界：搜索结果一律视为不可信外部内容（MCP 返回包 `<untrusted-web-content>`）、`/v1/read` 拒私网 / 回环 / 云元数据、30s 预算、按源冷却、LRU 缓存；自定义 Key 单独存 `0600` 文件，日志只记 query 前 60 字与失败类。

---

## 渠道支持

| 渠道 | 登录 | 推理协议 | 签到 | 关键实现点 |
| --- | --- | --- | --- | --- |
| TRAE | 本地回调（18 参数） | 自定义 SSE | ✅ | `auth_callback_url` 参数名不可改；`tools.parameters` 需序列化；末帧补处理 |
| Qoder / Qoder CN | 设备码 + PKCE | WASM 加密 | ✅ | `business` 必填；两套返回值布局；设备头在 Android 上可选手工配置 |
| Cline | WorkOS 设备码 | OpenAI | ❌ | `access_token` 保留 `workos:` 前缀；`slow_down` 真退避 |
| LobsterAI | 本地回调 + authCode | OpenAI | ✅ | 目录必须带 `X-LobsterAI-Client-Capabilities` |
| Loomy | 短信验证码 | OpenAI | ✅ | HMAC-SHA1 九段签名且必须真发 `Content-MD5` 头；聊天要带 `traceparent` |
| Raccoon | 网页登录 + Cookie 导入 | OpenAI | 一次性奖励 | 官方扫码页 `/login/mp` 已 404，改走本机 `/raccoon/login` → 官网 `/login`，登录后从 WebView Cookie 取 `xhx_token` / `raccoon_token` 并用模型目录验活；思考开关放 `extra_body` |
| MiniMax | 设备码 + PKCE | Anthropic | ✅ | 目录是字典不是数组；pending 可能是 `200 + status:"pending"` |
| ZCode | 设备授权 | Anthropic | 手动（需 captcha） | `device_mid` 必须持久化；Android 上不伪造领取成功 |
| Kilo 免费池 | 无需登录 | OpenAI | — | 只广播 `isFree` 模型；`kilo-auto/free` 是清单失败时的兜底；**免费池 prompt 可能被上游记录，勿贴敏感内容** |
| `mock` | 无 | 本地回显 | — | 不联网，按字素簇切帧，验收与调试用 |

通用约定：token 剩余不足 60s 静默续期；传输失败不判终态；只有 401/403 加明确 auth 码才标记「需重新登录」；无账号的渠道返回空模型列表而不是抛错。

签到按 `token` / `积分` 分桶统计，**绝不跨单位相加**；`null`（查不到）与 `0`（用光）严格区分。自动签到启动延迟 30s、跨天巡检 2.5h、失败退避 ≥1h，只有真正覆盖今天的轮次才写 `lastDate`，断网或凭据没续上时不记，下次会重试。

---

## 开发

### 目录

```
core/                        Node 运行时（桌面可直接跑，Android 复用）
  main.js                    入口：读配置 → 起 server → 写 runtime.json
  src/
    server.js                本机 API 路由 / 鉴权 / SSE 渲染
    dispatch.js              选号、续期、失败换号；模型目录去重与字段截断
    convert/                 OpenAI / Anthropic / Responses 三协议互转
    channels/                trae / qoder / cline / lobsterai / loomy /
                             raccoon / minimax / zcode / kilo / mock
    token-saver/             RTK 压缩器（12 个 filter）与提示词瘦身
    effort.js                思考档位入口解析与输出预算阶梯
    tool-wire.js             工具调用 index 重排、decoy 抑制、参数挂起
    deferred-response.js     延迟提交 SSE 响应头（失败返回真实状态码）
    credits/                 签到与积分，含九个 provider 与 auto-checkin.js
    usage-store.js           用量日志（按天分片 JSONL，只存统计）
    usage-cache.js           六种上游缓存 token 命名统一归一化
    checkin-log.js           签到日志（按天分片、脱敏、纯文本报告）
    model-label.js           model id 展示与脏输入反解
    reasoning-options.js     思考档位归一化
    net-diagnose.js          DNS / TCP / TLS / HTTPS 分层自检
    credential-repair.js     存量凭据缺字段自愈
  test/*.mjs                25 套纯 mock 回归
  cacert.pem                Mozilla CA bundle（随 assets 进 APK）
android/                    Kotlin + Compose + 自建 JNI 桥
  app/src/main/cpp/          JNI：String[] → char**，chdir + setenv，调 node::Start
  app/src/main/java/com/ofm/client/
    ApiService.kt            前台服务，node 跑在独立线程
    MainActivity.kt          状态与业务逻辑、顶栏与底栏导航
    Screens.kt / Theme.kt    五个页面与设计系统
    CrashHandler.kt          未捕获异常落盘，最近 5 份
  app/src/main/jniLibs/      libnode.so + libofmnode.so + libc++_shared.so
tools/                      sync-assets / fetch-libnode / build-native
design/                     图标源文件与可交互 UI 预览（M35-ui-preview.html）
```

### 在电脑上跑

`core/` 是完整可独立运行的 Node 服务（需 Node ≥ 18）：

```bash
cd core
node main.js                 # 监听 127.0.0.1:18900
# 数据目录默认 ~/.our-free-model，runtime.json 里有实际端口、Key、uiToken
for f in test/*.mjs; do node "$f"; done     # 25 套回归
```

### Android 构建

| 项 | 要求 |
| --- | --- |
| JDK | 17（AGP 8.5 要求，21/20 会报 unsupported class file） |
| Android SDK | platform 34 + build-tools 34.0.0 |
| NDK | 26.1.10909125（只用于编译 JNI 桥） |
| Gradle | 8.7（仓库自带 `gradlew`，distributionUrl 用华为云镜像） |
| `libnode.so` | nodejs-mobile 18.20.4 |

```bash
node tools/fetch-libnode.mjs arm64-v8a                       # 1) 从 npm 包取预编译 libnode.so
ANDROID_NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125 ./tools/build-native.sh   # 2) 编译 JNI 桥
node tools/sync-assets.mjs                                  # 3) 同步 core → assets（改 JS 必跑）
cd android && ./gradlew assembleDebug                       # 4) 打包
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

两个绕不开的坑（本仓库已解决）：`com.janeasystems:nodejs-mobile-gradle` 只发布在已关闭的 JCenter，插件已删除；`libnode.so` 只导出 C++ 符号没有 Java 桥，所以自己写了 JNI 层，且必须把 `libc++_shared.so` 一起打进 APK（Android 系统不提供，漏了会在 `dlopen` 阶段失败）。

`sync-assets.mjs` 会把所有 JS 文件内容算成 SHA256 指纹写进 `version.txt`，Kotlin 端比对后自动重解包 assets——覆盖安装不会出现「新 UI 配旧 Node」，也不用清数据丢账号。

运行时：`ApiService` 前台服务拷贝 assets → `NativeNode.startNode` → 监控 `runtime.json`；`LoginWebViewActivity` 承载授权页并拦 18080 回调；设备码类渠道直接开浏览器 + App 内轮询。

### 测试

25 套纯 mock 回归、共 **1671 项断言**，不依赖账号与外网，覆盖协议互转、登录回调、模型目录、SSE 分帧与流式稳定性、工具调用、签到与日志、用量与缓存命中、网页搜索与 MCP、Kilo 免费池、延迟响应头、工具线缆 decoy 过滤、思考档位与预算阶梯、Raccoon Cookie 登录、省 Token 压缩。每次改 `core/` 后跑一遍再同步 assets。

---

## 排障速查

| 现象 | 先看哪里 | 处理 |
| --- | --- | --- |
| 第三方 401 | 概览页的 Key | 用默认 `ofm-local-key`；手动改过 Key 就把客户端一起改 |
| 模型列表为空 | 是否已登录账号 | 连一个渠道；列表会自动预热，不用手动刷新 |
| 提示「兜底目录」 | 模型页诊断条 | 点「重新拉取」；诊断是 401 就重新登录 |
| 拉取失败 + 余额失败同时出现 | 出站 HTTPS | 多半是同一条链路，用「网络自检」按 DNS→TCP→TLS→HTTPS 定位 |
| 自检全通过却仍不行 | 报告的 `accounts` 段 | 没账号→连渠道；`incomplete` 缺设备标识→自检会自动补齐；401→重新登录 |
| 发消息一片空白 | 「对话自检」 | `EMPTY_REPLY` 看上游帧样本；链路正常就查客户端 base URL / stream 设置 |
| 登录回调打不开 | 浏览器地址栏 | 授权已成功，复制整条链接用「粘贴回调链接完成登录」 |
| 息屏后服务失联 | 设置页「后台保活」 | 电池白名单 + 通知权限 + 厂商自启动，三项都要手动授予 |
| 缓存命中显示「—」 | 用量页 | 上游未上报缓存用量，属正常；不是统计坏了 |
| 模型页下滑闪退 | 设置页「最近一次崩溃」 | 已修；若复发，一键复制完整堆栈发开发者 |
| 签到「今天为什么没领到」 | 模型页 → 签到积分 → 签到日志 | 日志逐渠道记触发 / 跳过 / 失败原因，可复制脱敏报告 |

<details>
<summary>实现笔记（十二条，给二次开发者）</summary>

1. **`id` 承担路由、`display_name` 承担展示**，永远别为了「让只读 id 的客户端看见渠道名」去污染路由键；早期 ` :: ` 装饰通道已整个删除。
2. **SSE 分帧必须用同一 chunk 里的多帧数据测**。两处踩过同一个坑：`findEventBoundary()` 返回 `{start,end}` 对象却拿去和数字比较，`NaN` 恒 false，循环一次都不执行；单帧测试恰好测不出来。
3. **自己拼 HTTP 头就要自己实现 fetch 的语义**：内嵌 Node 没有 fetch，不解压 `gzip / deflate / br` 会出现「同一渠道签到正常、余额报非 JSON」；网关漏发头时按 `1f 8b` 魔数嗅探。
4. **上游 usage 缓存字段有六种命名**（`cached_tokens` / `cache_read_input_tokens` / `prompt_cache_hit_tokens` 等），统一收口；**未上报 ≠ 0**，命中率分母只算上报过的请求。
5. **token 与积分分桶，`null` 与 `0` 严格区分**，任何汇总都不跨单位相加；`rate: 0` 是合法倍率（免费模型），别用 `> 0` 过滤。
6. **模型目录要按 id 去重、过滤无 id 脏条目、截断展示字段**，否则 Compose `LazyColumn` 的重复 key 与超长 `Text` 会在长列表滚动时炸掉。
7. **凭据缺字段优先本地自愈**：`machine_id` / `device_id` 是客户端自造的 hex32，可按 uid 确定性派生补回，不用让用户重登；`uid` 本身缺失就如实报错，不编造。
8. **Android 的 `network_security_config` 只管 Java 层**，内嵌 Node 用自己的 OpenSSL、读不到系统 CA；必须把 `cacert.pem` 打进 assets 并与 `tls.rootCertificates` 合并后显式传 `ca`。
9. **18080 回调只监听回环**，在电脑浏览器完成授权时必然连不上，但链接里已带凭据，粘贴回来即可换 token；`parseCallbackQuery` 不校验 host，日志与错误响应都不打印链接内容。
10. **搜索结果是不可信外部内容**，MCP 返回包 `<untrusted-web-content>`；`/v1/read` 拦私网与云元数据，指向本机的 custom 引擎会自动从回退链摘掉，避免自环。
11. **流式错误要同时下发结构化错误帧和 assistant 正文**，只写裸 `data: {"error":…}` 时严格解析 `choices[0].delta` 的 SDK 会整帧忽略，用户只看到空白。
12. **日志一律脱敏**：不落请求 / 响应正文、不打印 token 与 refreshToken，账号只留「渠道#尾 4 位」，错误文案带 content-type 与前 60 字样本便于定位。

</details>

---

## 已知限制与合规

- **调试版已在真机使用**，并据此修过多轮真机问题（流式断流、模型页闪退等）；但九个账号渠道**没有逐一完成真实账号的完整对话联调**，自动化测试全是纯 mock。公开接口（MiniMax 目录、Loomy 短信登录、搜索回退链）做过真实网络实测。第一次联调请按「登录 → 拉模型 → 一句话对话 → 工具调用」直线走，别叠功能。
- **Kilo 免费池不需要账号，但免费不等于私密**：网关在自己的模型卡上写明免费池的 prompt 可能被记录并用于改进服务，只适合一次性任务。
- 省 Token 是**启发式压缩**：规则不认识的内容原样发送，规则认识但压缩后仍可能丢细节（例如 diff 只保留变更行）。担心上下文被改写时，在设置页关掉即可。
- 待办：全渠道真机联调、Qoder 的 `business` 与 uid 验证、设备码与本地回调两种登录各跑一遍、后台存活的 `AlarmManager` 兜底。
- 这些渠道是**逆向官方桌面 / IDE 客户端的私有协议再实现**，账号侧存在被判定为非官方客户端的风险，协议随时可能变更；协议常量截止 2026-10。
- 上游 `channel-pack` 为 MIT，保留其版权与 NOTICE；本仓库的 Qoder WASM 桥、RTK 压缩器与提示词库是移植实现，文件头已注明来源。本仓库本身未声明独立许可证。
- 凭据只存 App 私有目录（`0600`），日志脱敏，不上传任何服务器；不提供绕过付费 / 额度的能力，只复用用户自己账号已有的免费额度；不要冒用各渠道商标与图标。

---

**版本**：v0.2.0。

- **v0.2.0**：修复 Raccoon 登录 —— 官方扫码落地页 `xiaohuanxiong.com/login/mp` 已 404（本地拼的 `code` 官网本就不认），改为本机 `http://127.0.0.1:18900/raccoon/login` 过渡页跳官网 `/login`，WebView 登录后用 `xhx_token` / `raccoon_token` 调模型目录验活才落库；第三方客户端可以从 `/v1/models` 读、用五种请求字段设思考强度（Anthropic `thinking.budget_tokens` 不再写死 `high`）。
- **v0.1.0**：Kilo 免费池、失败真实状态码、工具线缆、响应体嗅探、思考档位与预算阶梯、省 Token、用量看板重做；设计预览见 `design/M35-ui-preview.html`。
