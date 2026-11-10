/**
 * TRAE 产品常量。
 * ⚠️ 逐字照抄，改了大概率被风控。
 */
export const TRAE = {
  id: 'trae',
  displayName: 'TRAE',
  agentHost: 'https://trae-api-cn.mchost.guru',
  oauthHost: 'https://api.trae.com.cn',
  consoleHost: 'https://www.trae.cn',
  clientId: 'en1oxy7wnw8j9n',
  appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  ideVersion: '0.1.52',
  ideVersionCode: '20260811',
  deviceBrand: 'Apple',
  osVersion: 'macOS 15.7.4',
  function: 'solo_work_lite',
  pluginVersion: '2.3.62834',
  userAgent: 'Trae/0.1.52',
  /**
   * 单次请求输出额度的硬上限（上游实测的全局安全线）。
   * 客户端要 131072 会被上游直接打成 4xx。
   */
  maxOutputTokens: 64000,
  /**
   * 客户端没指定 max_tokens 时的默认值。
   *
   * ⚠️ 对齐上游 `fallbackMaxOutputTokens: 32_000`。以前这里无条件发 64000，
   * 而多数模型真实上限只有 32K（个别更低）—— 超出模型上限时上游不会回
   * `event:error`，而是**建好会话只发一帧 metadata 就断流**，本机拿到的就是
   * 零正文，第三方表现为「接入 API 无回复」。
   */
  defaultMaxOutputTokens: 32000
};

/** 通道优先级：顺序即优先级，非白名单通道的模型一律丢弃 */
export const TRAE_CHANNELS = [
  'solo_agent',
  'solo_work_lite',
  'solo_agent_remote',
  'solo_work_remote',
  'solo_agent_lite',
  'chat_v3',
  'builder_v3',
  'solo_coder',
  'solo_design_lite',
  'solo_design_remote',
  'git_ai',
  'code_reviewer',
  'code_review_summary',
  'multimodal',
  'system_diagnosis'
];

export const TRAE_PATHS = {
  chat: '/api/agent/v3/llm_utils_chat',
  batchModels: '/api/ide/v1/batch_get_detail_param',
  singleModels: '/api/ide/v1/get_detail_param',
  exchangeToken: '/cloudide/api/v3/trae/oauth/ExchangeToken',
  userInfo: '/cloudide/api/v3/trae/GetUserInfo'
};

/**
 * 远端模型目录拉取失败 / 返回空时的静态兜底目录。
 *
 * 逐字对齐上游 `trae-product.ts` 的 `TRAE_FALLBACK_MODELS`（2026-08 实测快照）。
 * 上游刻意保证「选择器不会为空」：远端不可用时用它顶替（见上游 README
 * 「整轮探测全部被拒时同样保留，选择器不会为空」与 TraeAdapter.listAllModels
 * 的 `remoteModels === undefined ? staticFallbackModels() : …`）。
 *
 * ⚠️ 这是**兜底**而非伪造：条目带 `fallback:true`，界面会明确标注
 * 「远端目录不可用，以下为兜底清单」，并把真实失败原因显示出来。
 * 4 条官方隐藏条目（内部子代理 / 标题生成）不进目录。
 */
export const TRAE_FALLBACK_MODELS = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official', contextWindow: 200000 },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro', contextWindow: 200000 },
  { id: 'seed-code-pro-0430', name: 'Seed Code Pro 0430', contextWindow: 200000 },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo', contextWindow: 200000 },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code', contextWindow: 200000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200000 },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 200000 },
  { id: 'glm-5', name: 'GLM-5', contextWindow: 200000 },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', contextWindow: 200000 },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 200000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200000 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 200000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200000 },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 200000 },
  { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 200000 },
  { id: 'sagitta', name: 'Sagitta', contextWindow: 200000 },
  { id: 'aquila', name: 'Aquila', contextWindow: 200000 },
  { id: 'custom_model_gemini', name: 'Custom Gemini', contextWindow: 200000 },
  { id: 'custom_model_placeholder', name: 'Custom Placeholder', contextWindow: 200000 },
  { id: 'custom_model_1M_text', name: 'Custom 1M Text', contextWindow: 200000 },
  { id: 'custom_model_1M', name: 'Custom 1M', contextWindow: 200000 },
  { id: 'custom_model_kimi', name: 'Custom Kimi', contextWindow: 200000 },
  { id: 'custom_model_claude', name: 'Custom Claude', contextWindow: 200000 },
  { id: 'custom_model_gpt-5', name: 'Custom GPT-5', contextWindow: 200000 },
  { id: 'custom_model_no-fc', name: 'Custom No-FC', contextWindow: 200000 },
  { id: 'custom_model_deepseek_chat', name: 'Custom DeepSeek Chat', contextWindow: 200000 },
  { id: 'custom_model_deepseek_reasoner', name: 'Custom DeepSeek Reasoner', contextWindow: 200000 },
  { id: 'custom_model_deepseek_v4', name: 'Custom DeepSeek V4', contextWindow: 200000 }
];

/** 拉模型目录时要问的全部通道（batch 端点一次返回所有通道的配置） */
export const TRAE_FUNCTIONS = [
  'ui_builder_v2',
  'solo_coder',
  'chat_v3',
  'solo_builder',
  'builder_v3',
  'builder',
  'chat',
  'inline_chat',
  'git_ai',
  'custom_agent_generation',
  'utils',
  'code_reviewer',
  'code_review_summary',
  'solo_agent',
  'solo_agent_remote',
  'solo_work_remote',
  'solo_agent_lite',
  'solo_work_lite',
  'solo_design_lite',
  'solo_design_remote',
  'multimodal',
  'system_diagnosis'
];
