/**
 * Qoder 模型表（目录 key）。
 * ⚠️ key 只对加密端点有效；公开端点只认 qwen-flash 那类通用名，两套不能混。
 */
export const QODER_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 200000, multimodal: true, reasoning: false },
  { id: 'ultimate', name: 'Ultimate', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
  { id: 'performance', name: 'Performance', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'medium' },
  { id: 'efficient', name: 'Efficient', contextWindow: 1000000, multimodal: true, reasoning: false },
  { id: 'smodel', name: 'Sonus', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
  { id: 'cmodel', name: 'Cantus', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'xhigh' },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium' },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1000000, multimodal: true, reasoning: false },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1000000, multimodal: true, reasoning: false },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1000000, multimodal: true, reasoning: false, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1000000, multimodal: true, reasoning: false, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'max', 'low'], defaultEffort: 'max' },
  { id: 'mmodel', name: 'MiniMax-M3', contextWindow: 1000000, multimodal: true, reasoning: false }
];

/** 中国版：无 ultimate/performance/efficient/smodel/cmodel，多 q37fmodel / gm51model */
export const QODER_CN_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 200000, multimodal: true, reasoning: true },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium' },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium' },
  { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 1000000, multimodal: true, reasoning: true },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'max', 'low'], defaultEffort: 'max' },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'gm51model', name: 'GLM-5.2', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1000000, multimodal: true, reasoning: false, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1000000, multimodal: true, reasoning: true, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 200000, multimodal: true, reasoning: false }
];

export function modelsFor(productId) {
  return productId === 'qodercn' ? QODER_CN_MODELS : QODER_MODELS;
}

export function modelMeta(productId, id) {
  return modelsFor(productId).find((m) => m.id === id);
}
