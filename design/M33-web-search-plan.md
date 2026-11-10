# M33：网页搜索与读取（给客户端用的搜索能力）

> **实施状态（2026-11-10）**：M33.1 / M33.2 / M33.3 已完成并编进 APK（`core/test/web-search.mjs` 161 项断言全过）；
> 引擎链按实测改为 `custom → bing → keenable → exa → parallel → anysearch`，M33.4（对话内自动搜索）未做。
>
> 目标一句话：本机 API 不再只是「转发模型」，还多一层**网页搜索 + 网页读取**，
> 让 ChatBox / DSH / Claude Code / OpenAI SDK 这些接入方真的能搜、能读；
> App 里给一个和截图同款的「网页搜索与读取」配置页（自定义搜索 / 自定义读取 + 内置引擎回退）。

---

## 1. 现在的缺口

| # | 现状 | 结论 |
| --- | --- | --- |
| 1 | `core/src/server.js` 只有 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/models` | 没有任何搜索/抓取能力，客户端问「今天新闻」只能靠模型自己的知识 |
| 2 | `convert/openai-chat.js:90` 明确跳过 `type !== 'function'` 的内置工具（web_search 等） | 上游给的内置搜索工具被丢掉，本地也没有替代实现 |
| 3 | `Store`（`core/src/store.js`）只有 `forward / accounts / disabledModels / modelEffort` | 没有搜索配置的落点，也没有「Key 单独存」的惯例可复用（只有 `credentials/*.json`） |

`dsh-free-search` 那份总结里真正能搬的是**可靠性层**（回退链、失败分类、冷却、缓存、去重、SSRF、文本清洗），
不是 36 个引擎——手机上跑 36 个源只会把电量和 IP 一起烧掉。所以本计划按「少而稳」实现。

---

## 2. 总体架构

```
第三方客户端
 ├─ ChatBox / LobeChat（自定义搜索）──► POST /v1/search   （填 URL + 模板 + 响应字段即可）
 ├─ Claude Code / DSH（MCP）─────────► POST /mcp          （web_search / web_read 两个工具）
 └─ OpenAI SDK（想要模型自己搜）─────► /v1/chat/completions + 本地工具循环（M33.4，可选）
                                              │
                    ┌─────────────────────────┴──────────────────────────┐
                    ▼                                                    ▼
            core/src/search/runner.js                          core/src/mcp/server.js
      回退链 · 30s 预算 · 冷却 · 缓存 · 去重                JSON-RPC 2.0（initialize/tools/*）
                    │
       ┌────────────┼──────────────┬──────────────────────┐
       ▼            ▼              ▼                      ▼
  custom（截图配置） bing-html     keyless MCP 三家      anysearch
  远端 REST 模板     cn.bing.com   exa/parallel/keenable  keyless REST
       │
       └─ 读取：custom read → 本地静态抓取（去脚本/样式/导航，正文密度取块，20k 字符封顶）
             → keenable `fetch_page_content` 兜底（静态抓取拿不到正文的站）
```

**角色分工写清楚**（这是最容易做歪的地方）：

- App 是**搜索供应方**：对客户端暴露 `/v1/search`、`/v1/read`、`/mcp`；
- App 也是**搜索调用方**：截图里的「自定义搜索 / 自定义读取」是让 App 去调**别人的**搜索 API
  （自建 SearXNG、自家中转、付费 API），留空则走内置引擎；
- 两者用同一套 runner，配置只是「链头插一个 custom 引擎」。

---

## 3. 服务端改动清单

### 3.1 新增文件

| 文件 | 职责 | 关键点 |
| --- | --- | --- |
| `core/src/search/config.js` | 配置默认值 / 归一化 / 校验 | 与 `store.js` 的 `#load()` 同风格：缺字段补齐、脏值回默认 |
| `core/src/search/template.js` | 占位符渲染 + 响应字段取值 | `{{query}}` `{{query_json}}` `{{count}}` / `{{url}}` `{{raw_url}}` `{{url_json}}`；路径取值支持 `data.web.results[]`、`[].title`、`a.b[0].c` |
| `core/src/search/custom.js` | 自定义搜索 / 自定义读取 | URL 里含占位符 → GET query；否则 POST 模板 body；`Authorization: Bearer` 自动附加 |
| `core/src/search/engines/bing-html.js` | `cn.bing.com/search?q=` HTML 抓取 | Chrome UA + `Accept-Language`；`<li class="b_algo">` 解析；`ck/a?u=a1…` base64url 还原真实 URL；`&ensp;`/`&#0183;` 脏实体清掉；空 SERP 判 0 结果 |
| `core/src/search/engines/mcp-keyless.js` | 三个 keyless 公开 MCP：`mcp.exa.ai` / `search.parallel.ai` / `api.keenable.ai` | 无状态 JSON-RPC `tools/call`；响应可能是**纯 JSON** 也可能 SSE（两种都要会解）；结果文本里可能是嵌套 JSON（keenable）或 `Title:/URL:` 文本（exa）；keenable 的工具名是 `search_web_pages` 不是 `search` |
| `core/src/search/engines/anysearch.js` | `api.anysearch.com/v1/search` | keyless REST，结果在 `data.results`；key 被拒时忽略并回退匿名档 |
| `core/src/search/engines/local-fetch.js` | 本地静态抓取（读取回退） | 12s 超时 / 3MB 上限 / 只收 `text/html`；去 `script|style|nav|footer|aside`，按块文本密度取正文，码点截断 20k |
| `core/src/search/runner.js` | 回退链 + 预算 + 冷却 + 缓存 + 去重 | 30s 总预算；`classifyFailure`（quota / auth / bot-wall / transient / invalid-response）；LRU 50 / TTL 5min；`url_norm` + eTLD+1 同站轮转 |
| `core/src/search/ssrf.js` | 地址拦截 | 拒私网 / 回环 / 链路本地 / 云元数据 / `.local`，**并拒本机 18900 自己**（否则 `/v1/read` 读自己会死循环） |
| `core/src/search/sanitize.js` | 出口统一清洗 | 清孤立代理（emoji 截断的老坑）、去零宽、snippet 300 字符、`<untrusted-web-content>` 边界 |
| `core/src/search/log.js` | 搜索日志（可选但建议） | 内存环形 200 条：时间 / 源 / query 摘要 / 耗时 / 结果数 / 失败类 / 是否回退；`GET /api/search/log` |
| `core/src/mcp/server.js` | MCP over HTTP | JSON-RPC 2.0：`initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`；未知方法回 `-32601` |

### 3.2 修改文件

| 文件 | 改动 |
| --- | --- |
| `core/src/server.js` | ① `createApp` 里建 `searchService`、`mcpServer`；② 鉴权后加路由 `POST/GET /v1/search`、`POST/GET /v1/read`、`POST /mcp`（`GET /mcp` 回 405 或 SSE 单帧）；③ `handleApi` 加 `GET/POST /api/search/config`、`POST /api/search/test`、`POST /api/search/read-test`、`GET/DELETE /api/search/log` |
| `core/src/store.js` | `#load()` 补 `webSearch` 默认块（见 §4），并做一次结构校验；搜索 Key **不写这里**，写 `credentials/web-search.json`（0600） |
| `core/src/http-client.js` | 复用现有 CA / 超时 / 解压能力；新增 `fetchText()`（返回 `{status, headers, text, truncated}`）给抓取用，避免每处各写一份 |
| `core/main.js` | 启动时把 `webSearch.enabled` 打进 `runtime.json`（App 概览页要显示「搜索：开/关」） |
| `README.md` | M33 一行 + §4.x「搜索接口」+ 客户端填法（ChatBox 自定义搜索三格怎么填、Claude Code 的 `mcpServers` 片段）+ 测试计数 |

### 3.3 不做什么（写进计划避免膨胀）

- 不做 36 个引擎（实测只有 5 个在国网络真的能用，见 §12）、不做 `research` 深度研究、不做 rerank / 向量重排；
- **不接** DDG / 公共 SearXNG / Baidu / 360 / Sogou / Brave / Startpage / Ecosia / Jina Reader —— 实测全部不可用，写进代码注释免得以后有人再试一遍；
- 不做 JS 渲染（无头浏览器在 Android 内嵌 Node 里跑不动）；
- 不做「搜索历史落盘」（只留内存环形日志，避免隐私问题）；
- M33 不做对话内自动搜索（放 M33.4，单独评估）。

---

## 4. 配置模型（`settings.json` → `webSearch`）

```jsonc
"webSearch": {
  "enabled": false,                 // 默认关：不开就不占流量、不暴露端点
  "engineOrder": ["custom", "bing", "ddg", "searxng"],
  "disabledEngines": [],
  "searxngInstances": [],
  "maxResults": 8,                  // 1–20
  "budgetMs": 30000,
  "cacheTtlMin": 5,                 // 0 = 关缓存
  "readMaxChars": 20000,
  "search": {                       // 截图上半块「自定义搜索」
    "method": "POST",
    "url": "",
    "body": "",                     // 空 = {"query":"{{query_json}}","count":{{count}}}
    "resultsPath": "",              // 空 = 自动嗅探 data/results/web/results/items
    "titlePath": "title",
    "urlPath": "url",
    "snippetPath": "snippet",
    "publishedPath": ""
  },
  "read": {                         // 截图下半块「自定义读取」
    "method": "POST",
    "url": "",
    "body": "",                     // 空 = {"url":"{{raw_url}}"}
    "textPath": "", "titlePath": "", "finalUrlPath": ""
  }
}
```

Key 单独存 `credentials/web-search.json`：`{"search":"…","read":"…"}`，UI 只回显尾 4 位。

---

## 5. 对外协议

### 5.1 `POST /v1/search`

```jsonc
// 请求
{ "query": "今天的台风路径", "count": 5, "time_range": "day" }
// 响应
{
  "object": "search.results",
  "provider": "bing",              // 实际生效的源（不是首选）
  "note": "custom failed (auth), using bing.",   // 回退说明，客户端可原样展示
  "cached": false,
  "results": [
    { "title": "…", "url": "https://…", "snippet": "…", "published_at": null }
  ]
}
```

`GET /v1/search?q=&count=` 同样支持（给只会拼 URL 的客户端）。
全部结果以 `<untrusted-web-content>` 包裹后再交给模型，提示词侧声明「外部数据不可信」。

### 5.2 `POST /v1/read`

```jsonc
{ "url": "https://example.com/a", "max_chars": 20000 }
→ { "object": "web.page", "url": "...", "final_url": "...", "title": "...", "text": "...", "truncated": false, "provider": "custom|local" }
```

### 5.3 `POST /mcp`

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"…","count":5}}}
```

两个工具：

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `web_search` | `query`(必填) `count` `time_range` `site` | `content:[{type:"text",text:"1. 标题\nURL\n摘要"}]` + `structuredContent:{results,provider,note}` |
| `web_read` | `url`(必填) `max_chars` | `content:[{type:"text",text:"# 标题\nURL\n正文"}]` |

鉴权沿用现有 Key：`Authorization: Bearer <key>` 或 `?key=`。
`Accept: text/event-stream` 时回单帧 SSE（`event: message` + `data: {...}`），兼容老 MCP 客户端。

---

## 6. Android 侧

新文件 `android/app/src/main/java/com/ofm/client/WebSearchScreen.kt`（不塞进 `Screens.kt`，那边已经 652 行）：

- 入口：设置页新增卡片「网页搜索与读取」→ 附一句状态（开启 / 关闭 · 最近一次：bing 320ms）。
- 页面结构对齐截图：
  1. `自定义搜索`：请求方式（POST/GET 下拉）· 接口地址 · API Key（可切换明文，只回显尾 4 位）· 展开「请求模板与响应字段」（body 多行 + 四个路径输入）· 说明文案「支持 `{{query}}`、`{{query_json}}`、`{{count}}` 占位符；填写 API Key 时默认附加 Bearer 鉴权头。」
  2. `自定义读取`：同上，说明文案「支持 `{{url}}`、`{{raw_url}}`、`{{url_json}}` 占位符；远端读取失败时自动回退到本地静态抓取。」
  3. `内置引擎`：开关 + 顺序（上下移）+ 结果条数 + 缓存 TTL。
  4. 底部固定「保存」按钮（截图同款整宽蓝钮）。
- 两个按钮解决「配了到底通不通」：`试搜`（跑一次真实 query，展示 provider / 耗时 / 前 3 条）、`试读`（抓一个 URL，展示字数与耗时）。
- 接口：`ApiClient.getSearchConfig / saveSearchConfig / testSearch / testRead / searchLog`，超时单独放宽到 45s（`ApiClient.open()` 的 `readTimeout` 分支）。

---

## 7. 安全与边界

| 项 | 处理 |
| --- | --- |
| SSRF | 只允许 `http/https`；拒绝私网/回环/链路本地/元数据/`.local`；拒本机 18900；`dns.lookup` 预解析后再校验一次 |
| 读取体积 | 3MB 响应上限 + `content-length` 预检；超限直接放弃，不缓存 |
| Key 泄漏 | Key 只进 `credentials/web-search.json`（0600）；日志与错误里按 `redact` 打码；`/api/search/config` 只回尾 4 位 |
| 日志 | 只记 query 前 60 字、源、耗时、结果数、失败类；不记正文、不记 Key |
| 默认关闭 | `enabled: false`；关着时 `/v1/search`、`/mcp` 回 503 + 明确文案 |
| 注入风险 | 所有结果包 `<untrusted-web-content>`，并剥离正文里同名标记防提前闭合 |

---

## 8. 测试（新增 `core/test/web-search.mjs`，目标 ≥ 90 项断言）

1. 模板：`{{query}}` 原样、`{{query_json}}` 引号/换行/中文转义、`{{count}}` 数字、URL 内占位符走 GET；
2. 字段取值：`data.web.results`、根数组、`[0].title`、缺失字段回落默认；
3. 自定义 provider：本地起 http mock，断言请求头（Bearer）/ body / 结果映射；
4. 回退链：custom 401 → bing → 0 结果 → ddg 全挂，`note` 文案与 `provider` 正确；
5. 冷却：同一源连续失败只打一次，冷却期内直接跳过；
6. 缓存：同 query 第二次 `cached: true`，TTL 过期后重打；
7. 去重：同站多结果按 eTLD+1 轮转、`url_norm` 合并 tracking 参数变体；
8. 读取：本地静态抓取去脚本/样式、正文截断、非 HTML 拒绝；
9. SSRF：`127.0.0.1` / `169.254.169.254` / `file://` / 本机 18900 全部拒绝；
10. MCP：`initialize` 协议版本、`tools/list` 两个工具、`tools/call` 正常/未知工具/坏 JSON、SSE 单帧；
11. 端点：无 Key 401、关闭时 503、`GET /v1/search` 可用；
12. 预算：mock 慢源 40s，整体在 ~30s 内返回并带 `note`。

`acceptance.mjs` 的 19 套计数同步更新；README 里 1157 → 新总数。

---

## 9. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **M33.1** | `search/` 全部模块 + `/v1/search`、`/v1/read` + 测试 | 90 项断言全过，`curl` 能搜到真实结果 |
| **M33.2** | Android 配置页 + 试搜/试读 + `/api/search/config` | 编译通过、进 APK、保存后重启仍在 |
| **M33.3** | `/mcp` 端点 + README 接入示例（Claude Code / ChatBox 填法） | MCP 客户端 `tools/list` 能看到两个工具 |
| **M33.4**（可选，先评估） | 对话内工具循环：请求里出现 `web_search` 就本地执行并回填，最多 2 轮 | 只在模型确实发起 tool_call 时触发，避免双跑 |

M33.1 → M33.2 是必做；M33.3 半天量；M33.4 有上游兼容风险，建议等前三步上机验证后再定。

---

## 10. 风险

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 免费 SERP 不稳 | `cn.bing.com` 会按 IP/UA 返回空 SERP 或验证码（本期实测 25/25 正常，但这是运气不是保证） | 链路顺序 custom → bing → keenable → exa → parallel → anysearch；空结果不算失败不冷却；把 `note` 透给用户，别假装成功 |
| 地域差异 | `mkt=zh-CN` + 海外 IP 返回空 SERP（dsh #71） | 默认不发 `mkt`，只发 `Accept-Language` |
| 无 JS 渲染 | 前端渲染站点抓不到正文 | 明确写进说明「静态抓取，失败请换源」；不做无头浏览器 |
| 工具注入兼容 | 上游模型 tool_calls 支持参差，容易和客户端自己的工具打架 | M33.4 单独开关，默认关 |
| 耗电/流量 | 手机端每次搜索都走真实网络 | 默认关闭、缓存 5min、结果条数上限 8 |
| DNS 劫持/重绑定 | 预解析后再请求仍有窗口 | 记录风险、不在本期做 `lookup` 钩子 |

---

## 11. 需要你拍板的三件事

1. **客户端接入先做哪个**：`/v1/search` REST（ChatBox 三格直接填，最省事，推荐）／ `/mcp`（Claude Code、DSH）／ 两者都做。
2. **默认开关**：保持 `enabled: false`（推荐，省流量也少一个暴露面），还是装上就开。
3. **要不要 M33.4「模型自己搜」**：需要在本机跑工具循环，和客户端自带工具可能打架；建议先不做。

---

### 附：截图三格怎么填（做完后的说明书）

```
接口地址(URL)   http://127.0.0.1:18900/v1/search
API Key        ofm-local-key
请求方式        POST
请求模板        {"query":"{{query_json}}","count":{{count}}}
响应字段        results / title / url / snippet
```

读取那半边填 `http://127.0.0.1:18900/v1/read`，模板 `{"url":"{{raw_url}}"}`，字段 `text` / `title`。

---

## 12. 实测记录（2026-11-10，本沙箱出口≈国内网络）

探测方式：同一 query 连打 3 轮判稳定性，再换 5 个不同领域 query 判覆盖（共 25 次/源）。

### 12.1 能用的（5 个，25/25 全中）

| 源 | 类型 | 耗时 | 条数 | 质量 |
| --- | --- | --- | --- | --- |
| **bing-html**（cn.bing.com） | HTML 抓取 | **130–220ms** | 10 | 最快；标题偶有泛化（`React`、`Welcome to Python.org`），但 URL 准；`ck/a?u=a1…` 可 base64url 还原成真实域名 |
| **keenable MCP** | keyless MCP | **450–1030ms** | 10 | 中文结果最好，随机性最小；工具名是 `search_web_pages`；额外有 `fetch_page_content` 可读取（慢，19.5s 抓人民网，只做兜底） |
| **exa MCP** | keyless MCP | 500–3200ms | 5 | 技术类命中准，`Title:/URL:` 文本格式；偶发 3s 延迟 |
| **parallel MCP** | keyless MCP | 1100–2300ms | 10 | 返回 `publish_date` + `excerpts`，摘要可直接进提示词 |
| **anysearch** | keyless REST | 1.1–6.7s | 5 | 中文结果好；延迟抖动大（最长 6.7s），排链路尾 |

结论：**默认链 `custom → bing → keenable → exa → parallel → anysearch`**。
bing + keenable 两个已覆盖 95% 场景，exa/parallel/anysearch 只用来补条数和质量。

### 12.2 实测不可用（别再试了，写进代码注释）

| 源 | 失败形态 |
| --- | --- |
| ddg html / lite | connect 失败（域名被解析到 `128.121.243.x`，连接即断） |
| zh.wikipedia.org | DNS 污染成 `31.13.94.49`（Facebook 的 IP） |
| searx.be / searx.tiekoetter.com / search.inetol.net / opnxng.com / baresearch.org | 5 个公共实例全部 connect 失败 |
| api.you.com | connect 失败 |
| api.tavily.com（keyless） | 429，按出口 IP 限流 |
| api.firecrawl.dev（无 key） | 403 `IP looks like a VPN or proxy` |
| baidu / so.com / sogou 网页版 | 返回 1.5–6.8KB 反爬空页，0 结果 |
| brave / startpage / ecosia | 超时或空页 |
| r.jina.ai（Reader） | 全部超时；知乎那条直接 ECONNREFUSED |
| github.com | connect 超时 |

### 12.3 读取（本地静态抓取）

| 站点 | 耗时 | 正文字符 |
| --- | --- | --- |
| gov.cn | 24ms | 4457 |
| people.com.cn | 30ms | 9133 |
| csdn | 586ms | 9878 |
| developer.mozilla.org | 917ms | 71532 |
| 36kr | 181ms | 1911（前端渲染，正文少） |
| thepaper.cn | 415ms | 717（同上） |
| zhihu | 159ms | 403 拒绝 |
| github.com | — | connect 超时 |

结论：本地静态抓取对**服务端渲染的站**（gov/人民网/CSDN/MDN）足够快且干净；
前端渲染站只能拿到壳，此时才值得调 keenable `fetch_page_content` 兜底（1.6–19.5s，很慢）。

### 12.4 解析细节（写代码时别踩）

1. Bing 的 `snippet` 里混着 `&ensp;`、`&#0183;`，必须解码后再清洗，否则结果里全是乱码；
2. Bing 的 `href` 是 `bing.com/ck/a?u=a1<base64url>`，不解码客户端会拿到跳转链；
3. keyless MCP 的响应**有时是纯 JSON、有时是 SSE**（parallel/keenable 纯 JSON，exa 视请求头而定），两种都要会解；
4. keenable 的结果是**文本里再套一层 JSON**（`content[0].text` 是 `{"results":[…]}`），exa 是纯文本 `Title:/URL:`，两种解析器都要有；
5. keenable 工具名是 `search_web_pages`，传 `search` 会回 `Unknown tool`（HTTP 仍是 200，别当成功）。
