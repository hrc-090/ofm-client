# OFM 安卓客户端（账号渠道连接 + 本机 API）

> 安装包下载：https://github.com/hrc-090/ofm-client/releases/latest

把 `dsh-our-free-model` 的「账号渠道连接」抽出来，做成一个独立 Android App：
在 App 里登录各家账号，在本机起一个 `127.0.0.1:18900` 的 HTTP 服务，对外提供
OpenAI / Anthropic 兼容接口，供手机上的 ChatBox、OpenAI SDK、Claude Code 等直接调用。

> 协议细节来自上游 `vendor/channel-pack` 源码（MIT）与实测记录；本仓库是重新实现，
> 没有直接搬运上游 TS 代码，Qoder 的 WASM 桥是逐行移植并保留了版权说明。

---

## 1. 当前状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 本机 API（`/health`、`/v1/models`、chat、responses、messages）、mock 渠道 | ✅ 已跑通，40 项断言 |
| M2 | TRAE 全链路（登录 / 续期 / 目录 / 对话 / 工具调用） | ✅ 代码完成，**待真实账号联调** |
| M3 | Qoder / Qoder 中国版（WASM 加密推理） | ✅ WASM 签名已本地验证，**待真实账号联调** |
| M4 | Cline + LobsterAI | ✅ 代码完成，未联调 |
| M5 | Loomy / Raccoon / MiniMax / ZCode | ✅ 代码完成，未联调 |
| M6 | 前台服务 / 后台存活 / UI | ✅ 已编译出 APK（25 MB，arm64-v8a），**未上机运行** |
| M7 | 签到 / 领取积分 + 自动签到 + 余额卡片 | ✅ 代码完成，148 项断言全过，**待真实账号联调** |
| M8 | 浏览器回调打不开时的「粘贴链接完成登录」兜底 | ✅ 代码完成，36 项断言全过，已编进 APK |
| M9 | 固定 API Key、模型自动预热、余额总览 | ✅ 代码完成，40 项断言全过，已编进 APK |
| M10 | TRAE 连上却不显示模型：兜底目录 + 拉取诊断 | ✅ 代码完成，54 项断言全过，已编进 APK |
| M11 | 远端拉取 / 余额查询失败：CA 根证书 + 网络自检 | ✅ 代码完成，81 项断言全过，已编进 APK |
| M12 | 自检全通过仍失败：补 OAuth host + 账号/凭据体检 | ✅ 代码完成，67 项断言全过，已编进 APK |
| M13 | 体检报 `incomplete` 缺 `machine_id`/`device_id`：修登录 session 解包 + 存量凭据自愈 | ✅ 代码完成，48 项断言全过，已编进 APK |
| M14 | 第三方「接入 API 无回复」：零内容保护 + 拓宽响应解析 + 流式错误可见 + 对话自检 | ✅ 代码完成，62 项断言全过，已编进 APK |
| M15 | 真机自检报「HTTP 200 只回 1 帧 metadata」：修 SSE 分帧循环判断错误（总根因）+ 输出额度按模型上限收敛 + 零正文自动重试 | ✅ 代码完成，30 项断言全过，已编进 APK |
| M16 | 余额只显示一个孤零零的数字：补「剩余 / 共 / 已用」三件套 + 各渠道逐账号明细 + 每包进度条 | ✅ 代码完成，157 项签到断言全过，已编进 APK |
| M17 | 余额报「非 JSON 响应」：响应层不解 gzip（签到小响应不压缩、余额大响应压缩）→ 补解压 + 错误带 content-type 与样本 | ✅ 代码完成，32 项解压断言全过，已编进 APK |
| M18 | 模型列表缺积分消耗倍率：补 `display_contact_config` 二次解析（倍率 + 活动折扣原价）并透出到 `/api/models` / `/v1/models` 与 App 列表 | ✅ 代码完成，79 项目录断言全过，已编进 APK |
| M19 | 界面重写：五页底部导航（概览 / 渠道 / 模型 / 积分 / 用量）、设置移到右上角齿轮、统一卡片与主题、模型卡片带倍率与能力标签、支持搜索 | ✅ 编译通过，已编进 APK |
| M20 | 「AI 无法正常使用工具」：修 TRAE 工具分片归并（后续帧只有 index 时被当成新调用）、丢弃 `partial_arguments`、累计参数重复拼接、`openai-compat` 分帧死循环；并修 400（`content` 只能是数组） | ✅ 代码完成，31 项工具断言全过，已编进 APK |
| M21 | 用量看板 + 运行日志（Android 侧）：今日 / 7 天 / 30 天切换、请求数与成功率、token 与缓存命中、每日请求柱状、按模型/渠道/客户端分布、请求明细与清空 | ✅ 编译通过，已编进 APK |
| M22 | 思考档位（Android 侧）：模型页按模型选默认思考强度、可清除回「自动」；档位值原样来自上游目录，上游未列可选值时提供通用 `low / medium / high` | ✅ 编译通过，已编进 APK |
| M23 | 启动图标：Manifest 原本没有 `android:icon`（一直是系统默认机器人）→ 补全套 adaptive icon（渐变背景 + 前景 + Android 13 主题图标）与五档密度 legacy PNG，源 SVG 放 `design/` | ✅ 编译通过，已编进 APK |
| M24 | MiniMax Code 拉不到模型：目录接口返回 `providers[].config.models` **字典**（key 才是模型 id），旧版只认 `data.models` 数组 → 恒空列表且不报错；重写解析 + 静态兜底 + 公开目录跳过凭据 | ✅ 真实网络实测拉到 2 个模型，58 项断言全过，已编进 APK |
| M25 | 讯飞（Loomy）短信登录发不出验证码：账号域 9 行 HMAC 规范串算了 `Content-MD5` 却**没发同名请求头**，服务端按收到的头重建 → 恒 401 `HMAC signature does not match`；补头，并补齐聊天必备的 `traceparent` / `loomy-version`、模型目录改用真实 token | ✅ 修复后真实上游 `sendMsgCode` 返回 200 + msgid，48 项断言全过，已编进 APK |
| M26 | 加签到日志方便排查：自动签到每轮逐渠道留痕（启动 / 巡检 / 开关、跳过原因、失败原因、是否记入今日）、手动签到逐账号 outcome 与错误、余额查询失败；积分页新增「签到日志」卡片（刷新 / 加载更多 / 清空 / 一键复制脱敏纯文本报告） | ✅ 代码完成，104 项断言全过，已编进 APK |
| M27 | 模型页看不出属于哪个渠道：模型 id 里只有内部 id（`trae/xxx`）、显示名又只是模型名 → 模型目录下发 `provider_name`（渠道显示名，缺字段按 `name` → provider id 回退），App 在每条模型名前加渠道标签，搜索框支持按渠道筛 | ✅ 代码完成，26 项断言全过，已编进 APK |
| M28 | 第三方模型列表仍看不到渠道名：标准客户端只显示 `/v1/models` 的 `id`，M27 的标签只画在 App 里 → `/v1/models` 的 `display_name` 前置渠道名，`id` 保持真实 `provider/model`（同时是路由键），`chatStream` 入口兼容反解；旧客户端继续填真实 id 完全兼容 | ✅ 代码完成，已编进 APK |
| M29 | 客户端看不到模型真实思考档位：`listAll()` 只认 `reasoningOptions` 一个字段名，Qoder 的 `efforts` 和 MiniMax 的 `effort_options` 全被丢掉，App 只能落到 `low/medium/high` 兜底 → 抽出 `reasoning-options.js` 统一归一化（数组 / 对象字典 / 多种 value+label 字段、去重、value 原样透传），`listAll` 兼容四种字段名，MiniMax 目录解析 `effort_options` | ✅ 代码完成，49 项档位断言全过（含 Light / High / Extra Light 带空格标签），已编进 APK |
| M30 | 第三方列表「两行都脏」：不少客户端把 `display_name` 放第一行、`id` 放第二行，M28 把渠道名同时写进两个字段，于是显示成 `[TRAE] Seed-Code` + `[TRAE] :: trae/Doubao-Seed-Code` → 渠道名只留 `display_name`，`id` 恢复原始 `provider/model`；渠道显示名去掉厂商标注（`TRAE（字节）`→`TRAE`、`Loomy（讯飞）`→`Loomy`）；客户端把显示名/URL 编码/带引号的 id 当 model 回传时会 400 断流，新增入口归一化（唯一命中才还原，歧义不猜） | ✅ 代码完成，已编进 APK |
| M31 | 用本地回显模型「有时也会中断」：三处独立根因 —— ① 回显渠道按 4 个 UTF-16 单元切帧，emoji / ZWJ 组合被切成孤立代理（`"\ud83d"`），严格客户端 JSON 解析失败；② 入口把模型显示名还原成 `provider/model` 时裸等 `listAll()`，某家上游卡住（TRAE 单次 75s）会把这次对话一起拖到客户端超时，5 分钟目录 TTL 到期后第一次必中，正好是「有时」；③ 中断判据用 `req.complete`，POST 读完请求体即恒真，客户端中途断开时上游从不取消 → 改字素簇切帧、`peek()` 只读快照 + 3s 超时兜底、判据移到 `res.writableEnded` | ✅ 代码完成，40 项断言全过（含真 HTTP 断开与慢渠道），已编进 APK |
| M32 | 列表仍显示 `[TRAE（字节）] :: trae/xxx`：`?id_label=1` 这条「把渠道名塞进 id」的逃生通道还在，` :: ` 就是它产出的 → 整条通道删除，`id` 恒为真实 `provider/model`，渠道名只留在 `display_name`；源码里残留的厂商字样（含注释）清零；补断言「任何参数都不会让 id 变形」「下发内容不含 `（字节）`/`（讯飞）`/` :: `」 | ✅ 代码完成，93 项断言全过，已编进 APK |
| M33 | 给第三方客户端提供网页搜索：内置回退链（Bing / Keenable / Exa / Parallel / AnySearch），对外三个出口 `/v1/search`、`/v1/read`、`/mcp`（`web_search` / `web_read`）；App 设置页按第三方客户端的字段规格给出「该填什么」（地址 / Key / 请求模板 / 结果字段，可一键复制），**不再提供自定义搜索 / 自定义读取输入框**（那是第三方自己的设置页，重复只会诱导用户填本机地址）；SSRF 拦私网与云元数据、自环检测、30s 预算、按源冷却、LRU 缓存 | ✅ 代码完成，175 项断言全过，已编进 APK |
| M34 | 后台保活：电池优化白名单引导（`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`）、通知权限与厂商自启动入口、「划掉任务不停服务」（`stopWithTask=false` + `onTaskRemoved`）、Android 14 前台服务类型、系统重建限流（10 分钟最多 3 次，避免崩溃后无限重启）、设置页「后台保活」状态卡 | ✅ 已编进 APK（aapt2 校验权限与 service 属性） |
| M35 | 界面重设计「仪器台」：全新设计 token（暖纸 / 墨 / 朱砂 + 独立深色板）、模块化字阶、12dp 圆角体系、细线分组；重写首页（状态大标题 + 整行可复制字段 + 一行指标 + 文字链操作）、顶栏（品牌小标 + 状态芯片含端口 + 当前页标题 + 明确返回）、底栏（顶部短横线选中态 + 重绘图标）；`OfmCard` / `Pill` / `StatTile` / `StatusDot` / `MonoText` 共享组件全部重做，渠道 / 模型 / 积分 / 用量 / 设置 / 网页搜索自动继承新视觉，功能逻辑一行未动；状态色圆点+文案双编码、触控目标 ≥48dp、对比度过 WCAG AA | ✅ Kotlin 编译通过、33 处新组件进 classes3.dex，已编进 APK |
| M36 | 导航调整：底栏改为「概览 / 渠道 / 模型 / 用量 / 搜索」——「模型」与「积分」合并成一项、页内用新增的 `OfmSegmented` 分段开关切换，腾出的一格把网页搜索从「设置 → 打开设置」的二级页提到一级 dock；搜索页去掉「← 返回」改为状态摘要条（刻度标签 + 带圆点状态胶囊），设置页删掉重复的搜索卡片；底栏图标按新顺序重排并新增放大镜；概览页补「网页搜索」入口、修正跳转索引；顶栏对搜索页用完整页名 | ✅ Kotlin 编译通过、20 套 core 回归断言全过、预览 20 项交互校验 + 真实浏览器浅/深主题渲染通过，已编进 APK |
| M37 | 修「缓存命中一直是零」：新增 `usage-cache.js` 统一收口六种上游缓存命名（OpenAI Chat/Responses、Anthropic、DeepSeek/Moonshot、顶层）；三个归一化层（OpenAI / TRAE / Anthropic）不再削掉命中数；`applyUsageRecord` 打 `cacheSeen` 稀疏标记，summary 返回 `cacheReported`、命中率分母只算上报过的请求并夹 100；回传第三方客户端的 Chat/Responses/Anthropic usage 不再写死 0；看板区分「未上报（显示 —）」与「真实 0」 | ✅ 新增 79 项断言、全量 21 套回归全过、Kotlin 编译通过，已编进 APK |
| M38 | 修「模型页一直下滑闪退」：四个放大器一起收口 —— ① `refresh()` 由每 1.5s 无条件换新 List 改为**内容不变不赋值**、`data` 缺失时保留旧目录、轮询降到 3s，消除 fling 期间全量重组与 0↔N item 数抖动；② 标题 / 提示 / 搜索框从 `LazyColumn` 的 item 移到列表外固定区，不再随滚动被回收导致焦点反复重建；③ `listAll()` 按 id 去重、过滤无 id 脏条目、截断 `display_name`/`provider_name`（120/24）、档位限 12，App 端 `ModelItem` 再兜一层长度上限并 `distinctBy`，保证 key 唯一且单个 `Text` 不会撑爆 `StaticLayout`；④ 签到结果长日志限 60 行 / 每行 200 字 / 总长 6000。新增 `CrashHandler`：未捕获异常落盘 `filesDir/crash/`，设置页可复制完整堆栈 | ✅ 新增 20 项断言、全量 22 套回归全过、Kotlin 编译通过，已编进 APK |

「未联调」= 协议按上游源码与实测常量实现，但本环境没有账号，无法验证真实返回。
第一次联调请从「登录 → 拉模型 → 一句话对话」这条直线开始，别叠功能。
二十二套纯 mock 断言共 **1431 项**（协议 42 + 签到 157 + 登录回调 36 + Key/模型 42 + TRAE 目录 81 + 网络 81 + 账号体检 67 + 凭据自愈 48 + 对话链路 65 + 空流重试 30 + 响应解压 32 + 用量 53 + 思考档位 49 + 工具调用 31 + MiniMax 目录 58 + 讯飞短信登录 48 + 签到日志 104 + 模型渠道名 93 + 流式稳定性 40 + 网页搜索 175 + 缓存命中 79 + 模型目录安全 20），不依赖账号与外网。

---

## 2. 目录

```
core/                          Node 运行时（桌面可直接跑，Android 复用之）
  main.js                      入口：读配置 → 起 server → 写 runtime.json
  src/
    server.js                  本机 API 路由 / 鉴权 / SSE 渲染
    dispatch.js                选号、续期、失败分类与换号重试；模型目录去重 + 脏条目过滤 + 展示字段长度上限
    account-pool.js            多账号选号与限流标记
    openai-compat.js           OpenAI 兼容上游的 SSE 消费（形状嗅探、工具分片）
    anthropic-compat.js        内部格式 ↔ Anthropic（MiniMax / ZCode 上游用）
    browser-callback.js        18080 回调接收 + 会话匹配 + URL 归一化（粘贴兜底复用）
    ca-bundle.js               内嵌 Node 的 CA 根证书（内置表 + 打包的 cacert.pem 合并）
    net-diagnose.js            DNS / TCP / TLS / HTTPS 分步网络自检（4 个目标，含 OAuth host）
    account-diagnose.js        账号 / 凭据脱敏体检（自检时附带，不发网络请求）
    credential-repair.js       存量凭据自愈：补齐 TRAE 写丢的设备标识（免重登）
    login-manager.js           登录会话；统一摊平各渠道 start() 的 session 包装层
    usage-store.js             用量日志：按天分片 JSONL（只存统计，不存正文）
    usage-cache.js             缓存命中 token：六种上游命名统一读取 / 归一化挂载 / 对外 usage 折算
    checkin-log.js             签到日志：按天分片 JSONL + 脱敏 + 纯文本排查报告
    model-label.js             模型展示名 / 展示 id：渠道名前缀 + 脏输入反解（编码 / 引号 / display_name）
    reasoning-options.js       思考档位归一化：各渠道的数组 / 字典声明都归成 {value,label}
    credits/                   签到 / 积分：能力表、模型、格式化、逐账号收集、调度
      providers/               trae / qoder / lobsterai / loomy / minimax / zcode /
                               raccoon / cline / gemini 九个 provider
      auto-checkin.js           auto-checkin.json 状态文档 + 启动延迟 / 跨天巡检 / 失败退避
    convert/                   OpenAI / Anthropic / Responses 三种入口协议互转
    channels/
      trae/ qoder/ cline/ lobsterai/ loomy/ raccoon/ minimax/ zcode/ mock
                               mock = 本地回显（不联网，验收与调试用；按字素簇切帧，不切坏 emoji）
  test/acceptance.mjs          协议验收（42 项，不依赖账号）
  test/checkin.mjs             签到验收（157 项，全 mock，不联网）
  test/login-callback.mjs      登录回调兜底验收（36 项，注入 mock 渠道，不联网）
  test/api-key-model.mjs       固定 Key / 第三方取模型 / 登录自动预热（42 项，不联网）
  test/trae-models.mjs         TRAE 目录解析 / 兜底 / 诊断（81 项，不联网）
  test/model-channel.mjs       渠道显示名：下发 / 回退 / id 与 display_name 分工 / 脏输入归一化 / 三协议路由（93 项，不联网）
  test/stream-robust.mjs       流式稳定性：字素簇切帧 / emoji 不切坏 / 慢渠道不拖死入口 / 断开即取消上游（40 项，含本地 HTTP）
  test/network.mjs             CA / 错误码 / 分层自检 / 失败原因透传（81 项，不联网）
  test/account-diagnose.mjs    账号 / 凭据体检 + 脱敏（67 项，不联网）
  test/credential-repair.mjs   登录 session 解包 + 存量凭据自愈（48 项，不联网）
  test/chat-diagnose.mjs       对话链路：8 种上游形状 / 空回复保护 / 流式错误 / 自检脱敏（65 项，不联网）
  test/effort.mjs              思考档位：归一化 / 渠道透出 / 默认注入（49 项，不联网）
  test/tool-calls.mjs          工具调用：分片归并 / partial_arguments / 四种帧形（31 项，不联网）
  test/minimax-models.mjs      MiniMax 模型目录：字典解析 / model_order / 静态兜底（58 项，不联网）
  test/usage.mjs               用量日志：分片读写 / 汇总 / 最近明细 / 清空（53 项，不联网）
  test/cache-tokens.mjs        缓存命中全链路：六种命名 / 三个归一化层 / 回传三方 / 未上报区分 / 真实 HTTP 端到端（79 项，不联网）
  test/loomy-sms.mjs           讯飞短信登录：HMAC 规范串 / Content-MD5 / 验证码流（48 项，不联网）
  test/trae-empty-retry.mjs    「只回 metadata 就断流」：分帧 / 额度收敛 / 自动重试（30 项，不联网）
  test/http-encoding.mjs       响应解压：gzip / deflate / br / 魔数嗅探 / 错误可诊断（32 项，本地 http server）
  test/checkin-log.mjs         签到日志：脱敏 / 分片读写 / 自动轮次打点 / 管理接口（104 项，不联网）
  test/web-search.mjs          网页搜索：模板 / 路径 / 清洗 / SSRF / 回退链 / 冷却 / 缓存 / MCP（161 项，本地 mock）
  test/model-list-safety.mjs   模型目录安全：重复 id 去重 / 脏条目过滤 / 超长字段截断 / 档位上限 / 600 条大目录（20 项，不联网）
  cacert.pem                   Mozilla CA bundle（随 assets 进 APK，给内嵌 Node 用）
android/                       Android 工程（Kotlin + Compose + 自建 JNI 桥）
  app/src/main/cpp/ofm_node.cpp    JNI：String[] → char**，chdir + setenv，调 node::Start
  app/src/main/java/com/ofm/client/
    NativeNode.kt                  加载 c++_shared / node / ofmnode，声明 external
    NodeRuntime.kt                 assets 解包、runtime.json 读取
    ApiService.kt                  前台服务，node 跑在独立线程
    CrashHandler.kt                全局未捕获异常落盘 filesDir/crash/，最近 5 份，设置页可复制堆栈
    MainActivity.kt                状态与业务逻辑（登录、自检、报告格式化）、顶栏与底栏导航；轮询刷新幂等
    Screens.kt                     概览 / 渠道 / 模型+积分（合并页分段）/ 设置；底栏五项
    Theme.kt                       设计 token / 字阶 / 形状 + 卡片、胶囊、分段、指标块、复制字段、自绘底栏
    CheckinSection.kt              签到 / 余额 / 自动签到 / 签到日志区块
    WebSearchScreen.kt             底栏「搜索」页：开关、第三方字段对照、试搜试读
    UsageScreen.kt                 用量看板 + 运行日志
    LoginWebViewActivity.kt        授权页 + 回调拦截 + 手动粘贴
  app/src/main/jniLibs/arm64-v8a/  libnode.so（预编译）+ libofmnode.so（本仓库编译）
tools/sync-assets.mjs          core → app/src/main/assets/nodejs-project
tools/fetch-libnode.mjs        从 npm 包取预编译 libnode.so
tools/build-native.sh          编译 JNI 桥接层
dist/ofm-client-0.1.0-debug.apk 已构建产物（debug 签名，arm64-v8a）
```

---

## 3. 先在电脑上跑（推荐第一步）

```bash
cd core
node test/acceptance.mjs        # 41 项协议断言，全部本地，不联网
node test/checkin.mjs           # 148 项签到断言，全 mock，不联网
node test/login-callback.mjs    # 36 项登录回调兜底断言，注入 mock 渠道，不联网
node test/api-key-model.mjs     # 40 项固定 Key / 模型预热断言，不联网
node test/trae-models.mjs      # 54 项 TRAE 目录 / 兜底断言，不联网
node test/network.mjs          # 81 项 CA / 网络自检断言，不联网
node test/account-diagnose.mjs # 67 项账号 / 凭据体检断言，不联网
node test/credential-repair.mjs # 48 项登录解包 / 凭据自愈断言，不联网
node test/chat-diagnose.mjs     # 65 项对话链路 / 自检断言，不联网
node test/trae-empty-retry.mjs  # 30 项空流分帧 / 重试断言，不联网
node test/http-encoding.mjs     # 32 项 gzip / br 解压断言，本地 http server
node test/web-search.mjs        # 161 项搜索 / 读取 / MCP 断言，本地 mock，不联网
node main.js                    # 监听 127.0.0.1:18900
```

启动后 `runtime.json` 在数据目录（默认 `~/.our-free-model`，Android 上是 `files/data`），
里面有实际端口、API Key、uiToken。

```bash
KEY=$(node -e "console.log(require(process.env.HOME+'/.our-free-model/runtime.json').key)")

curl -s http://127.0.0.1:18900/health
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:18900/v1/models
curl -N -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"mock/echo","stream":true,"messages":[{"role":"user","content":"你好"}]}' \
  http://127.0.0.1:18900/v1/chat/completions
```

---

## 4. 本机 API 契约

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/`、`/health` | 否 | 存活探测 |
| OPTIONS | 任意 | 否 | CORS 预检，204 |
| GET | `/v1/models`、`/models` | 是 | `provider/model` 形式 |
| POST | `/v1/chat/completions` | 是 | OpenAI Chat（流式 / 非流式） |
| POST | `/v1/responses` | 是 | OpenAI Responses |
| POST | `/v1/messages` | 是 | Anthropic Messages |
| POST | `/v1/messages/count_tokens` | 是 | 本地估算，不发上游 |
| POST | `/api/login/browser-target` | uiToken | 用系统浏览器登录前登记 accountId |
| POST | `/api/login/complete` | uiToken | `{url, accountId?}` 粘贴回调链接完成登录，不依赖 18080 |
| GET | `/api/login/poll` | uiToken | 轮询登录会话直到 done |
| GET | `/api/checkin/capabilities` | uiToken | 渠道签到能力表（决定 UI 给不给按钮） |
| POST | `/api/checkin/status` | uiToken | `{provider}` → 逐账号签到状态 |
| POST | `/api/checkin/claim` | uiToken | `{provider}` → 逐账号领取（一键签到） |
| POST | `/api/checkin/balances` | uiToken | `{provider, force?}` → 逐账号余额 + windowDays |
| POST | `/api/checkin/auto` | uiToken | `{enabled?}` 写开关 / `{dismiss:true}` 关提示 / 省略=只读 |
| POST | `/api/settings/key` | uiToken | `{key}` 设成自己的固定 Key；留空 = 恢复固定默认值 |
| POST | `/api/settings/key/rotate` | uiToken | 主动轮换随机 Key（会变，需重新配置第三方） |
| GET | `/api/network/diagnose` | uiToken | 出站网络分步自检（4 个目标）+ 附带账号/凭据脱敏体检 `accounts`；`?host=x&host=y` 可指定目标，报告可复制 |
| GET | `/api/status` 等 | uiToken | 给 App 界面用（见 `server.js`），含 `network.ca` 根证书概况 |

- 鉴权：`Authorization: Bearer` / `x-api-key` / `x-goog-api-key` / `?key=`；
  常量时间比较（两边 sha256 后 `timingSafeEqual`）。
- **API Key 固定**：默认 `ofm-local-key`，清数据 / 重装后不变，第三方客户端配置一次即可；
  可用 `OFM_API_KEY` 环境变量覆盖，或在 App「设固定 Key」里改成自己的值（落盘）。
- CORS 放行任意请求头（`access-control-allow-headers: *`），因为 OpenAI 官方 SDK
  会带 `x-stainless-*` 等自定义头；SSE 等首 token 期间每 15s 发 `:\n\n` 注释帧。
- `/api/*` 额外要求 `x-ofm-ui-token`（进程内随机生成，防同机其它 App 读走 Key）。
- 只监听回环；端口占用时退到系统分配端口，并把实际端口写进 UI 与 `runtime.json`。

### 4.1 第三方客户端怎么连 / 模型列表为空

- **Base URL**：`http://127.0.0.1:18900/v1`（以 App 界面显示的端口为准）
- **API Key**：`ofm-local-key`（默认固定值，清数据 / 重装不变）

ChatBox / DSH / OpenAI SDK 直接填这两个即可。`/v1/models` 返回标准
`{object:'list', data:[{id:'trae/xxx', object:'model', owned_by:'trae', display_name:'[TRAE] xxx', real_id:'trae/xxx', ...}]}`。
`id` 就是路由用的真实 `provider/model`，原样回传即可。

**渠道名只放在 `display_name`，`id` 永不装饰**：多数第三方客户端会把 `display_name` 放第一行、
`id` 放第二行，两个字段都带渠道名就会出现「`[TRAE] Seed-Code` + `[TRAE] :: trae/Doubao-Seed-Code`」
这种两行都脏的效果。所以 `id` 恒为原始 `provider/model`（它同时是路由键），渠道名只进
`display_name`，显示成 `[TRAE] Seed-Code` / `trae/Doubao-Seed-Code` 两行，一眼能看出属于哪个渠道。
**`?id_label=1` 这条「把渠道名塞进 id」的通道已经删除** —— 它正是 ` :: ` 这种脏串的来源；
请求入口仍保留对旧装饰 id 的反解，装了旧版的客户端把缓存里的 id 发回来照样能路由。
`?channel=0` 可让第一行也不带渠道。渠道显示名不带厂商标注（`TRAE` / `Loomy` / `ZCode`）。

**脏 model 输入**：客户端有时把 `display_name`、URL 编码过的 id、带引号的 id 当 `model` 回传，
以前会直接 400（表现为聊到一半断开）。现在三个协议入口都会先归一化：去编码、去引号、
剥装饰前缀；只剩模型名时查一次目录（5 分钟缓存），**唯一命中才还原**，歧义不猜。
`model-label.js` 里另有默认关闭的统一前缀 `MODEL_LABEL_PREFIX`：想在所有模型前
再加一段品牌名（如 `Tune`），改这一处即可，装饰与反解都不用动。

| 现象 | 原因 | 现在 |
| --- | --- | --- |
| 第三方 401 | 旧版清数据后 Key 随机重生成，客户端还填着旧值 | 默认 Key 恒定；手动改 Key 会同步进 `runtime.json` |
| 拿到 `data:[]` | 没有已登录账号，或登录成功后缓存没刷新 | 登录完成自动失效缓存 + 预热；启动 1.5s 后也预热一次 |
| 网页版第三方报 CORS | 预检只放行固定几个请求头 | `allow-headers: *`，放行 `x-stainless-*` 等自定义头 |

空列表时响应多一个 `hint` 字段说明原因（第三方会忽略），App 界面直接显示这句提示。
**没有账号时为空是正常的** —— 先去 App 里连一个渠道，列表会自动出现，不用手动刷新。

### 4.2 连上 TRAE 仍不显示模型：兜底目录与诊断

对照上游 [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model)
核对过：`agentHost`、22 个 `functions`、请求头、15 个通道白名单、目录解析规则**逐项一致**。
真正的差别是**失败后的行为** —— 上游 `TraeAuth.fetchModels` 失败返回 `[]`，
适配器随即回退到静态兜底表，明确保证「选择器不会为空」；而旧版工程一失败就
返回 `data:[]`，还把错误吞成一条 log，界面全空、也看不出原因。

Android 上远端目录（`/api/ide/v1/batch_get_detail_param`）拉取失败很常见：
TLS/DNS、上游 5xx、凭据失效、网络出口被拦。现在：

1. 先试 batch 端点，失败 / 解析为空再试单通道 `get_detail_param`；
   解析兼容 `function_configs`、顶层 `config_info_list`、`data` 信封与大写字段名。
2. 两次都拿不到 → 回退 **28 个静态兜底模型**（上游 2026-08 实测快照，
   去掉 4 条官方隐藏条目），每条带 `fallback:true`。
3. `/v1/models` 与 `/api/models` 都附带 `diagnostics`：
   `source: remote | fallback | no-account | error`、`count`、脱敏后的 `warning`。
   App 在「可用模型」上方显示「以下渠道显示的是兜底目录（远端拉取失败）…」，
   空列表时则直接显示失败原因（如 `HTTP 401 目录鉴权失败`）。
4. 界面新增**「重新拉取」**按钮（`/api/models?refresh=1`），网络恢复后不用重启 App。
5. 所有诊断与错误文案过滤 `Bearer` / `Cloud-IDE-JWT` / JWT，绝不回显凭据。

> ⚠️ 兜底目录只保证**列表不空**，能否真正对话仍取决于凭据与网络。
> 看到兜底提示时先确认「连接」是否真的完成、设备能否访问 `trae-api-cn.mchost.guru`，
> 再点「重新拉取」。若诊断是 401，重新登录一次即可。

### 4.3 「远端拉取失败」+「余额查询失败」同时出现

这两个不是两个 bug，**是同一条出站链路**：模型目录和签到 / 余额都走
`upstream.request → http-client.js 的 https.request`。真机上一起失败，通常是
Node 进程根本发不出 HTTPS 请求。最容易踩的是 **CA 根证书**：

- `res/xml/network_security_config.xml` 只约束 Java 层（WebView / HttpsURLConnection），
  **对 nodejs-mobile 里的 Node 完全无效**；
- Node 自带 OpenSSL，Android 上没有 `/etc/ssl/certs/ca-certificates.crt`，
  `/system/etc/security/cacerts` 又是分文件 + hash 命名，OpenSSL 读不了；
- 一旦 `libnode.so` 编译时没把内置根证书打进去，全部 HTTPS 都会
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，界面就只剩「拉取失败 / 查询失败」两句空话。

现在的处理：

1. `core/cacert.pem`（curl.se 的 Mozilla CA bundle，118 张根证书）随 assets 进 APK；
   `ca-bundle.js` 把它与 `tls.rootCertificates` **合并**，由 `httpsOptions()` 显式
   传给 `https.request`（不替换内置表）。另开 `autoSelectFamily`，避免 Android 上
   「IPv6 能解析但路由不通」。
2. `describeNetError()` 把 TLS / DNS 错误码翻成中文（`证书链校验失败：缺少根证书`、
   `域名解析失败：DNS 被污染或没有外网`、`上游证书已过期：检查手机系统时间`…）。
3. 失败原因不再被固定文案吞掉：兜底目录的 `hint` 带上脱敏 `warning`；
   余额 / 领取全员失败时追加底层网络原因（仍严格区分 `null` 与 `0`）。
4. App 新增 **「网络自检」** 卡片 → `GET /api/network/diagnose`，按
   `DNS → TCP → TLS → HTTPS` 逐层探测 **四个目标**：国内对照 + `api.trae.cn`
   （签到/余额）+ `trae-api-cn.mchost.guru`（模型目录）+ `api.trae.com.cn`
   （登录/换 token —— 早期漏了这个域名，登录可达性其实没测）。
   报告可一键复制。TLS 步骤故意 `rejectUnauthorized:false` 只为读出
   `authorizationError`；真实业务请求仍然严格校验，不带任何凭据。
5. **同一次自检附带账号/凭据体检**（`account-diagnose.js`，`accounts` 段）：
   清空过应用数据后没有可用账号、登录卡在 `pending`、凭据文件丢失或字段残缺
   （TRAE 签到要 `uid`、模型目录要 `machine_id`/`device_id`），这些都会让
   模型为空、余额失败，却和网络毫无关系。现在逐账号给出状态、缺失字段、
   token 剩余小时数和一句中文结论，全程只输出字段名与布尔值，**不含任何
   凭据值 / 昵称 / 手机号**，也不发网络请求。

| 自检结论 | 含义 / 处理 |
| --- | --- |
| 所有目标全通过 | 网络层排除；看 `accounts`：没账号→连渠道，凭据齐→多半是 401 / 上游 5xx，重新登录或稍后重试 |
| 账号 0 个 / `no-credential` | 清过数据或登录没完成；模型空、余额失败属正常，先连渠道 |
| `pending` / `needs-login` | 登录未完成或凭据失效；重新点「连接」 |
| `incomplete` 缺 `machine_id`/`device_id` | **不用重新登录**：新版启动或点一次「网络自检」会自动补齐并写回，报告末尾有「凭据自愈」一行；补齐后点「重新拉取」 |
| `incomplete` 缺 `uid` / `access_token` | 这类字段只能由登录返回，删掉该账号重新点「连接」 |
| 卡在 `dns` | 没外网、DNS 被污染或 VPN 拦截；换网络或关掉私人 DNS 再试 |
| 卡在 `tcp` | 443 被防火墙 / 代理拦；检查是否挂了只放行浏览器的代理 |
| 卡在 `tls` | 根证书缺失或中间人代理；看报告里的 `code` 与证书颁发者 |
| `https` 失败 | TLS 通但请求被拒；看 HTTP 状态码判断 401 / 5xx |

> 注意：自检里两个 TRAE 上游返回 `HTTP 404` 是**正常的** —— 探测只发
> `GET /` 根路径，能收到 404 恰恰证明 DNS/TCP/TLS/HTTPS 全通。业务端点
> （`/api/ide/v1/batch_get_detail_param` 等）是另一个 path，404 不代表它不可用。

> 报告里的「根证书」一行会显示内置 + 打包数量；若 `打包 0 张` 说明
> `cacert.pem` 没被解包（覆盖安装旧版时清一次数据，或确认 `version.txt` 指纹已变）。

### 4.4 第三方「接入 API 无回复」

能列出模型、发消息却一片空白，和 §4.1～4.3 都不同：**这一层是对话转发链路**。
之前所有真机联调都停在登录 / 目录 / 网络 / 余额，第一次真正发对话才暴露。

根因是三层叠加，而且全都「静默」：

1. **响应帧形状不认识 → 静默空回复**。`TraeChannel.stream()` 只认
   `event: output` 一种帧；上游一旦回标准 OpenAI `data:` 帧、不带 `event`
   行、别的 event 名、`200 + JSON` 业务错误或整段完成体，解析层一个正文
   delta 都吐不出来，`chatStream` 却会「正常结束」，本机 API 返回
   `200 + content:''` —— 客户端既看不到内容也看不到错误。
2. **流式错误不可见**：异常时只写裸 `data: {"error":…}`，严格按
   `choices[0].delta` 解析的 SDK 会直接忽略 → 还是空白。
3. **整条链路不可观测**：没有请求日志，也没有能看「上游到底回了什么」的自检。

现在的处理：

- `dispatch.js` 统计正文 delta，零产出时抛 `EMPTY_REPLY`（HTTP 502、不重试），
  错误里带上「上游 HTTP 状态 / 收到帧数 / content-type」线索。
- 三个流式入口的 catch 除结构化错误帧外，还会补一段 `[OFM 错误] …` 的
  assistant 正文；严格客户端至少能看到原因。`POST /v1/*` 完成后在 logcat
  打一行 `status / ms / ua`。
- `parseTraeEvent` 兜住 5 种形状：`output` 自定义帧、标准 OpenAI chunk、
  无 `event` 行的 `data:` 帧、换名但字段仍是 TRAE 形状的帧、`200 + JSON`
  完成体；`200 + JSON` 业务错误直接抛带业务码的中文错误。
  `TraeChannel.stream()` 先嗅探首块形状，非 SSE 就按整段 JSON 处理，
  并补 `content-length`（有些网关不接受 chunked）。
- `iterateSse` 新增**首有效内容帧超时**：注释 / 心跳帧不给它续命，
  避免上游只发 `: keepalive` 时流永不结束也永不出内容（旧空闲计时会被
  每个 chunk 重置）。
- App 新增 **「对话自检」** 卡片 → `POST /api/chat/diagnose`：发一条
  `hi` 真实请求（会消耗一次额度），把选号 → 上游 HTTP 状态 →
  content-type / 形状 → SSE 帧数、有效帧数、正文片段数、正文长度 →
  首片段耗时 / 总耗时 → 错误码逐层摊开，报告可复制。
  所有样本都做 token / JWT 脱敏。

| 自检结论 | 含义 / 处理 |
| --- | --- |
| `ok=true`，有正文片段 | 对话链路正常，问题在第三方客户端配置（base URL / stream 设置） |
| `EMPTY_REPLY`，`httpStatus=200`、`frames>0` | 上游回了帧但格式没被识别；把「上游响应样本」发开发者补解析 |
| `EMPTY_REPLY`，`frames=0` | 上游没吐内容；看 `sample` 是不是业务错误 JSON 或空响应 |
| `TIMEOUT` /「没有返回任何有效内容帧」 | 上游挂起或只发心跳；换模型或稍后重试 |
| `AUTH` / `401` | 凭据失效，重新点「连接」 |
| `NO_ACCOUNT` / `NO_MODEL` | 没可用账号或目录为空，先连渠道再「重新拉取」 |
| `TRANSPORT` / TLS / DNS 错误 | 回到 §4.3 的「网络自检」 |

### 4.5 用量看板与运行日志

App 底栏「用量」页（M36 起是第 4 项），数据全部来自本机，**不向上游发任何额外请求**：

| 接口 | 用途 |
| --- | --- |
| `GET /api/usage/summary?days=1\|7\|30` | 聚合：请求数 / 成功率 / 输入·输出·缓存 token / 平均耗时 / 首片段延迟，以及 `byDay` `byModel` `byProvider` `byUa` 四组分布 |
| `GET /api/usage/log?limit=N` | 最近 N 条请求明细（倒序）：时间、状态、模型、耗时、token、客户端 |
| `DELETE /api/usage` | 清空本机所有按天分片日志 |

**「缓存命中」为什么一直是 0 / 显示「—」（M37）**：这是上游 prompt cache 命中的
输入 token，不是 OFM 自己缓存搜索结果。旧版恒为 0 有三层原因：

1. **字段被归一化削掉**：TRAE 的 `mapUsage()` 把 usage 砍成 3 个总数、
   `consumeAnthropicStream()` 只取 input/output、`convert/responses.js` 回传客户端时把
   `cached_tokens` 写死 0。上游即使报了命中，进到统计前就没了。
2. **命名不统一**：OpenAI Chat 是 `prompt_tokens_details.cached_tokens`、Responses 是
   `input_tokens_details.cached_tokens`、Anthropic 是 `cache_read_input_tokens`、
   DeepSeek/Moonshot 是 `prompt_cache_hit_tokens`，旧版只认第一种。
3. **上游本来就不报**：这些免费/中转渠道大多不在 usage 里给缓存明细，此时「命中 0」
   其实是「没数据」，一直显示 0 反而误导。

现在 `core/src/usage-cache.js` 统一收口六种命名，三个归一化层（OpenAI / TRAE /
Anthropic）都调用 `attachCacheTokens()` 保留命中数；`applyUsageRecord()` 落盘时打
`cacheSeen` 稀疏标记；`/api/usage/summary` 返回 `cacheReported`、`cacheReportedReqs`，
命中率分母**只算上报过缓存的请求**（不被未上报的大输入稀释）、夹到 100 防越界；
回传第三方客户端的 Chat / Responses / Anthropic usage 也带上真实命中数。
看板上：上游未上报 → 显示「—」并注明「当前渠道未上报缓存用量」；上报了（含真实 0）
→ 显示实际数字与命中率。

实现约束（见 `core/src/usage-store.js`）：按天分片 `data/usage/YYYY-MM-DD.jsonl`，
**只存统计，绝不存请求/响应正文**；写失败只 warn、不影响请求；单日文件 32 MB
封顶，启动轮转删除 30 天前的整天分片。第三方客户端的 UA 会归成
`claude-code` / `codex` / `openai-sdk` / `anthropic-sdk` / `curl` 等有限枚举，
账号只留「渠道#尾 4 位」。

### 4.6 思考强度（reasoning effort）

有两条互相独立的路，优先级从高到低：

| 方式 | 怎么改 | 生效范围 |
| --- | --- | --- |
| 第三方客户端请求带 `reasoning_effort` | OpenAI/Responses 用 `reasoning_effort` 或 `reasoning.effort`；Anthropic 用 `thinking: {type:"enabled"}` | 单次请求，原样透传，**优先** |
| App「模型」页选档位 | 每个模型卡片下的 `自动 / …` 芯片，写入 `settings.modelEffort` | 该模型的**默认值**，仅当客户端没传时生效 |

接口：`GET /api/status` 回 `modelEffort`；`GET /api/models` 的 `data[]` 里
`reasoning_options` 是上游声明的 `{value,label}` 列表；`POST /api/settings`
提交 `{"modelEffort":{"trae/X":"high"}}`，值为 `""` 表示清除该模型默认值。
第三方 `/v1/models` 也带同一份 `reasoning_options`，能读扩展字段的客户端可直接取用。

档位声明各渠道字段名不一：TRAE 是 `reasoning_effort_config.options`，Qoder 是 `efforts`，
MiniMax 是 `effort_options`。这些都由 `reasoning-options.js` 统一归一化，`listAll()`
按 `reasoningOptions` / `efforts` / `effortOptions` / `effort_options` 依次尝试。
元素可以是字符串，也可以是对象字典（`{effort:'high', name:'高'}`）；`value` 取
`effort/value/level/id/name`，`label` 取 `name/label/display_name/displayName`，
去重后原样下发——所以 `Light` / `High` / `Extra Light` 这种带空格的标签也能显示。

档位值**原样透传、不做映射**（`dispatch.js` 只在 `req.reasoningEffort` 为空时补默认值，
`trae/protocol.js` 把它写进 `reasoning_effort`）。渠道没声明可选值的模型，
App 给一组通用 `low / medium / high` 兜底；未声明支持推理的模型可能忽略该字段。

### 4.7 签到日志（排查「今天为什么没领到」）

自动签到是后台任务，以前只留一句 `lastResult`：真机上「今天没领到」时，
看不出是没触发、渠道被跳过、凭据坏了还是上游报错。现在每一轮都落在
`data/checkin-log/YYYY-MM-DD.jsonl`，底栏「模型」页切到「签到积分」段后由「签到日志」卡片直接显示，
「复制日志」拿到的纯文本可原样发给开发者。

| 接口 | 用途 |
| --- | --- |
| `GET /api/checkin/log?limit=N` | 最近 N 条（倒序）+ 今日汇总（`runs / claimed / failed / skipped`） |
| `GET /api/checkin/log?limit=N&format=text` | `text/plain` 排查报告：时间、来源、渠道 / 账号尾号、结果、耗时、错误原因 |
| `DELETE /api/checkin/log` | 清空本机所有按天分片，不动账号与自动签到状态 |

记录范围：

- **自动签到**：启动 / 跨天巡检 / 开关补跑各记一轮，逐渠道写「需手动签到（排除表）」
  /「无签到接口」/「领取成功」/「失败原因」，收尾标明「已记入今日」或
  「未记入今日，会重试」（后者对应刻意不写 `lastDate` 的失败轮次）。
- **手动签到**：每个账号一条 outcome（成功 / 今天已领 / 未开启 / 失败）+ 本轮汇总。
- **状态 / 余额查询**：成功不记（页面会反复拉，避免刷屏），只记失败及原因。

实现约束（见 `core/src/checkin-log.js`）：所有文本过 `sanitizeMessage`
（去 Bearer / `key=value` 凭据 / 长串 token，截 240 字），账号只留「渠道#尾 4 位」；
写失败只 warn、绝不影响签到；只追加、只删整天分片，单日 8 MB 封顶，
启动清 30 天前的分片。读取接口会先 flush 队列，点完签到立刻刷新不会看到空日志。


### 4.8 网页搜索与读取（给客户端用）

本机 API 从「只转发模型」扩了一层搜索能力。三个出口，按客户端类型选：

| 出口 | 给谁用 | 说明 |
| --- | --- | --- |
| `POST/GET /v1/search` | ChatBox 这类「自定义搜索」 | 返回 `{ provider, note, results:[{title,url,snippet}] }` |
| `POST/GET /v1/read` | 同上「自定义读取」 | 返回正文纯文本 + `final_url`，长文截断 |
| `POST /mcp` | Claude Code / DSH 等 MCP 客户端 | JSON-RPC 2.0，工具 `web_search` / `web_read`，无状态 |

**客户端怎么填**（以自定义搜索框为例）：

```
接口地址   http://127.0.0.1:18900/v1/search
API Key    ofm-local-key
请求方式   POST
请求模板   {"query":"{{query_json}}","count":{{count}}}
响应字段   results / title / url / snippet
```

读取那半边填 `http://127.0.0.1:18900/v1/read`，模板 `{"url":"{{raw_url}}"}`，字段 `text` / `title`。
MCP 客户端填 URL `http://127.0.0.1:18900/mcp`，请求头带 `Authorization: Bearer ofm-local-key`。

**默认关闭**（`settings.json` 的 `webSearch.enabled`），关闭时三个出口都回 503；
开关在 App 底栏「搜索」页（M36 起是一级 dock 项，不再从设置页进）。

**App 里为什么没有「自定义搜索 / 自定义读取」输入框**：那两个框是第三方客户端自己的设置页里的东西，
用户在那里填本机地址即可。我们在自己 App 里再做一份，只会让人以为要填本机 `/v1/search`，
填进去就是「服务调用自己」——实测表现为「自定义 鉴权失败，已改用 Bing」（没填 Key）或递归（填了 Key）。
现在「搜索」页只做三件事：开关、给出「第三方该填什么」（可一键复制）、试搜/试读。
`custom` 引擎能力保留（老配置继续生效），但地址指向本机时会自动从回退链里摘掉，不产生噪音。

**回退链**（顺序可调、可单独关）：`custom → bing → keenable → exa → parallel → anysearch`。
前两个覆盖绝大多数场景；`note` 会写明「谁挂了、现在用的是谁」，客户端应原样展示。
实测（2026-11-10，国内网络）：cn.bing.com 130–220ms / 10 条，keenable 450–1030ms / 10 条，
exa 500–3200ms / 5 条，parallel 1100–2300ms / 10 条，anysearch 1.1–6.7s / 5 条，五个源 25/25 全通。
DDG、公共 SearXNG、百度/360/搜狗网页版、Brave、Jina Reader 实测不可用，未内置。

**边界**：结果一律视为不可信外部内容（MCP 返回会包 `<untrusted-web-content>`）；
`/v1/read` 拒私网 / 回环 / 云元数据；自定义接口的 Key 单独存 `credentials/web-search.json`（0600），
`GET /api/search/config` 只回尾 4 位；搜索日志只记 query 前 60 字与失败类，不记正文与 Key。



### 4.9 后台保活（为什么还要单独做）

前台服务只解决「我有权一直跑」，不解决「系统愿不愿意让我跑」。真机上被清掉通常是这三件事没做：

| 项 | 不做会怎样 | 入口 |
| --- | --- | --- |
| 电池优化白名单 | 息屏十几分钟后 Doze 掐网络，第三方调用全超时，表现成「服务挂了」 | `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` |
| 通知权限（Android 13+） | 前台服务通知不显示 → 服务被降级成普通后台服务，随手被清 | `ACTION_APP_NOTIFICATION_SETTINGS` |
| 厂商自启动 | 小米/华为/OPPO/vivo 各有各的后台限制，锁屏即清 | 各家管理页（找不到就退到应用详情） |

代码侧做实的四件事：

1. `startForeground` 带 `FOREGROUND_SERVICE_TYPE_DATA_SYNC` —— Android 14 不传会抛 `MissingForegroundServiceTypeException`；
2. `android:stopWithTask="false"` + `onTaskRemoved` 里不 `stopSelf` —— 划掉最近任务不该中断第三方的搜索；
3. `START_STICKY` 让系统在杀进程后重建，但**限流**：10 分钟内最多 3 次，防止 node 崩溃变成「重建→崩→再重建」的空转热点；
4. 首次启动弹一次引导（只在电池优化未加入时弹，记 `keepAliveAsked` 不再骚扰），设置页常驻「后台保活」状态卡，从系统设置返回自动刷新。

**做不到的事**：这些权限没有能静默授予的 API，只能引导用户点。所以不给「一键优化」的假按钮 —— 那只会让人以为已经好了。



### 4.10 界面重设计（M35）

设计方向 **「仪器台 / Instrument Panel」**。不是给默认 Material 换个蓝色，而是重定信息层级：

| 维度 | 原来 | 现在 |
| --- | --- | --- |
| 配色 | 靛蓝 + 冷灰白（标准 Material 模板） | 暖纸 `#F6F4EF` + 墨 `#1B2430` + 朱砂 `#B24A2E`；深色独立色板，朱砂提亮到 `#ED9A7C` |
| 层级 | 每块信息都装进 18dp 圆角卡片，卡片套卡片 | 首屏状态直接摊开，1px 细线分组；卡片只留给真正成组的对象 |
| 数据 | 「一行文字 + 两个按钮」 | 整行点击复制（Base URL / Key），等宽字体 + 大字重；机器字段与人读文字一眼可分 |
| 导航 | 顶栏固定写「OFM 渠道」，设置靠再点一次齿轮返回 | 顶栏显示当前页标题 + 状态芯片（含端口）；进设置页给明确「返回」（M36 起搜索页改为底栏一级页，无需返回） |
| 选中态 | 图标外一整块高亮色 | 顶部 2dp 短横线 + 淡色图标底 + 字重变化，不抢内容注意力 |

**改动范围刻意收窄**：`Theme.kt`（设计系统 + 全部共享组件）、`Screens.kt` 的 `OverviewScreen`、`MainActivity.kt` 的顶栏与底栏。
其余 6 个页面共用 `OfmCard` / `Pill` / `StatTile` / `StatusDot` / `MonoText` 与 `MaterialTheme.colorScheme`，
**自动继承新视觉，接口调用、数据绑定、业务逻辑一行未动** —— 这也是这次能大幅换脸却不回归的原因。

**可访问性**：正文对比度 ≥12:1、次级文字 ≥5.6:1、朱砂文字 ≥5.4:1（均过 WCAG AA）；
导航项 64dp、操作行 56dp、复制字段 48dp，全部 ≥44dp 触控目标；
状态胶囊带同色圆点 + 中文文案，不只靠颜色区分；字号用 `sp`，支持系统字体缩放至 200%。

**预览**：`design/M35-ui-preview.html` 是单文件可交互预览（五个页面 + 模型/积分分段 + 深浅主题切换 + 色板 / 字阶 / 规格表），
M36 的导航调整已同步进去，用浏览器直接打开即可，不用装 APK。`dist/AP.apk` 里的 dex 已确认包含新组件与首页文案。

### 4.11 导航调整（M36）

| | 之前 | 之后 |
| --- | --- | --- |
| 底栏 | 概览 / 渠道 / 模型 / 积分 / 用量 | 概览 / 渠道 / 模型 / 用量 / **搜索** |
| 网页搜索 | 设置页里的二级页，要点两次并带「返回」 | 底栏第 5 项，一次直达 |
| 模型与积分 | 各占一格，共两页 | 合并成一格，页内分段切「模型目录 / 签到积分」 |

**为什么用分段、而不是把签到区拼到模型列表下面**：`CheckinSection` 是一整块带内部状态的组件
（展开项、已加载余额、日志分页），塞进 `LazyColumn` 的 item 里滚出屏幕就会被回收，滚回来全部重置。
分段切换时它独占内容区，不参与列表复用；模型列表仍用 `LazyColumn`，长目录性能不变。
`section` 与搜索框 `query` 都用 `rememberSaveable` 提到合并页这一层：切段、旋屏、进程重建都不丢，
从签到切回模型时搜索词还在。

**顺带清掉的重复入口**：设置页原来那张「网页搜索与读取」卡片删了 —— 底栏已有直达入口，
留着就是同一功能两个地方进。搜索页顶部的「← 返回」也删了：一级 dock 页没有「返回上一层」的语义，
改成 `WEB SEARCH / READ` 刻度标签 + 带圆点的状态胶囊，和仪器台其它页面的分组条一致。
顶栏标题用完整页名「网页搜索与读取」，底栏标签用短名「搜索」，其余四项两者一致。

### 4.12 模型页滚动闪退（M38）

现象：模型目录一直下滑会闪退。没有真机 logcat 时不能 100% 钉死堆栈，所以按代码里**确凿存在的四个放大器**逐一收口，并补上可观测能力。

| 放大器 | 为什么「一直下滑」才炸 | 修法 |
| --- | --- | --- |
| `refresh()` 每 1.5s 无条件把 `models` 换成全新 List；`data` 为 null 时直接置空 | fling 动画期间每 1.5s 触发全列表重组；item 数在 0 与 N 之间抖，`LazyListState` 滚动位置反复越界 | 结构相等就不赋值；拿不到 `data` 时保留上一份目录（`modelsHint` 仍更新）；轮询降到 3s |
| `OutlinedTextField` 放在 `LazyColumn` 的 `item{}` 里 | 滚出屏幕即被回收，焦点与软键盘状态在 fling 中反复 dispose/recreate，Compose 明确不推荐 | 标题 / 提示 / 搜索框移到列表外固定区；顺带让搜索框常驻，长目录改关键词不用滚回顶部 |
| `listAll()` 不去重、展示字段无长度上限；`items(key = { it.id })` 直接用上游 id | 重复 key 让滚动位置恢复错乱；超长脏串只在滚到那一条时才组合，`StaticLayout` 撑爆内存 | 服务端按 id 去重、过滤无 id 脏条目、`display_name`/`provider_name` 限 120/24 字、档位限 12；App 端 `ModelItem` 再截断并 `distinctBy { it.id }` |
| 签到结果整段日志 `joinToString("\n")` 塞进单个 `Text` | 合并页切到「签到积分」后，超长文本在 `Column.verticalScroll` 里一次性排版 | 限 60 行 / 每行 200 字 / 总长 6000 |

**还留了后手**：`CrashHandler` 在 `MainActivity.onCreate` 注册全局未捕获异常处理器，先把完整堆栈写到 `filesDir/crash/crash-*.txt`（只留最近 5 份、纯本地、不含正文与凭据），再交给系统默认处理器。设置页在真的崩过之后会出现「最近一次崩溃」卡片，一键复制完整堆栈 —— 万一还有残留问题，这一次就能定位，不用再靠猜。

---

## 5. 渠道实现要点

| 渠道 | 登录 | 推理协议 | 关键坑（都写在代码注释里） |
| --- | --- | --- | --- |
| TRAE | 本地回调（18 个参数） | 自定义 SSE | `auth_callback_url` 参数名不能改；`function` 必须与模型所属通道一致；`tools.parameters` 要序列化成字符串；末帧要补处理 |
| Qoder / CN | 设备码 + PKCE | WASM 加密 | `getRandomValues` 两个 import 方向相反；返回值布局两套；`requestresult_url(栈, ptr)` 参数反直觉；`business` 必填；`code` 要保真转发 |
| Cline | WorkOS 设备码 | OpenAI | `access_token` 必须保留 `workos:` 前缀；`slow_down` 要真累积退避 |
| LobsterAI | 本地回调 + authCode | OpenAI | 目录必须带 `X-LobsterAI-Client-Capabilities`，否则永久缺 kimi-k3 |
| Loomy | 短信验证码 | OpenAI | HMAC-SHA1 九段签名，末尾两段空串；聊天要同时发 Bearer 与小写 `token` 头 |
| Raccoon | 微信扫码 | OpenAI | 任何异常都降级 pending；思考开关要放 `extra_body` |
| MiniMax | 设备码 + PKCE | Anthropic | pending 可能是 200 + `status:"pending"`；token 不是 JWT |
| ZCode | 设备授权 | Anthropic | `device_mid` 必须持久化；Anthropic 头集逐字 |

通用约定：`expires_at - now < 60s` 时静默续期；传输失败不判终态；只有 401/403 + 明确
auth 码才标记「需重新登录」；无账号的 provider 返回空模型列表而不是抛错。

---

## 6. Android 构建

### 6.1 前置

| 项 | 版本 | 说明 |
| --- | --- | --- |
| JDK | 17 | AGP 8.5 要求；JDK 21/20 会报 unsupported class file |
| Android SDK | platform 34 + build-tools 34.0.0 | `compileSdk 34` |
| NDK | 26.1.10909125 | 只用于编译 JNI 桥接层 |
| Gradle | 8.7 | 仓库自带 `gradlew` |
| `libnode.so` | nodejs-mobile 18.20.4 | 见 6.2 |

### 6.2 两个绕不开的坑（已在本仓库解决）

**坑 1：`com.janeasystems:nodejs-mobile-gradle` 已经不存在了。**
它只发布在已关闭的 JCenter，Maven Central 和 Google Maven 都返回 404，
`apply plugin` 一行会让构建直接死在依赖解析。本仓库已删掉该插件。

**坑 2：`libnode.so` 只导出 C++ 符号，没有 Java 桥接。**
npm 上的 `nodejs-mobile-react-native` 只带 `libnode.so`（`node::Start(int,char**)`
是 C++ mangled 符号），官方的 `NodeJS.java` 并不在包里，也无从 Maven 获取。
所以本仓库自己写了一个 JNI 层：

- `android/app/src/main/cpp/ofm_node.cpp`：把 `String[]` 转成 `char**`，
  `chdir` 到 `filesDir`、`setenv OFM_DATA_DIR`，再调 `node::Start`；
- `NativeNode.kt`：按 `c++_shared` → `node` → `ofmnode` 的顺序 `System.loadLibrary`；
- `libofmnode.so` 的 `DT_NEEDED` 里有 `libnode.so`，链接器负责解析，不依赖进程全局符号表。

`libnode.so` 的 `NEEDED` 含 `libc++_shared.so`，而 Android 系统**不提供**这个库，
必须一起打进 APK —— 漏了会在 `dlopen` 阶段直接失败。

### 6.3 步骤

```bash
# 1) 取预编译 libnode.so（从 npm 包解出，不依赖 GitHub Release）
node tools/fetch-libnode.mjs arm64-v8a

# 2) 编译 JNI 桥接层（需要 NDK）
ANDROID_NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125 ./tools/build-native.sh

# 3) 同步 Node 工程到 assets（每次改 core/ 都要重跑）
node tools/sync-assets.mjs

# 4) 打包
cd android && ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` 里的 `sdk.dir` 指向本机 SDK；`gradle-wrapper.properties` 的
`distributionUrl` 用的是华为云镜像（官方源在国内常超时），需要时改回
`https://services.gradle.org/distributions/gradle-8.7-bin.zip` 即可。

### 6.4 已验证 / 未验证

**已验证**（本仓库的实际构建记录）：

- `assembleDebug` 通过，产出 25 MB APK，debug 签名，`minSdk 26 / targetSdk 34`；
- APK 内含 `lib/arm64-v8a/{libnode.so, libofmnode.so, libc++_shared.so}` 三件套；
- `libofmnode.so` 的导出符号为 `Java_com_ofm_client_NativeNode_startNode`，
  未定义符号 `_ZN4node5StartEiPPc` 由 `libnode.so` 提供（链接期 `--no-undefined` 通过，
  说明 C++ 签名确实对得上）；
- `assets/nodejs-project` 与 `core/` 逐文件比对一致（防止改了 JS 忘了同步）。

**未验证**：

- **没有真机/模拟器跑过**。构建环境无 `/dev/kvm`，x86_64 模拟器起不来；
  arm64 镜像又只能在 arm64 主机上跑。所以「装上去能不能活」这一步需要你在真机上确认，
  第一眼看 `adb logcat -s ofm-node`（桥接层会打印 `chdir`、`OFM_DATA_DIR`、
  `node::Start(argc=…)` 与退出码）。
- 所有渠道都没有真实账号联调（见 §1）。

### 6.5 运行时结构

- `ApiService` 前台服务：拷贝 assets → `NativeNode.startNode` → 监控 `runtime.json`；
- `MainActivity`：开关、端口、Key 复制、渠道列表、账号列表；
- `LoginWebViewActivity`：承载授权页，拦 `http://127.0.0.1:18080/...` 回调后交给 Node；
  也支持把回调链接整条粘贴回来（TRAE 的原生设计）。
- 设备码类（Qoder / Cline / MiniMax / ZCode）直接开浏览器 + App 内轮询。

### 6.6 用系统默认浏览器登录（默认开启）

渠道的 `auth_callback_url` 写死是 `http://127.0.0.1:18080/authorize`。手机浏览器访问
`127.0.0.1` 访问的是**手机自己**，所以只要 App 在这个端口上接住，就不需要内嵌 WebView：

1. App 点「连接」→ `POST /api/accounts` 拿到 `loginUrl` →
   `POST /api/login/browser-target` 登记 accountId → `ACTION_VIEW` 交给默认浏览器；
2. 授权完成，浏览器跳 `127.0.0.1:18080/authorize?code=…&state=…`；
3. `browser-callback.js` 接住完整 URL → `logins.completeCallback` 换 token → 返回提示页，
   页面上有 `ofm://login/done` 链接可一键跳回 App；
4. App 侧同时在轮询 `/api/login/poll`，done 后自动刷新账号列表。

界面「渠道」标题右侧有开关：关掉就回到内嵌 WebView 流程（并保留手动粘贴回调链接的兜底）。
几个注意点：

- 18080 只监听回环，且随服务一起启停（不关会在二次启动时残留）；
- `browser-target` 有 10 分钟 TTL，过期后会退化为「取最近的 callback 会话」；
- 浏览器顺带请求的 `/favicon.ico` 返回 204，不会误触发换 token；
- 登录期间前台服务必须活着，否则 18080 没人监听，浏览器会显示连接失败。

#### 回调打不开 / `net::ERR_CONNECTION_REFUSED`

`auth_callback_url` 是 `http://127.0.0.1:18080/authorize`，只要当时 18080 没人监听，
浏览器就会报这个错。常见三种情况：

| 情况 | 为什么 |
| --- | --- |
| 授权是在**电脑浏览器**完成的 | 电脑的 `127.0.0.1` 是电脑，不是手机，端口永远连不上 |
| App 切到后台被系统回收 | Node 停了，18080 自然没了 |
| 18080 被占 / 监听失败 | 端口没起来（现在会重试 3 次，状态写进 `/api/status.callback`） |

**但授权其实已经成功了** —— 浏览器地址栏那条 `127.0.0.1:18080/authorize?…` 里
就带着 `refreshToken` / `userJwt` / `userInfo`，把它送回 App 就能换 token，
不需要那个端口能连通：

1. 在 App「渠道」上方点 **「粘贴回调链接完成登录」**（打开时自动读剪贴板预填）；
2. 粘贴整条链接（也可只粘 `?refreshToken=…` 起的 query），点「完成登录」；
3. `POST /api/login/complete` → 自动匹配最近一次 callback 会话 →
   `logins.completeCallback` → 账号落库，界面刷新。

要点：

- `parseCallbackQuery` 只用 `new URL()` 取 query，**不校验 host**，所以从电脑浏览器复制、
  经聊天转发到手机的链接同样有效；只要带 `refreshToken` 就能完成，缺 `userInfo` 只影响昵称。
- 会话在 Node 内存里，App 被杀后会失效 —— 接口会明确提示「请重新点『连接』」，
  重新发起后再粘贴即可（换 token 只用链接里的 refreshToken，不依赖旧会话参数）。
- **不重装 APK 也能用**：关掉「系统浏览器登录」开关，重新点「连接」走内嵌 WebView，
  授权页顶部就有粘贴框（`LoginWebViewActivity`），粘进去点「提交」。
- 链接里含 refreshToken / userJwt，属于账号凭据：别转发给别人；日志与错误响应都不打印它。

### 6.7 签到 / 领取积分

在已跑通的本机服务上增量加了 4 个管理端点（见 §4），App 界面底部多一个「签到 / 领取积分」区块。

**余额显示**：区块顶部有「余额总览」卡，进入页面就自动把所有「有余额能力」的渠道
拉一遍（以前要点开每个渠道的「查看状态 / 余额」才发请求，看着像没显示）。
按 `token` / `积分` 两桶分别求和，绝不跨单位相加；`quotaOnly`（配额 %）和查询失败的
账号不计入，也不显示成 0。各渠道「临时 / 长期」资源包明细仍在下方展开里看，
总览卡上有「刷新」按钮。

**哪些渠道真的有签到**（判据来自上游 `channel-pack-rpc.ts` 的 `credits.claimAll` 分支逐渠道实读，
不是「有没有 `/api/` 前缀」）：

| provider | 能力 | 自动签到 |
| --- | --- | --- |
| `trae` / `qoder` / `qodercn` / `lobsterai` / `minimax` / `loomy` | 每日签到 + 余额 | ✅ |
| `zcode` | 每日 plan 领取（token），但需网页 captcha | ❌ **排除**，只能手动 |
| `raccoon` | 一次性「桌面端登录奖励」；每日 300 是服务端自动发 | — 属新手任务，不给签到按钮 |
| `cline` / `gemini` / `opencode` | 无签到；Gemini 只有 5h/周配额窗口（**不是积分**） | ❌ |

**几条会造成真实损失的语义，代码里逐条钉死**：

- `coversToday`（缺省 true）：Qoder 活动每日 **10:00（UTC+8）** 才刷新，上午 9 点看到的
  `CLAIMED` 属于昨天。刷新前一律 `todayCheckedIn:false`、结果带 `coversToday:false`，
  且该轮**不记** `lastDate`，否则当天新额度整天漏领。
- `actionRequired`：只认这个显式标记，UI 单独红条展示，不靠「message 是否非空」去猜。
- `totalByUnit` 两个键恒存在：ZCode 发 token（一次 1 亿），其余是积分。
  展示走 `formatClaimGains`（token 压缩 M/K、积分保留两位小数不压缩），
  **绝不把 1 亿 token 与 100 积分相加**。
- `CreditBalance.total` = 各有效包本周期剩余之和；到期判断只用 `deductionEndTime`
  （`expiredTime` 在包有效时是空串）；`null`（查不到）与 `0`（用光）严格区分，
  查不到时显示原因而不是 0。
- 逐账号**顺序**执行，单账号凭据损坏 / 网络失败只让该账号记 failed，不中断整批。

**自动签到**（`auto-checkin.json` 独立文件，原子写）：

- `enabled !== false` 判定（旧文档 / 脏数据按打开）；首次启动说明写在界面上。
- 启动延迟 30s（`0` 合法，环境变量 `OFM_AUTO_CHECKIN_DELAY_MS`）、跨天巡检 2.5h、
  失败退避下限 1h、在飞 `inflight` 去重。
- 排除表（zcode）在**调用之前**生效，不是等它返回错误再判。
- 记账判据只有 `totals.coversToday > 0`：断网、凭据没续上、抢在刷新前，
  一律不写 `lastDate`，下次启动 / 巡检退避后重试。
- `dismissedRunAt` 存那一轮的 `lastAt`（不是布尔），新一轮跑完状态文字自动回来。
- 手动结果与自动状态文字**语义分离**：前者 6 秒自动消失，后者常驻到用户手动关闭。

**Android 上的保守降级（Pluggable，不自造数据）**：

- Qoder 的 `Cosy-MachineToken` / `Cosy-MachineType` 来自官方客户端 UMID，Android 拿不到。
  App 的「签到 / 领取积分」区块里有「Qoder 设备头（可选）」设置项，可手工粘贴
  （写到 `settings.json` 的 `credits.qoderMachine`，也能清空）。没配置就照常发请求、
  只是不带这两个头，UI 显示「未下发可领活动」而不是「今天已领」；provider 每次
  `getSettings()` 现取最新配置，改完立刻生效，不用重启。
- ZCode 的阿里云 captcha 需要 headful 浏览器与真实 origin，Android 上不注入
  `mintCaptcha` 时明确返回 `inactive + actionRequired`，提示去桌面端领取，**不假装成功**。
- 日志不打印 token / refresh_token / captcha param，只打 provider、账号 id、错误码与短文案。

`node core/test/checkin.mjs` 用纯 mock 跑完说明书 §6 的 14 条验收（共 148 项断言），
覆盖 09:30 Qoder、TRAE 补查、Loomy 只读、MiniMax 800、ZCode 3012 短路、
断网不记日期、跨天巡检、单位不相加等。

---

## 7. 已处理的「血泪点」

1. **工具调用 index 重排**：上游 index 是「块序号」，思考/正文会占号，客户端按 index
   累加会得到稀疏数组 → 本实现统一从 0 连续编号。
2. **末帧丢失**：SSE 结束时 buffer 里可能残留最后一帧（无结尾空行），收尾必须再走一遍，
   否则 `finish_reason` 与 usage 全丢。
3. **形状嗅探**：网关会用 `application/json` 返回整段 SSE，不能只看 content-type。
4. **排队错误**：`10605` 必须按服务端给的精确延迟等待（约 30s），通用快退避永远等不到。
5. **Qoder 信封**：内层 `body` 未加密，按 JSON 结构分类，`body:null` 是心跳不是错误。
6. **Anthropic thinking**：客户端没请求 `thinking` 时不下发 thinking 块。
7. **二次启动连不上 127.0.0.1**：三个原因叠加 ——
   `onStartCommand` 用 `nodeThread == null` 判断（线程跑完了引用还在，不重启 node）、
   上次遗留的 `runtime.json` 让界面在 node 起来前就按旧端口/旧 `uiToken` 发请求、
   `uiToken` 每次 `createApp` 都随机但 monitor 只在端口变化时才更新。
   现在改为：`isAlive` 判断 + 启动时删旧 runtime.json + monitor 全字段刷新 +
   固定 18900 端口（早期版本把降级随机端口写回 settings 造成端口漂移）+
   node 退出就结束整个进程（V8 不能在同一进程二次初始化）。
8. **签到汇总把 token 和积分相加**：ZCode 一次 1 亿 token，其余渠道给积分，
   `totalCredit` 求和会显示 `100000100 积分`。改为 `totalByUnit` 双键恒存在 +
   `formatClaimGains` 按单位分别带 `+`，展示路径不再读 `totalCredit`。
9. **Qoder 上午 9 点显示「今天已领」**：活动 10:00（UTC+8）刷新，之前看到的
   `CLAIMED` 是昨天。用 `coversToday:false` 标出「非今日轮次」，且该轮不记 `lastDate`。
10. **TRAE 领取成功显示 `+0 积分`**：`claim` 响应只有 `{code:0}`，不含数额。
    领取成功后补查一次 `status.credits`（实测 150）；同时靠状态预检拦住「今天已签」，
    避免发出无法与真领取区分的幂等 claim 请求。
11. **Loomy 打开面板意外触发签到**：余额只读走 `points/records`，绝不碰写端点
    `points/first-login`；`dailyQuota` 只在 first-login 响应里，不硬编码 5000。
12. **MiniMax 余额读成记录条数**：`total_count` 是 `details[]` 的长度（实测 1），
    真实余额是字符串 `remaining_amount`（`"800.00"`）；且 `points` 已含
    `bonus_points`，相加会虚高一倍。
13. **自动签到静默漏领**：断网 / 凭据没续上 / 全被跳过时若写 `lastDate`，
    当天就再也不会重试。判据收敛成 `coversToday > 0`，并补跨天巡检
    （进程常驻多天时，启动补跑覆盖不到过零点）。
14. **ZCode 多 plan 汇总错误**：provider 返回 `{kind:'_multi', outcomes}`，
    直接在 collect 层展开成逐条供汇总、合并成单条供 UI 展示；否则整个包裹会被计成 failed。
    3012 风控必须给「请勿连续重试」并短路后续 plan。
15. **浏览器回调 `ERR_CONNECTION_REFUSED`**：`auth_callback_url` 指向手机的 18080，
    但授权常在**电脑浏览器**完成（电脑的 127.0.0.1 不是手机），或 App 切后台被回收、
    端口被占用，用户直接看到「网页无法加载」。早期把 18080 的 `error` 事件只打一条
    warn 就继续，界面毫不知情。现在：监听失败重试 3 次、状态写进
    `/api/status.callback` 并在 UI 显示红字；同时提供 `/api/login/complete`
    粘贴兜底 —— URL 归一化 + 会话自动匹配，`parseCallbackQuery` 不校验 host，
    粘回来就能换 token 落库。链接含凭据，日志与错误响应都不打印内容。
16. **清数据后第三方取不到模型**：旧版首次启动随机生成 API Key，清空应用数据 /
    重装后 Key 变了，ChatBox / DSH 里配的旧 Key 全部 401。现在默认 Key 恒定
    `ofm-local-key`，可用 `OFM_API_KEY` 覆盖、也能在 App 里设自己的固定值；
    改 Key 时同步写 `runtime.json`，界面显示不会滞后。
17. **登录成功但模型列表不自动出现**：模型目录按 provider 缓存 5 分钟，
    登录落库后没有失效 / 预热，要等下次 TTL 过期或手动刷新。现在 `onAccountReady`
    主动 `invalidate()` + 异步 `listAll({force:true})`，启动 1.5s 后也预热一次；
    空列表响应带 `hint`，界面显示原因而不是一个空的「可用模型（0）」。
    另外 CORS 预检从「逐字白名单」改为 `allow-headers: *` —— 官方 SDK 带的
    `x-stainless-*` 等头否则会被浏览器拦掉。
18. **覆盖安装后新 UI 配旧 Node**：`ensureProject` 原来用写死的 `PROJECT_VERSION
    = "0.1.0"` 判断要不要重拷 assets，改了 JS 但没改版本号 → App 私有目录里
    仍是旧 `server.js`，出现「未知管理接口 /api/xxx」。清空应用数据能绕过，
    但会丢账号。现在 `sync-assets.mjs` 把所有文件内容算成 SHA256 指纹写进
    `version.txt`，Kotlin 端比较 APK 内置指纹与本地标记，不一致就重新解包，
    既保住 `data/`，也不用再手动清数据。
19. **余额看着像没实现**：余额请求原本只在点开某个渠道的展开时才发，
    默认全收起 → 界面上一个数字都没有。现在进页面自动加载所有有余额能力的
    渠道，并在顶部汇总展示（token / 积分分桶，配额与失败项不计入）。
20. **连接 TRAE 后不显示模型**：协议与上游逐项一致，问题只在「远端目录拉取失败
    之后」。上游失败时回退静态兜底表（选择器不为空），旧版工程直接返回 `[]`
    且把错误吞掉，于是在 Android 上（TLS/DNS/5xx/401 都可能触发）界面全空、
    连原因都看不到。现在 batch → 单通道 → 28 条兜底表三级降级，
    `/v1/models` 与 `/api/models` 附 `diagnostics`（含脱敏失败原因），
    App 显示兜底提示并提供「重新拉取」。注意兜底只保证列表不空，
    真要对话仍得凭据和网络都正常。
21. **远端拉取失败 + 余额查询失败同时出现**：看着像两个渠道各自坏了，其实是
    同一个 `https.request` 出站链路。Android 的 `network_security_config`
    只管 Java 层，内嵌 Node 用自己的 OpenSSL 又读不到系统 CA，所有 HTTPS 都
    会 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`；再加上错误被固定文案吞掉，界面上
    连「没网」还是「证书」都分不清。现在把 `cacert.pem` 打进 assets 与内置
    根证书合并后显式传 `ca`，错误码翻成中文并透到 `hint` / 余额错误里，
    App 加「网络自检」按 DNS → TCP → TLS → HTTPS 分层定位。
22. **自检「全通过」却仍不显示模型 / 余额**：自检只发不带凭据的 `GET /`，
    `HTTP 404` 是根路径正常回包，说明网络通，但不代表带凭据的业务 POST 能过。
    默认目标早期只有 3 个，还漏了 `api.trae.com.cn`（换 token 走的独立域名），
    登录可达性根本没测；更关键的是「清过数据后没有可用账号」这一整类原因
    和网络无关，自检完全看不见。现在补成 4 个目标，并把账号/凭据体检并进
    同一次自检 —— 点一下同时排除「网络」与「账号」两个变量，报告末尾直接
    给出「请先连接渠道」或「401 重新登录」这类结论。
23. **体检报 `incomplete` 缺 `machine_id` / `device_id`，token 却还剩 336h**：
    网络四层全通、证书 265 张都正常，说明不是网络，是**凭据结构**坏了。
    根因在登录链路的 session 契约：各渠道 `login.start()` 返回的是
    `{ loginUrl, session, instructions }` 包装层，而 `login-manager` 把这个
    **外层对象整体**存成 session 并原样传给 `poll` / `complete`；可
    `completeLogin()` 读的是 `session.machineId` / `session.deviceId`（藏在内层），
    于是落库时是 `undefined`，被 `JSON.stringify` 直接省略，凭据永久缺字段。
    模型目录的请求头 `x-machine-id: undefined` 发不出去 → 远端拉取失败；
    Qoder 的 `nonce` / `verifier`、LobsterAI 的 `state` 也同理读不到
    （设备码渠道的轮询和 state 校验其实是坏的，只是没被联调发现）。
    修法分两层：`login-manager.start()` 统一把 `{...内层, ...外层}` 摊平成
    单个 session 对象（渠道把 `result` / `lastPoll` 挂在传入对象上，摊平后仍是
    同一引用，行为自洽）；再加 `credential-repair.js` 给**存量账号**按 uid
    确定性派生补齐这两个设备标识并写回 —— 它们是客户端自造的 hex32，
    上游还会按 generation 轮换（说明服务端不绑定登录时那个值），签到/余额
    更是完全由 uid 派生、与它们无关，所以本地补齐安全且**无需重新登录**
    （默认浏览器回调本来就难连，让用户重登代价太高）。启动与自检各跑一次，
    幂等、纯本地、只补缺失字段、绝不动 token / uid；`uid` 也缺就不编造，
    如实提示重新连接。报告末尾新增「凭据自愈」一行告知结果。
24. **第三方接入 API 发消息没任何回复**：网络、账号、模型目录都正常，
    但对话转发链路此前从没在真机上跑过。真跑起来才发现「静默」才是最大
    的坑：`TraeChannel.stream()` 只认 `event: output`，上游回标准 OpenAI
    `data:` 帧 / 不带 event 行 / 换 event 名 / `200 + JSON` 业务错误 /
    整段完成体时，解析层一个正文都不产出，而 `chatStream` 会把它当成
    **正常结束**，本机 API 老老实实回 `200 + content:''`。第三方 SDK
    拿到空字符串就是一片空白，连个错误都没有；流式路径更糟 —— catch
    里只写裸 `data: {"error":…}`，严格解析 `choices[0].delta` 的客户端
    会直接忽略这帧。再加上整条链路一行日志都没有，用户除了「无回复」
    什么也给不出来。修法不是猜上游格式，而是**让沉默变得不可能**：
    零正文一律抛 `EMPTY_REPLY` 并把帧数/状态带出来；流式错误同时以
    assistant 正文下发；首块嗅探 + 5 种帧形状兜底；心跳帧不再给空闲
    计时续命；最后加一次「对话自检」把选号到上游原始样本逐层摊开。
    排障顺序也从此固定：先网络自检排网络与账号，再对话自检排协议与上游。

25. **自检报「HTTP 200、收到 1 帧、有效帧 0」，样本只有一帧 `event:metadata`**：
    这是上一条没修透的总根因，也是最难看见的一类 bug —— **错误不在协议，在
    循环条件**。`iterateSse()` 里写的是
    `while ((idx = findEventBoundary(buffer)) >= 0)`，而该函数返回的是
    `{start, end}` **对象**；对象与数字比较走 `ToPrimitive` → `NaN` → 恒为
    `false`。于是循环一次都不执行，整条流只在连接结束时被当成「一帧」解析：
    多个 `event:` 被合并成最后一个事件名，`data:` 全部拼在一起，
    `JSON.parse` 必然失败 → 零正文。之前六种形状的手工测试全是**单帧文本**，
    恰好绕过了这个分支，所以一直「测得过」。真机上游把
    `metadata / output / token_usage / done` 塞进同一个 TCP 包，立刻全灭。
    修法只有一行（`idx !== -1`），但配套加了两道保险：输出额度按模型
    `model_detail_list[].max_tokens` 收敛（默认 32000，不再无脑 64000 ——
    超限时 TRAE 同样是「建会话 → 只发 metadata → 断流」），以及零正文时
    换一个更保守的额度**自动重试一次**（新会话；首帧之前缓冲，绝不把
    finish 提前发给客户端）。教训：**判断「有没有解析出东西」的测试，必须
    用同一 chunk 里的多帧数据**，单帧只能证明 JSON 解析没问题。

26. **余额「显示」了，但看不出还剩多少**：`balance.total` 本来就是「各包
    remaining 之和」，UI 却直接把它当一个大数字铺出来，没有单位说明、没有
    总量、没有已用比例 —— 用户看到「1000 积分」，分不清这是剩余、总额还是
    今天领的。真机上这是最容易被误解的一类「功能缺失」：数据没错，缺的是
    **口径**。修法分两层：Node 侧在 `/api/checkin/balances` 给每个账号补
    `limitTotal` / `usedTotal`（各包 `total` / `used` 之和，只给 remaining
    的渠道用差值兜底，`NaN` 一律不落库）；Android 侧统一成
    「剩余 X · 共 Y · 已用 Z（p%）」，总览按 token / 积分分桶累加，再加一
    行逐账号明细（总数看不出是哪家还剩多少），每个资源包配一条已用进度条。
    纪律不变：**null 与 0 严格区分**（查不到不写 `limitTotal`，绝不编 0），
    配额类渠道（百分比窗口）不套「共 / 已用」语义。

27. **同一个渠道，签到正常、余额报「非 JSON 响应」**：`TraeProvider` 的
    签到请求头照抄官方客户端，带 `Accept-Encoding: gzip, deflate`；
    而 `openUpstream()` 的默认头是 `identity`，被这份头覆盖。问题在于
    `readAll()` 只做 `Buffer.concat().toString('utf8')` —— **内嵌 Node 没有
    fetch，没有任何一层会解压**。于是：签到响应几百字节，网关不压缩，正常；
    余额响应带整份用量明细，网关压缩，`JSON.parse` 拿到的是二进制，报
    「非 JSON 响应」。更隐蔽的是我们把这个错误简化成了一句固定文案，
    连 content-type 和响应样本都丢了，真机上只能看到
    `137******62：非 JSON 响应`。修法：`decodeBody()` 按
    `content-encoding` 解 gzip / deflate（含裸 deflate）/ br，网关漏发头时
    按 `1f 8b` 魔数嗅探，解压失败原样返回；错误文案补上
    「HTTP 状态 / content-type / 字符数 / 前 60 字样本」。教训：**只要自己
    拼 HTTP 头，就必须自己实现 fetch 的那部分语义**（解压、重定向、cookie），
    否则「同一个渠道一半接口能用」这种分裂现象永远查不到根。

28. **模型列表没有积分倍率**：倍率在 `display_contact_config` 里，而它**是一个
    JSON 字符串**（`"{\"consumption_rate\":{\"enable\":true,\"data\":{\"rate\":0.08}}}"`），
    直接读 `entry.display_contact_config.consumption_rate` 永远是 `undefined`，
    必须二次 `JSON.parse`。三条判据缺一不可：`enable !== false`（显式关闭要
    当成「不显示」而不是 0）、`rate` 是有限数、**`rate: 0` 是合法值**（免费
    模型）—— 用 `> 0` 过滤恰好会把用户最关心的免费模型全漏掉。活动折扣同理：
    `enable: true` 不代表有折扣，实测 `discount_type: "none"` 且
    `before === after` 很常见，照显示就成了「×0.13→×0.13」；还要判断
    `end_at` 未过期，否则用户按折扣价预期、实际被按原价计费。解析失败一律
    返回 `undefined` —— **宁可只显示模型名，也不编造倍率**。

29. **AI 无法正常使用工具（function calling）**：三个独立断点叠在一起，
    每个都会让客户端只拿到「空参数的工具调用」或「根本没有调用」：
    1）**分片归并只看 id**。OpenAI / TRAE 的流式工具调用是首片带 `id` +
       `function.name`，后续片只有 `index` + 参数增量。旧逻辑
       `const index = id ? map.get(id) : 新建` —— 后续片没有 id，于是每片都
       新建一个调用，一个工具被拆成 N 个空参数调用，客户端按 index 渲染出
       一串无名工具，模型侧自然「用不了工具」。修法：**以 `index` 为第一
       优先级**，其次 id，最后归到最近打开的调用；同时保留「上游 index →
       本地连续 index」映射，避免稀疏数组。
    2）**`partial_arguments` 被删掉**。`normalizeToolCall` 里原来
       `delete function.partial_arguments`，却没用它补 `arguments`，等于把
       参数整段扔掉。修法：`arguments` 为空/累计值时用 partial 拼接。
    3）**累计参数原样转发**。有的上游每帧发全量 `arguments`，原样转发会让
       客户端拼出 `{"a":1}{"a":1}`，JSON 解析失败、工具作废。修法：记录每个
       index 已下发的累计值，若新值是它的前缀超集就只发增量。
    另外两处配套修复：`messages[].content` **必须是内容块数组**，任何一条消息
    发字符串都会整单 400（实测：`json: cannot unmarshal string into Go struct
    field LLMRawMessage.messages.content of type idecopilot.LLMRawMessageContent`
    —— 上游 Go 侧把它定义成 `LLMRawMessageContent`，tool 结果也只是「内容为
    纯文本的数组」，不是 OpenAI 那种字符串）；`openai-compat.js` 的 SSE 分帧
    把 `{start,end}` 与 `0` 比较（`boundary < 0` 恒 false），循环不退出、整条流
    原地空转 —— 与 M15 的 `idx !== -1` 是同一个坑的副本，非 TRAE 渠道的多帧
    工具调用必现。最后把上游 `done` 帧常报的 `finish_reason: stop` 在有工具
    调用时纠正成 `tool_calls`（Anthropic 侧对应 `stop_reason: tool_use`），
    否则 Claude Code 会停在工具调用前不执行。

30. **MiniMax Code 拉不到模型，界面却一片空白**：`/mavis/api/v1/models` 是
    **公开配置接口**（不带 token 也返回 200），响应是
    `providers[].config.models` —— 一个**字典**，key 才是模型 id，值为
    `{ name, limit:{context,output}, modalities, reasoning }`。旧版按
    `res.json.data.models` 数组解析，三个候选全是 undefined → 返回 `[]`，
    HTTP 200、无异常、无日志，界面只显示「还没有模型」，极难定位。
    修法：`parseModelsResponse` 同时认字典 / 数组 / 旧扁平形状、按
    `model_order` 排序；**认不出就抛错并带上响应样本**，不再静默空列表；
    失败时回退静态目录并把脱敏原因挂到 `lastModelWarning`，界面显示
    「兜底目录（远端拉取失败：…）」。另外该目录不需要凭据，给渠道声明
    `publicModels` 让聚合层跳过取 token，避免 token 过期 / 续期失败连带拉不到模型。

31. **讯飞短信登录「无法发送验证码」：签名串算对了，头却少发一个**：
    `account.xfinfr.com` 的账号域用 9 行 HMAC-SHA1 规范串，第 4 行是
    `Content-MD5`。旧版 `signedHeaders` 把 `contentMd5` 算进签名，却**没有把
    `Content-MD5` 作为请求头发出去** —— 服务端是**按收到的头**重建规范串
    （不是自己重算 body），取到空串 → 恒 401
    `{"message":"HMAC signature does not match"}`。`sendMsgCode` 与
    `checkCode` 共用 `signedPost`，所以整条短信登录从第一步就死。
    两条错误指纹要分清：`does not match` = 密钥认识、规范串错；
    `cannot be verified` = AK 不被认识（环境/密钥错）。对照
    `loomy2api` 的 `signer.py` 才发现它显式发了 `Content-MD5`。
    实测：无该头 401，补上后 `sendMsgCode` 返回 200 + `msgid`。
    顺带补齐同渠道另外两处：`/chat/completions` 必须带
    `traceparent: 00-<32hex>-<16hex>-01`（缺了上游挂到超时）与
    `loomy-version`（仅检查存在）；`/models` 以前恒发 `token: 'unused'`，
    上游回 `code=100002 缺少 token` 但仍是 HTTP 200，于是永远走兜底目录，
    改成带真实 session。`note` 里「90 天免重登」也与实际 14 天对不上，已订正。

32. **「App 里能看到渠道名，第三方列表里还是 `trae/xxx`」**：渠道名一开始画在
    Compose 界面上，只是 UI 渲染，第三方拿到的 `/v1/models` 数据里根本没有。
    而标准 OpenAI 客户端（ChatBox / SDK）**只显示 `id`**，不认 `display_name`，
    于是追加字段没用，必须把渠道名写进 `id`。但 `id` 同时是路由用的
    `provider/model`，直接改成 `[TRAE]/xxx` 会让 `splitModelId` 找不到渠道 →
    请求 400。解法是「装饰 + 反解」成对出现：`/v1/models` 输出
    `[渠道名] :: provider/model`，`chatStream` 入口先 `resolveModelId()` 还原；
    旧客户端传真实 id 时没有分隔符，原样放行。只改一半（只装饰不反解）
    会让模型列表变好看、对话全挂，务必三种协议入口都端到端验一遍。

33. **「思考档位只对 TRAE 有效」**：档位解析原本写在 `channels/trae/models.js` 里，
    `dispatch.listAll()` 也只读 `m.reasoningOptions` 这一个字段名。结果 Qoder 目录回的是
    `efforts`、MiniMax 回的是 `effort_options`，两者都在 `listAll` 被静默丢掉，
    App 只能显示通用的 `low / medium / high`，用户看到的是「这模型没有档位」。
    教训是**跨渠道的能力字段不能各写一份解析、也不能只认一种命名**——上游各家叫法
    不统一是常态。改法是把归一化抽成 `reasoning-options.js`（字符串 / 数组 / 字典都吃，
    `value` 与 `label` 多字段回退），`listAll` 依次尝试四种字段名。另外 `label` 不要做
    `toLowerCase` 或首字母大写之类的「美化」，`Extra Light` 这类带空格的原始标签才是
    用户在上游看到的写法，改了反而对不上。

34. **「模型列表两行都带渠道名」**：多数第三方客户端把 `/v1/models` 的 `display_name` 渲染成
    第一行、`id` 渲染成第二行。M28 为了让「只显示 id 的客户端」看见渠道，把渠道名同时写进了
    两个字段，于是实际显示成 `[TRAE] Seed-Code` + `[TRAE] :: trae/Doubao-Seed-Code`——
    渠道名出现两次，第二行还拖着 `::` 和 `provider/`。**永远别假设客户端只读一个字段**；
    正确分工是 `id` 承担路由（保持 `provider/model` 原始值），`display_name` 承担给人看的名字。
    想兼顾「只显示 id」的客户端，用查询参数按需开启装饰，别把脏格式设成默认。

35. **「用回显的模型名发请求，聊到一半断了」**：客户端会把 `display_name`（`[TRAE] Seed-Code`）、
    URL 编码过的 id、甚至带引号的 id 当作 `model` 回传。服务端只做了 ` :: ` 反解，
    这些形态全落到 `splitModelId` 的 `必须形如 provider/model` 分支 → 400 → SSE 断流，
    用户侧就是「有时能用有时断」。修法是在三个协议入口统一归一化：解码、去引号、
    剥装饰前缀；只剩模型名时才查目录（有缓存），**唯一命中才还原**。歧义时宁可报错也不猜——
    猜错渠道会把请求送到错误的上游，比 400 更难排查。
36. **「本地回显模型也时不时断」**：这一条是三处独立毛病叠在一起，只有同时修才不复发。
    ① 回显渠道用 `.{1,4}` 切帧——正则按 **UTF-16 单元**切，emoji（代理对）会被拦腰截断，
    产出孤立代理 `"\ud83d"`；JSON 语法合法但语义坏了，严格的客户端解析器直接抛错断流。
    改按**字素簇**切（`Intl.Segmenter`，瘦 ICU 运行时兜底到 code point），顺带修好
    ZWJ 组合（👨‍👩‍👧‍👦）和国旗被拆成多个 emoji 的显示问题。
    ② 入口要把 `display_name` 还原成 `provider/model` 时会 `await listAll()`，而 `listAll`
    **串行遍历所有渠道**：TRAE 单次超时 75s，只要它抖一下，这次对话就在入口干等到客户端超时。
    更阴的是目录有 5 分钟 TTL —— 缓存有效期内很快，过期后第一次必卡，「有时断」的体感就是这么来的。
    改成先查 `peek()`（纯内存快照，零网络），冷启动才拉目录且**最多等 3s**，超时就放弃猜测。
    ③ 中断判据原来是 `req.complete`，但 POST 的请求体一读完它就恒为 `true`，等于永远不会取消；
    客户端关掉对话框后，上游还在接着生成、服务端还在往死连接里写。判据移到
    `res.on('close')` + `!res.writableEnded`，才真正能感知「人走了」。
37. **「` :: ` 这两个冒号是哪来的」**：它既不是上游给的、也不是客户端加的，是我自己造的——
    `decorateModelId()` 把渠道名和真实 id 用 ` :: ` 拼成一条「展示 id」。本意是让只读 `id`
    的客户端也能看到渠道，结果是第二行变成 `[TRAE] :: trae/Doubao-Seed-Code` 这种没法看的串，
    而且请求带回来还要再反解一层。教训是**别为了展示去污染路由键**：`id` 就该是 `provider/model`，
    展示信息放 `display_name`。现在 `decorateModelId` 只留给测试构造「旧客户端缓存」，不再下发。
    顺带把源码注释里残留的 `（字节）` / `（讯飞）` 也清了——注释会被人抄进字符串，留着就是隐患。

---

## 8. 下一步（按顺序）

1. 装到真机跑一次：`adb install -r dist/ofm-client-0.1.0-debug.apk`，看
   `adb logcat -s ofm-node` 是否打出 `node::Start(argc=2, argv[1]=/data/user/0/…/main.js)`，
   以及界面能否读到端口与 Key。
2. TRAE 真实账号：登录 → `/v1/models` → 流式对话 → 工具调用。
3. Qoder：重点验 `business` 与 uid；`Signature invalid (101)` 多半是 uid 缺失。
4. Cline / LobsterAI：设备码与本地回调两种登录各跑一遍。
5. 后台存活：电池优化白名单引导、`AlarmManager` 兜底重启。

---

## 9. 合规

- 这些渠道都是逆向官方桌面 / IDE 客户端的私有协议再实现，**账号侧存在被判定为非官方
  客户端的风险**，协议随时可能变更；常量截止 2026-10。
- 上游 `channel-pack` 为 MIT，保留其版权与 NOTICE；本仓库的 Qoder WASM 桥是移植实现，
  文件头已注明来源。
- 凭据只存 App 私有目录（0600），日志不打印 token；不上传任何服务器。
- 不提供绕过付费 / 额度的能力，只复用用户自己账号已有的免费额度。
- 不要冒用各渠道商标与图标。
