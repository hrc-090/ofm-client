/**
 * 思考档位验收：档位值原样来自上游目录，只在客户端没传时注入默认值。
 * 纯 mock，不联网、不需要账号。运行：node test/effort.mjs
 */
import assert from 'node:assert/strict';

import { normalizeReasoningOptions, parseCatalog, toModelEntries } from '../src/channels/trae/models.js';
import { parseModelsResponse } from '../src/channels/minimax/index.js';
import { chatStream, createModelService } from '../src/dispatch.js';
import { effortFromBudget, thinkingEffort, normalizeEffortAgainstMenu } from '../src/effort.js';
import { normalizeChatBody } from '../src/convert/openai-chat.js';
import { anthropicToInternal } from '../src/convert/anthropic.js';

let passed = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const results = [];
async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    results.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

function fakeChannel(captured) {
  return {
    id: 'fake',
    name: 'fake',
    displayName: 'Fake',
    loginMode: 'none',
    requiresAccount: false,
    supported: true,
    async *stream(req) {
      captured.push(req);
      yield { type: 'text', text: 'ok' };
      yield { type: 'finish', reason: 'stop' };
    },
    async listModels() {
      return [
        {
          id: 'm',
          displayName: 'M',
          reasoning: true,
          reasoningOptions: [{ value: 'high', label: '高' }]
        }
      ];
    },
    // 调度层用 modelMeta 把档位对齐到目录原始值
    modelMeta: (id) => (id === 'm' ? { reasoningOptions: [{ value: 'high', label: '高' }] } : null)
  };
}

const registryOf = (ch) => ({ get: () => ch, list: () => [ch] });

async function capture(settings, reqPatch = {}) {
  const captured = [];
  const ch = fakeChannel(captured);
  const req = { model: 'fake/m', messages: [{ role: 'user', content: 'hi' }], ...reqPatch };
  // 只为把流跑完
  for await (const _ of chatStream({ registry: registryOf(ch), store: {}, settings, req, signal: null })) {
    /* drain */
  }
  return captured[0];
}

/* ───────── 1. 形状归一 ───────── */

await test('normalizeReasoningOptions：字符串 / 对象 / 去重 / 非法丢弃', async () => {
  const a = normalizeReasoningOptions(['low', 'high']);
  ok('字符串转 value+label', a.length === 2 && a[0].value === 'low' && a[0].label === 'low');

  const b = normalizeReasoningOptions([{ effort: 'medium', name: '中' }]);
  ok('{effort,name} 取 effort 原值', b[0].value === 'medium');
  ok('label 取 name', b[0].label === '中');

  const c = normalizeReasoningOptions([{ value: 'x', label: 'X' }]);
  ok('{value,label} 兼容', c[0].value === 'x' && c[0].label === 'X');

  const d = normalizeReasoningOptions([
    { effort: 'high', name: '高' },
    { effort: 'high', name: '重复项' },
    'high'
  ]);
  ok('同值去重', d.length === 1, String(d.length));
  ok('保留第一次的 label', d[0].label === '高');

  ok('null → 空数组', normalizeReasoningOptions(null).length === 0);
  ok('非数组 → 空数组', normalizeReasoningOptions('high').length === 0);
  ok('非法元素丢弃', normalizeReasoningOptions([null, 123, '', {}]).length === 0);

  const e = normalizeReasoningOptions([{ effort: '  spaced  ', name: '' }]);
  ok('value 去空白', e[0].value === 'spaced');
  ok('空 label 回退 value', e[0].label === 'spaced');
});

/* ───────── 2. 目录透传 ───────── */

await test('模型目录：档位随 entry 透出，不给面子就不编', async () => {
  const raw = parseCatalog({
    function_configs: [
      {
        function: 'solo_agent',
        config_info_list: [
          {
            config_name: 'WithEffort',
            usage: 'chat_completion',
            reasoning_effort_config: {
              support_thinking: true,
              options: [{ effort: 'low', name: '低' }, { effort: 'high', name: '高' }]
            }
          },
          {
            config_name: 'ThinkingOff',
            usage: 'chat_completion',
            reasoning_effort_config: { support_thinking: false, options: [{ effort: 'low' }] }
          },
          { config_name: 'NoConfig', usage: 'chat_completion' }
        ]
      }
    ]
  });
  const models = toModelEntries(raw);
  const withEffort = models.find((m) => m.id === 'WithEffort');
  ok('有档位：透出两个', withEffort.reasoningOptions.length === 2);
  ok('档位值未改写', withEffort.reasoningOptions.map((o) => o.value).join(',') === 'low,high');
  ok('supports_reasoning 为真', withEffort.reasoning === true);

  const off = models.find((m) => m.id === 'ThinkingOff');
  ok('support_thinking=false → 不算推理模型', off.reasoning === false);

  const none = models.find((m) => m.id === 'NoConfig');
  ok('无配置 → 空档位', none.reasoningOptions.length === 0);
  ok('无配置 → 不显示推理', none.reasoning === false);
});

await test('/api/models 输出 reasoning_options（第三方客户端可忽略）', async () => {
  const store = { settings: { accounts: [], disabledModels: {}, modelEffort: {} } };
  const svc = createModelService({ registry: registryOf(fakeChannel([])), store });
  const list = await svc.listAll();
  const fake = list.find((m) => m.id === 'fake/m');
  ok('模型在列表里', Boolean(fake));
  ok('透出 reasoning_options', Array.isArray(fake.reasoning_options));
  ok('档位值正确', fake.reasoning_options[0].value === 'high');
});

/* ───────── 2b. 多渠道档位识别（Light / High / Extra Light 这类真实档位） ───────── */

await test('归一化保留带空格 / 大小写的档位标签', async () => {
  const a = normalizeReasoningOptions([
    { effort: 'light', name: 'Light' },
    { effort: 'high', name: 'High' },
    { effort: 'extra_light', name: 'Extra Light' }
  ]);
  ok('三档都在', a.length === 3);
  ok('value 原样不改', a.map((o) => o.value).join(',') === 'light,high,extra_light');
  ok('label 保留原始文案', a.map((o) => o.label).join(' / ') === 'Light / High / Extra Light');
  ok('带空格 label 没被截断', a[2].label === 'Extra Light');

  const b = normalizeReasoningOptions(['Light', 'High', 'Extra Light']);
  ok('纯字符串也原样透传', b.length === 3 && b[2].value === 'Extra Light' && b[2].label === 'Extra Light');
});

await test('对象字典 / 其它字段名也能识别', async () => {
  const a = normalizeReasoningOptions({
    light: 'Light',
    high: { name: 'High' },
    extra_light: 'Extra Light'
  });
  ok('字典转三档', a.length === 3);
  ok('key 当 value', a[0].value === 'light');
  ok('字符串值当 label', a[0].label === 'Light');
  ok('对象值取 name', a[1].label === 'High');
  ok('字典里带空格的 label', a[2].label === 'Extra Light');

  const b = normalizeReasoningOptions([
    { reasoning_effort: 'high', title: 'High' },
    { slug: 'light', displayLabel: 'Light' }
  ]);
  ok('reasoning_effort / title 兼容', b[0].value === 'high' && b[0].label === 'High');
  ok('slug / displayLabel 兼容', b[1].value === 'light' && b[1].label === 'Light');
});

await test('Qoder 的 efforts 经 listAll 透出 reasoning_options', async () => {
  const ch = {
    ...fakeChannel([]),
    id: 'qoder',
    listModels: async () => [{
      id: 'ultimate', displayName: 'Ultimate', reasoning: true,
      efforts: ['xhigh', 'high', 'low', 'max', 'medium']
    }]
  };
  const store = { settings: { accounts: [], disabledModels: {}, modelEffort: {} } };
  const svc = createModelService({ registry: registryOf(ch), store });
  const m = (await svc.listAll()).find((x) => x.id === 'qoder/ultimate');
  ok('透出档位', Array.isArray(m?.reasoning_options) && m.reasoning_options.length === 5);
  ok('value 原样', m.reasoning_options[0].value === 'xhigh');
  ok('supports_reasoning 为真', m.supports_reasoning === true);
});

await test('MiniMax 的 effort_options 解析出来', async () => {
  const list = parseModelsResponse({
    providers: [{
      config: {
        models: {
          'MiniMax-M3': {
            name: 'M3', reasoning: false,
            effort_options: ['default', 'low', 'medium', 'high', 'xhigh', 'max']
          }
        }
      }
    }]
  });
  ok('解析出模型', list.length === 1);
  ok('档位数量', list[0].reasoningOptions.length === 6);
  ok('value 原样', list[0].reasoningOptions[0].value === 'default');
  ok('有档位即算可推理', list[0].reasoning === true);
});

await test('没有声明档位的模型不编造档位', async () => {
  const ch = {
    ...fakeChannel([]),
    id: 'plain',
    listModels: async () => [{ id: 'p', displayName: 'P', reasoning: false }]
  };
  const store = { settings: { accounts: [], disabledModels: {}, modelEffort: {} } };
  const svc = createModelService({ registry: registryOf(ch), store });
  const m = (await svc.listAll()).find((x) => x.id === 'plain/p');
  ok('不下发 reasoning_options', m?.reasoning_options === undefined);
  ok('supports_reasoning 为假', m.supports_reasoning === false);
});

/* ───────── 3. 默认注入 ───────── */

await test('客户端没传时注入 App 里配的默认档位', async () => {
  const req = await capture({ modelEffort: { 'fake/m': 'high' } });
  ok('完整 id 命中', req.reasoningEffort === 'high', String(req.reasoningEffort));

  const req2 = await capture({ modelEffort: { m: 'low' }, accounts: [], disabledModels: {} });
  ok('裸 modelId 也能命中', req2.reasoningEffort === 'low');

  const req3 = await capture({ modelEffort: { 'fake/other': 'high' } });
  ok('未配置的模型不注入', req3.reasoningEffort === undefined, String(req3.reasoningEffort));

  const req4 = await capture({ modelEffort: { 'fake/m': '' } });
  ok('空串配置视为未配置', req4.reasoningEffort === undefined);
});

await test('客户端显式传了档位就绝不覆盖', async () => {
  const req = await capture({ modelEffort: { 'fake/m': 'low' } }, { reasoningEffort: 'high' });
  ok('保留客户端值', req.reasoningEffort === 'high', String(req.reasoningEffort));

  const req2 = await capture({ modelEffort: { 'fake/m': 'high' } }, { reasoningEffort: '' });
  ok('空串等于没传，使用默认', req2.reasoningEffort === 'high');

  const req3 = await capture({ modelEffort: {} }, { reasoningEffort: 'medium' });
  ok('没有默认值时原样透传', req3.reasoningEffort === 'medium');
});

await test('settings 缺失也不炸', async () => {
  const req = await capture(undefined);
  ok('无 settings 时正常出正文', req.reasoningEffort === undefined);
});

/* ───────── 4. 第三方：读得到 / 设得动（M39） ───────── */

await test('目录下发三种档位形状，第三方按认识的字段读', async () => {
  const ch = {
    ...fakeChannel([]),
    id: 'multi',
    listModels: async () => [{
      id: 'm', displayName: 'M', reasoning: true,
      efforts: ['xhigh', 'high', 'low', 'max', 'medium'],
      defaultEffort: 'high'
    }]
  };
  const store = { settings: { accounts: [], disabledModels: {}, modelEffort: {} } };
  const svc = createModelService({ registry: registryOf(ch), store });
  const m = (await svc.listAll()).find((x) => x.id === 'multi/m');
  ok('reasoning_options 仍在', Array.isArray(m.reasoning_options) && m.reasoning_options.length === 5);
  ok('扁平值数组', m.supported_reasoning_efforts.join(',') === 'xhigh,high,low,max,medium');
  ok('默认档位（原值）', m.default_reasoning_effort === 'high');
  ok('OpenRouter 形状', m.reasoning?.supported_efforts?.length === 5);
  ok('默认档位也进 reasoning', m.reasoning?.default_effort === 'high');
  ok('supported_parameters 含 reasoning', m.supported_parameters.includes('reasoning'));
});

await test('默认档位不在菜单里时不下发（不猜）', async () => {
  const ch = {
    ...fakeChannel([]),
    id: 'd',
    listModels: async () => [{ id: 'm', displayName: 'M', reasoning: true, efforts: ['low', 'high'], defaultEffort: 'xhigh' }]
  };
  const store = { settings: { accounts: [], disabledModels: {}, modelEffort: {} } };
  const svc = createModelService({ registry: registryOf(ch), store });
  const m = (await svc.listAll()).find((x) => x.id === 'd/m');
  ok('没有 default_reasoning_effort', m.default_reasoning_effort === undefined);
  ok('reasoning 里也没有', m.reasoning?.default_effort === undefined);
});

await test('normalizeEffortAgainstMenu：大小写 / 同义 / 未知值', () => {
  ok('大小写对齐', normalizeEffortAgainstMenu('HIGH', ['high', 'low']) === 'high');
  ok('同义档位落到菜单值', normalizeEffortAgainstMenu('deep', ['low', 'max']) === 'max');
  ok('medium → balanced 同族', normalizeEffortAgainstMenu('medium', ['low', 'balanced', 'max']) === 'balanced');
  ok('未知值原样放行', normalizeEffortAgainstMenu('turbo', ['low', 'high']) === 'turbo');
  ok('空菜单不动', normalizeEffortAgainstMenu('high', []) === 'high');
  ok('非字符串安全', normalizeEffortAgainstMenu(undefined, ['high']) === undefined);
});

await test('thinking.budget_tokens → 三档', () => {
  ok('2000 → light', effortFromBudget(2000) === 'light');
  ok('8000 → balanced', effortFromBudget(8000) === 'balanced');
  ok('32000 → deep', effortFromBudget(32000) === 'deep');
  ok('非法预算 → null', effortFromBudget('abc') === null);
  ok('enabled 无预算 → high', thinkingEffort({ thinking: { type: 'enabled' } }) === 'high');
  ok('disabled 不干预', thinkingEffort({ thinking: { type: 'disabled', budget_tokens: 4096 } }) === null);
  ok('没有 thinking 字段', thinkingEffort({}) === null);
});

await test('OpenAI chat：thinking.budget_tokens 也能设档位', () => {
  const b = normalizeChatBody({ messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 8000 } });
  ok('8000 → balanced', b.reasoningEffort === 'balanced', String(b.reasoningEffort));

  const b2 = normalizeChatBody({ messages: [], reasoning_effort: 'HIGH' });
  ok('显式字段优先且原样保留大小写', b2.reasoningEffort === 'HIGH');
});

await test('Anthropic：output_config.effort 优先，其次预算', () => {
  const a = anthropicToInternal({
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'xhigh' },
    thinking: { type: 'enabled', budget_tokens: 2000 }
  });
  ok('显式 effort 生效', a.reasoningEffort === 'xhigh', String(a.reasoningEffort));

  const b = anthropicToInternal({
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 20000 }
  });
  ok('预算换算生效（不再写死 high）', b.reasoningEffort === 'deep', String(b.reasoningEffort));

  const c = anthropicToInternal({ messages: [{ role: 'user', content: 'hi' }] });
  ok('没设就不干预', c.reasoningEffort === undefined);
});

await test('调度层：客户端写的档位会对齐到目录原始值', async () => {
  const req = await capture({}, { reasoningEffort: 'HIGH' });
  ok('大小写被对齐', req.reasoningEffort === 'high', String(req.reasoningEffort));

  const req2 = await capture({}, { reasoningEffort: 'deep' });
  ok('同义档位落到 high', req2.reasoningEffort === 'high', String(req2.reasoningEffort));

  const req3 = await capture({}, { reasoningEffort: 'turbo' });
  ok('未知值原样透传，不拦', req3.reasoningEffort === 'turbo');
});

/* ───────── 汇总 ───────── */

console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/effort.mjs 通过 ${passed} 项断言`);
