/**
 * 第三方客户端自定义模型名的零网络解析。
 *
 * 背景：像 dshgo / web-search-deepseek 这类插件会把 model 写死成自己的口径
 * （`deepseek-v4-flash`、`DEEPSEEK_V4_FLASH`），根本不经过我们的 /v1/models，
 * 目录缓存自然是空的。原normalize 只能查 peek()/listAll()，冷启动要么 3s 超时、
 * 要么目录里没这个名字，最后原样透传给 splitModelId → 400
 * 「模型 id 必须形如 provider/model」。
 *
 * 这里用**各渠道自带的静态兜底目录**（纯 JS、进程启动即有、零网络）建一张
 * 归一化索引，在请求入口第一时间把裸名还原成真实 `provider/model`。
 *
 * 安全边界（与既有 normalize 语义一致）：
 *  - 只做无损归一化（小写 + 折叠 \s_-），不删其它字符，不模糊匹配；
 *  - 多个渠道都有同名时**返回 null 不猜**，交给下游报清晰的 400；
 *  - 只纳入已启用（登录/无需登录）渠道，禁用渠道不参与；
 *  - 最终是否禁用某个模型，由调用方再按 disabledModels 过滤。
 */
import { TRAE_FALLBACK_MODELS } from './channels/trae/product.js';
import { QODER_MODELS, QODER_CN_MODELS } from './channels/qoder/models.js';
import { fallbackMiniMaxModels } from './channels/minimax/index.js';

/** 无损归一化：只统一大小写与 \s_-，保留其它字符，避免把两个模型合并。 */
export function looseModelKey(x) {
  return String(x ?? '').toLowerCase().replace(/[\s_-]+/g, '');
}

const STATIC_SOURCES = [
  ['trae', TRAE_FALLBACK_MODELS, (m) => [m.id, m.name]],
  ['qoder', QODER_MODELS, (m) => [m.id, m.name]],
  ['qodercn', QODER_CN_MODELS, (m) => [m.id, m.name]],
  ['minimax', fallbackMiniMaxModels(), (m) => [m.id, m.displayName]]
];

const INDEX = new Map();
for (const [provider, models, namesOf] of STATIC_SOURCES) {
  for (const m of models) {
    const full = `${provider}/${m.id}`;
    for (const name of namesOf(m)) {
      const key = looseModelKey(name);
      if (!key) continue;
      const list = INDEX.get(key) || [];
      if (!list.includes(full)) list.push(full);
      INDEX.set(key, list);
    }
  }
}

/**
 * 把裸模型名解析成唯一的真实 `provider/model`。
 * @param {string} raw 客户端回传的 model（不带 `/`）
 * @param {{allowedProviders?: Set<string>}} opts 只在这些渠道里找
 * @returns {string|null} 唯一命中才返回，否则 null（不猜）
 */
export function staticModelAlias(raw, { allowedProviders } = {}) {
  const key = looseModelKey(raw);
  if (!key || key.includes('/')) return null;
  const hits = INDEX.get(key) || [];
  const usable = allowedProviders
    ? hits.filter((full) => allowedProviders.has(full.split('/')[0]))
    : hits;
  const unique = [...new Set(usable)];
  return unique.length === 1 ? unique[0] : null;
}

/** 仅供测试：当前索引收录的条目数（含 displayName 展开）。 */
export function indexSize() {
  return INDEX.size;
}
