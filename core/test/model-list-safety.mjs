/**
 * 模型目录安全性（对应「模型页一直下滑闪退」的加固）。
 *
 * App 的模型页把 `id` 直接当 LazyColumn 的 key、把 display_name 原样交给 Text
 * 排版。上游目录偶尔返回重复项、空条目或拼接脏串，会造成：
 *   - 重复 key → 滚动位置恢复错乱；
 *   - 超长文本 → 单个 Text 的 StaticLayout 撑爆内存，且只在滚到那一条才组合。
 * 因此在 listAll() 源头保证：id 唯一、展示文本有上限、档位数有上限。
 *
 * 运行：node test/model-list-safety.mjs
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

const storeOf = (disabled = {}) => ({
  settings: { accounts: [], disabledModels: disabled, modelEffort: {} }
});
const registryOf = (channels) => ({
  list: () => channels,
  get: (id) => channels.find((c) => c.id === id)
});
function channel(id, models, extra = {}) {
  return {
    id,
    supported: true,
    requiresAccount: false,
    loginMode: 'none',
    ...(extra.displayName !== undefined ? { displayName: extra.displayName } : {}),
    ...(extra.name !== undefined ? { name: extra.name } : {}),
    listModels: async () => models,
    async *stream() { yield { type: 'text', text: 'ok' }; }
  };
}
const listOf = async (channels, disabled = {}) =>
  createModelService({ registry: registryOf(channels), store: storeOf(disabled), log })
    .listAll({ force: true });

console.log('\n[1] 重复 id 去重');
{
  const list = await listOf([channel('alpha', [
    { id: 'same', displayName: '第一条' },
    { id: 'same', displayName: '第二条' },
    { id: 'other', displayName: '另一条' }
  ])]);
  ok('重复 id 只保留一条', list.length === 2, JSON.stringify(list.map((m) => m.id)));
  ok('保留的是第一条', list.find((m) => m.id === 'alpha/same')?.display_name === '第一条');
  ok('id 全局唯一', new Set(list.map((m) => m.id)).size === list.length);
}

console.log('\n[2] 跨渠道同名不误删');
{
  const list = await listOf([
    channel('alpha', [{ id: 'gpt-x' }]),
    channel('beta', [{ id: 'gpt-x' }])
  ]);
  ok('两个渠道各留一条', list.length === 2, JSON.stringify(list.map((m) => m.id)));
  ok('provider 前缀区分', list.some((m) => m.id === 'alpha/gpt-x') && list.some((m) => m.id === 'beta/gpt-x'));
}

console.log('\n[3] 超长展示字段截断');
{
  const list = await listOf([
    channel('alpha', [{ id: 'm1', displayName: 'X'.repeat(500) }], { displayName: '渠'.repeat(100) })
  ]);
  const m = list[0];
  ok('display_name 上限 120', m.display_name.length === 120, `实际 ${m.display_name.length}`);
  ok('截断处有省略号', m.display_name.endsWith('…'));
  ok('provider_name 上限 24', m.provider_name.length === 24, `实际 ${m.provider_name.length}`);
  ok('真实 id 不受影响', m.id === 'alpha/m1');
  ok('model 字段保持原值', m.model === 'm1');
}

console.log('\n[4] 档位数上限');
{
  const opts = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `V${i}` }));
  const list = await listOf([channel('alpha', [{ id: 'm1', reasoningOptions: opts }])]);
  const ro = list[0].reasoning_options || [];
  ok('档位裁到 12 条', ro.length === 12, `实际 ${ro.length}`);
  ok('保留的是前 12 条', JSON.stringify(ro[0]).includes('v0') && JSON.stringify(ro[11]).includes('v11'));
}

console.log('\n[5] 脏条目过滤');
{
  const list = await listOf([channel('alpha', [
    null, undefined, {}, { id: '' }, { id: 'ok', displayName: '正常' }
  ])]);
  ok('无 id / 空 id 不产生条目', list.length === 1 && list[0].id === 'alpha/ok',
    JSON.stringify(list.map((m) => m.id)));
  ok('没有 provider/undefined 残留', list.every((m) => !m.id.includes('undefined')));
}

console.log('\n[6] 大目录 + 大量重复（模拟长列表滚动）');
{
  const big = Array.from({ length: 600 }, (_, i) => ({ id: `m${i % 200}`, displayName: `Model ${i}` }));
  const list = await listOf([channel('alpha', big)]);
  ok('600 条去重成 200 条', list.length === 200, `实际 ${list.length}`);
  ok('200 个 id 全唯一', new Set(list.map((m) => m.id)).size === 200);
  ok('每条都有 provider_name', list.every((m) => typeof m.provider_name === 'string' && m.provider_name.length > 0));
}

console.log('\n[7] 原有逻辑不回归');
{
  const list = await listOf([channel('alpha', [{ id: 'a' }, { id: 'b' }])], { alpha: { a: true } });
  ok('禁用模型仍不出现', list.length === 1 && list[0].id === 'alpha/b');
  const short = await listOf([
    channel('alpha', [{ id: 'a-1', displayName: 'A One' }], { displayName: 'TRAE' })
  ]);
  ok('短显示名原样', short[0].display_name === 'A One');
  ok('短渠道名原样', short[0].provider_name === 'TRAE');
}

console.log(`\n✓ test/model-list-safety.mjs 通过 ${passed} 项断言`);
