/**
 * TRAE 模型目录：batch_get_detail_param 一次问全部通道（§5.1）。
 *
 * 与上游 dsh-our-free-model 对齐：
 *  - 端点 / 请求体 / 请求头 / 通道白名单 / 解析规则逐项一致；
 *  - 远端失败或返回空时，由上层回退到静态兜底目录（见 product.js），
 *    保证模型选择器不为空（上游 TraeAdapter.listAllModels 同款语义）。
 */
import { request } from '../../upstream.js';
import { OfmError, Codes } from '../../errors.js';
import { normalizeReasoningOptions } from '../../reasoning-options.js';
import {
  TRAE,
  TRAE_PATHS,
  TRAE_FUNCTIONS,
  TRAE_CHANNELS,
  TRAE_FALLBACK_MODELS
} from './product.js';
import { traeHeaders } from './protocol.js';

const BODY = {
  functions: TRAE_FUNCTIONS,
  agent_type: '',
  current_config_info: { config_name: '', is_custom_model: false },
  mode_type: 0,
  access_type: 0,
  ab_force_vids: '',
  ab_autotest_advanced_mode: 0,
  show_custom_model: true
};

/** 单通道端点（batch 失败时的第二次尝试）。 */
const SINGLE_BODY = {
  function: TRAE.function,
  agent_type: '',
  mode_type: 0,
  access_type: 0,
  show_custom_model: false
};

function headersOf(credential, machineId, deviceId) {
  return traeHeaders({
    accessToken: credential.access_token,
    uid: credential.uid,
    machineId: machineId || credential.machine_id,
    deviceId: deviceId || credential.device_id,
    accept: 'application/json'
  });
}

/**
 * 拉远端目录：先 batch（真实 CN IDE 端点），失败/空再试单通道。
 * 两次都拿不到就抛错，由 TraeChannel.listModels 回退到兜底表。
 */
export async function fetchModels({ credential, machineId, deviceId, requestImpl = request }) {
  const headers = headersOf(credential, machineId, deviceId);
  const errors = [];

  for (const [label, path, body] of [
    ['batch', TRAE_PATHS.batchModels, BODY],
    ['single', TRAE_PATHS.singleModels, SINGLE_BODY]
  ]) {
    try {
      const res = await requestImpl(`${TRAE.agentHost}${path}`, {
        method: 'POST',
        headers,
        body,
        timeoutMs: 30000
      });
      if (res.status === 401 || res.status === 403) {
        throw new OfmError(Codes.AUTH, `TRAE ${label} 目录鉴权失败（HTTP ${res.status}），需要重新登录`);
      }
      if (res.status >= 400 || !res.json) {
        throw new OfmError(Codes.UPSTREAM, `TRAE ${label} 目录请求失败: HTTP ${res.status}`);
      }
      const models = parseCatalog(res.json);
      if (models.length > 0) return models;
      errors.push(`${label} 目录为空`);
    } catch (e) {
      errors.push(e?.message || String(e));
    }
  }

  throw new OfmError(
    Codes.UPSTREAM,
    `TRAE 模型目录不可用（${errors.join('；').slice(0, 300)}）`
  );
}

/**
 * 解析目录。兼容三种形状：
 *  1. `{ function_configs: [...] }` —— batch 端点（多通道）；
 *  2. `{ config_info_list: [...] }` —— 单通道 get_detail_param；
 *  3. 上面两种被包在 `{ data: ... }` 信封里。
 */
export function parseCatalog(body) {
  const root = body?.data && typeof body.data === 'object' ? body.data : body;
  if (!root || typeof root !== 'object') return [];

  const byId = new Map();
  const groups = root.function_configs || root.FunctionConfigs;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const channel = group.function || group.Function;
      if (!channel || TRAE_CHANNELS.indexOf(channel) < 0) continue; // 非白名单通道整组跳过
      const list = group.config_info_list || group.ConfigInfoList;
      if (Array.isArray(list)) collectEntries(list, channel, byId);
    }
    return [...byId.values()];
  }

  // 单通道：没有 function_configs，条目直接在顶层
  const flat = root.config_info_list || root.ConfigInfoList || root.data;
  if (Array.isArray(flat)) {
    collectEntries(flat, TRAE.function, byId);
    return [...byId.values()];
  }
  return [];
}

function collectEntries(list, channel, byId) {
  const rankOf = (ch) => TRAE_CHANNELS.indexOf(ch);
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const model = parseEntry(item, channel);
    if (!model) continue;
    // 四条硬过滤（与上游 parseTraeBatchModelList 一致）
    if (model.usage && model.usage !== 'chat_completion') continue;
    if (model.enabled === false) continue;
    if (model.hidden === true) continue;
    if (model.custom === true) continue;

    if (!byId.has(model.id)) {
      byId.set(model.id, model);
      continue;
    }
    const prev = byId.get(model.id);
    // 有思考档位的优先；同档按通道优先级
    if (prev.reasoningOptions?.length && !model.reasoningOptions?.length) continue;
    if (rankOf(channel) < rankOf(prev.channel)) byId.set(model.id, model);
  }
}

/**
 * `display_contact_config` 是**一个 JSON 字符串**，不是对象：
 *   "{\"consumption_rate\":{\"enable\":true,\"data\":{\"rate\":0.08}}}"
 * 直接读 `entry.display_contact_config.consumption_rate` 永远是 undefined。
 */
function parseContactConfig(entry) {
  const raw = entry.display_contact_config ?? entry.DisplayContactConfig;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 解析积分消耗倍率（`consumption_rate.data.rate`）。三条判据缺一不可：
 *  1. `enable !== false` —— 上游显式关闭时不显示，而不是当成 0；
 *  2. `rate` 是有限数；
 *  3. **`rate: 0` 是合法值**（免费模型），不能用 `> 0` 过滤。
 * 解析失败返回 undefined —— 宁可只显示模型名，也不编造倍率。
 */
export function readConsumptionRate(entry) {
  const config = parseContactConfig(entry);
  if (!config) return undefined;
  const rate = config.consumption_rate ?? config.ConsumptionRate;
  if (!rate || typeof rate !== 'object') return undefined;
  if (rate.enable === false || rate.Enable === false) return undefined;
  const data = rate.data ?? rate.Data;
  if (!data || typeof data !== 'object') return undefined;
  const value = num(data.rate ?? data.Rate);
  return value !== undefined && value >= 0 ? value : undefined;
}

/**
 * 解析活动折扣，**只在当前确实生效时**返回原价与截止时间（Unix 秒）。
 * 判据：`enable !== false`、`discount_type` 不是 none、
 * `before_consumption_rate > after`（真降价）、未过期。
 * 实测陷阱：`enable: true` 但 `discount_type: "none"`、`before === after` 很常见，
 * 照显示会变成 `×0.13→×0.13`，让人以为有活动。
 */
export function readActivityDiscount(entry, nowSec = Math.floor(Date.now() / 1000)) {
  const config = parseContactConfig(entry);
  if (!config) return undefined;
  const discount = config.activity_discount ?? config.ActivityDiscount;
  if (!discount || typeof discount !== 'object') return undefined;
  if (discount.enable === false || discount.Enable === false) return undefined;
  const data = discount.data ?? discount.Data;
  if (!data || typeof data !== 'object') return undefined;
  const current = data.current ?? data.Current;
  if (!current || typeof current !== 'object') return undefined;

  const type = String(current.discount_type ?? current.discountType ?? '').trim().toLowerCase();
  if (type.length === 0 || type === 'none') return undefined;

  const before = num(current.before_consumption_rate ?? current.beforeConsumptionRate);
  const after = num(current.consumption_rate ?? current.consumptionRate);
  if (before === undefined || before <= 0) return undefined;
  if (after !== undefined && before <= after) return undefined;

  let endsAtSec;
  for (const value of Object.values(data)) {
    if (!value || typeof value !== 'object') continue;
    const end = num(value.end_at ?? value.endAt);
    if (end !== undefined && end > 0) {
      endsAtSec = Math.trunc(end);
      break;
    }
  }
  if (endsAtSec !== undefined && endsAtSec <= nowSec) return undefined; // 过期活动当不存在

  return endsAtSec === undefined ? { originalRate: before } : { originalRate: before, endsAtSec };
}

/**
 * 归一化的实现已抽到公共模块（Qoder / MiniMax 也要用）。
 * 这里保留导出，既有测试与调用方不用改路径。
 */
export { normalizeReasoningOptions };

function parseEntry(entry, channel) {
  const id = entry.config_name || entry.ConfigName;
  if (!id || typeof id !== 'string') return null;
  const display = entry.display_config || entry.DisplayConfig || {};
  const name = display.display_name || id;
  const contextWindow =
    Number(entry.context_window_tokens?.['dev'] ?? entry.context_window_tokens?.dev ?? 0) ||
    Number(entry.context_window_tokens?.max ?? 0) ||
    Number(display.context_window ?? 0) ||
    undefined;

  const reasoningConfig = entry.reasoning_effort_config || entry.ReasoningEffortConfig;
  const reasoningOptions = normalizeReasoningOptions(reasoningConfig?.options);

  // 计费：一次解析出倍率与（真正生效的）活动折扣，界面上配对展示 `×原价→×折后价`
  const creditsRate = readConsumptionRate(entry);
  const discount = readActivityDiscount(entry);

  return {
    id,
    name,
    channel,
    description: display.description || '',
    contextWindow,
    multimodal: display.multimodal === true,
    maxMode: display.max_mode === true,
    maxContextWindow: Number(entry.context_window_tokens?.max ?? 0) || undefined,
    // 模型自己声明的输出上限。发请求时必须按它收敛，否则超出上限时上游
    // 会「建会话 → 只发 metadata → 断流」，表现为零正文。
    maxOutputTokens: readDetailMaxTokens(entry),
    reasoning: reasoningConfig?.support_thinking !== false && reasoningOptions.length > 0,
    reasoningOptions,
    // 积分消耗倍率：0 表示免费（合法值，不可用 >0 过滤）
    ...(creditsRate === undefined ? {} : { creditsRate }),
    ...(discount ? { originalCreditsRate: discount.originalRate } : {}),
    ...(discount?.endsAtSec ? { discountEndsAtSec: discount.endsAtSec } : {}),
    usage: entry.usage || entry.Usage || '',
    enabled: entry.config_switch ?? entry.ConfigSwitch,
    hidden: entry.is_invisible_to_user ?? entry.IsInvisibleToUser,
    custom: display.is_custom_model ?? display.IsCustomModel
  };
}

/**
 * 读取 `model_detail_list[].max_tokens`（对齐上游 `readDetailMaxTokens`）。
 * 多条明细时优先 `model_name` 以 `__dev` 结尾那条（常规模式），否则取第一条。
 */
function readDetailMaxTokens(entry) {
  const raw = entry.model_detail_list ?? entry.ModelDetailList;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const details = raw.filter((it) => it && typeof it === 'object');
  const preferred = details.find((it) => String(it.model_name ?? it.ModelName ?? '').endsWith('__dev'));
  const chosen = preferred || details[0];
  if (!chosen) return undefined;
  const value = Number(chosen.max_tokens ?? chosen.MaxTokens);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

/**
 * 静态兜底目录（上游 2026-08 实测快照，已去掉 4 条官方隐藏条目）。
 * 每条带 fallback:true，界面据此标注「远端不可用」。
 */
export function fallbackModelEntries() {
  return TRAE_FALLBACK_MODELS.map((m) => ({
    id: m.id,
    displayName: m.name,
    contextWindow: m.contextWindow,
    multimodal: false,
    reasoning: false,
    reasoningOptions: [],
    function: TRAE.function,
    maxMode: false,
    maxContextWindow: undefined,
    fallback: true
  }));
}

/** 目录 → 本机模型条目（id 不带 provider 前缀，由上层拼） */
export function toModelEntries(models) {
  return models.map((m) => ({
    id: m.id,
    displayName: m.name || m.id,
    contextWindow: m.contextWindow,
    multimodal: m.multimodal,
    reasoning: m.reasoning,
    // 私有字段：发请求时要用它选通道
    function: m.channel,
    maxMode: m.maxMode,
    maxContextWindow: m.maxContextWindow,
    maxOutputTokens: m.maxOutputTokens,
    reasoningOptions: m.reasoningOptions,
    ...(m.creditsRate === undefined ? {} : { creditsRate: m.creditsRate }),
    ...(m.originalCreditsRate === undefined ? {} : { originalCreditsRate: m.originalCreditsRate }),
    ...(m.discountEndsAtSec === undefined ? {} : { discountEndsAtSec: m.discountEndsAtSec }),
    ...(m.fallback ? { fallback: true } : {})
  }));
}

export { TRAE };
