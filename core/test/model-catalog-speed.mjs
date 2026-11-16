/**
 * 模型目录拉取速度（对应「兜底显示正常、拉取失败 —— 其实是拉取太慢」）。
 *
 * 根因：listAll() 以前串行 for...of + await，任一渠道卡住（TRAE 两次各 30s）
 * 就把整批拖过 App 的 20s 读超时，界面只显示旧数据/兜底。
 * 修复：所有渠道并行拉取，单渠道 CATALOG_TIMEOUT_MS 硬上限，超时只降级该渠道。
 *
 * 本测试验证：
 *   - 慢渠道不阻塞快渠道（总耗时≈最慢单个，而非累加）；
 *   - 单渠道超时后返回空/沿用缓存，不抛给整批；
 *   - 超时渠道的诊断写明原因；
 *   - 并行后输出顺序仍按 provider 原始顺序稳定。
 *
 * 运行：node test/model-catalog-speed.mjs
 */
import assert from 'node:assert/strict';
import { createModelService } from '../src/dispatch.js';

const log = { log() {}, warn() {}, error() {} };
let passed = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const storeOf = (accounts = []) => ({
  settings: { accounts, disabledModels: {}, modelEffort: {} }
});
const registryOf = (channels) => ({
  list: () => channels,
  get: (id) => channels.find((c) => c.id === id)
});
const channel = (id, { models = [], delayMs = 0, displayName } = {}) => ({
  id,
  supported: true,
  requiresAccount: false,
  loginMode: 'none',
  ...(displayName ? { displayName } : {}),
  listModels: async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return models;
  },
  async *stream() { yield { type: 'text', text: 'ok' }; }
});

console.log('\n[1] 慢渠道不阻塞快渠道（并行 vs 串行）');
{
  // 三个渠道各延迟 300ms。串行要 ~900ms，并行应 ~300ms。
  // 放宽到 650ms，足以区分，又不因 CI 抖动误报。
  const svc = createModelService({
    registry: registryOf([
      channel('slow-a', { models: [{ id: 'a1' }], delayMs: 300 }),
      channel('slow-b', { models: [{ id: 'b1' }], delayMs: 300 }),
      channel('slow-c', { models: [{ id: 'c1' }], delayMs: 300 })
    ]),
    store: storeOf(),
    log
  });
  const t0 = Date.now();
  const list = await svc.listAll({ force: true });
  const elapsed = Date.now() - t0;
  ok('三个渠道都有模型', list.length === 3, `got ${list.length}`);
  ok('并行耗时明显小于串行累加', elapsed < 650, `elapsed=${elapsed}ms (串行约 900ms)`);
}

console.log('\n[2] 单渠道超时不拖垮整批');
{
  // 一个渠道 15s（超过 CATALOG_TIMEOUT_MS=12s），但它不能让其他渠道等 15s。
  // 为把测试控制在秒级，这里用 force 且注入超长延迟，验证超时上限生效：
  // 整批应在 ~12s 内返回，而不是 15s；超时渠道降级为空，其他渠道正常。
  const svc = createModelService({
    registry: registryOf([
      channel('fast', { models: [{ id: 'ok1' }] }),
      channel('hang', { models: [{ id: 'never' }], delayMs: 15000 })
    ]),
    store: storeOf(),
    log
  });
  const t0 = Date.now();
  const list = await svc.listAll({ force: true });
  const elapsed = Date.now() - t0;
  ok('快渠道正常返回', list.some((m) => m.id === 'fast/ok1'));
  ok('超时渠道被降级（never 没进列表）', !list.some((m) => m.id === 'hang/never'));
  ok('整批在超时上限附近返回而非等满 15s', elapsed < 14000, `elapsed=${elapsed}ms`);
  const d = svc.diagnostics().find((x) => x.provider === 'hang');
  ok('超时原因写进诊断', !!d && /超时/.test(d.warning || ''), JSON.stringify(d));
}

console.log('\n[3] 超时渠道沿用上次缓存');
{
  // 用可控开关：先快速拉一次填缓存，再切换到慢速，验证超时后是否沿用缓存。
  let slow = false;
  const cc = channel('hang', { models: [{ id: 'cached' }] });
  cc.listModels = async () => {
    if (slow) await new Promise((r) => setTimeout(r, 15000));
    return [{ id: 'cached' }];
  };
  const svc2 = createModelService({ registry: registryOf([cc]), store: storeOf(), log });
  await svc2.listAll({ force: true }); // 缓存 cached
  slow = true;
  const t0 = Date.now();
  const list = await svc2.listAll({ force: true });
  const elapsed = Date.now() - t0;
  ok('超时后沿用缓存里的模型', list.some((m) => m.id === 'hang/cached'));
  ok('沿用缓存比等满 15s 快', elapsed < 14000, `elapsed=${elapsed}ms`);
  const d = svc2.diagnostics().find((x) => x.provider === 'hang');
  ok('诊断标注沿用上次目录', !!d && /沿用上次/.test(d.warning || ''), JSON.stringify(d));
}

console.log('\n[4] 并行后输出顺序稳定');
{
  const svc = createModelService({
    registry: registryOf([
      channel('第一', { models: [{ id: 'x' }], delayMs: 120 }),
      channel('第二', { models: [{ id: 'y' }], delayMs: 20 }),
      channel('第三', { models: [{ id: 'z' }], delayMs: 60 })
    ]),
    store: storeOf(),
    log
  });
  const list = await svc.listAll({ force: true });
  ok('按注册顺序输出（非完成顺序）',
    list.map((m) => m.provider).join(',') === '第一,第二,第三',
    list.map((m) => m.provider).join(','));
}

console.log(`\n✓ model-catalog-speed.mjs 通过 ${passed} 项断言`);
