/**
 * Qoder / Qoder 中国版 产品常量。
 * ⚠️ 国际版与国内版是两套 host，加密推理与公开推理又是两套 host —— 不要混。
 */
export const QODER = {
  id: 'qoder',
  displayName: 'Qoder',
  authBase: 'https://qoder.com',
  openApiBase: 'https://openapi.qoder.sh',
  inferBase: 'https://api2-v2.qoder.sh',
  encryptedInferBase: 'https://api2.qoder.sh',
  clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
  sashClientType: '10',
  userAgentPrefix: 'qoder',
  cosyVersion: '1.1.49',
  sessionType: 'qodercli'
};

export const QODER_CN = {
  ...QODER,
  id: 'qodercn',
  displayName: 'Qoder 中国版',
  authBase: 'https://qoder.cn',
  openApiBase: 'https://openapi.qoder.com.cn',
  inferBase: 'https://api2-v2.qoder.com.cn',
  encryptedInferBase: 'https://gateway.qoder.com.cn',
  clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
  sessionType: 'qoder_work'
};

export const PATHS = {
  deviceSelect: '/device/selectAccounts',
  poll: '/api/v1/deviceToken/poll',
  refresh: '/api/v1/deviceToken/refresh',
  userinfo: '/api/v1/userinfo',
  chatPublic: '/model/v1/chat/completions',
  chatEncrypted: '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
};
