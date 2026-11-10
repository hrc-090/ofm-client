/**
 * TRAE 模型目录验收：对齐上游 dsh-our-free-model 的「远端失败 → 兜底目录」语义。
 * 纯 mock，不联网、不需要真实账号。
 * 运行：node test/trae-models.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseCatalog,
  fallbackModelEntries,
  fetchModels,
  toModelEntries,
  readConsumptionRate,
  readActivityDiscount
} from '../src/channels/trae/models.js';
import { TraeChannel } from '../src/channels/trae/index.js';
import { TRAE, TRAE_PATHS, TRAE_CHANNELS, TRAE_FUNCTIONS, TRAE_FALLBACK_MODELS } from '../src/channels/trae/product.js';
import { createModelService } from '../src/dispatch.js';
import { createApp } from '../src/server.js';

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

const CRED = {
  access_token: 'SECRET_ACCESS_TOKEN_eyJhbGciOiJSUzI1NiJ9.payload.signature',
  refresh_token: 'r',
  expires_at: Date.now() + 3600000,
  uid: '1554032590596819',
  machine_id: 'a'.repeat(32),
  device_id: 'b'.repeat(32)
};

function group(functionName, items) {
  return { function: functionName, config_info_list: items };
}
function item(id, extra = {}) {
  return { config_name: id, display_config: { display_name: id }, ...extra };
}

const BATCH_OK = {
  function_configs: [
    group('solo_agent', [item('glm-5.2', { usage: 'chat_completion' }), item('kimi-k3', { usage: 'chat_completion' })]),
    group('chat', [item('should-be-dropped', { usage: 'chat_completion' })]), // 不在白名单
    group('solo_work_lite', [
      item('hidden-one', { usage: 'chat_completion', is_invisible_to_user: true }),
      item('off-one', { usage: 'chat_completion', config_switch: false }),
      item('multimodal-one', { usage: 'multimodal' }),
      item('custom-one', { usage: 'chat_completion', display_config: { is_custom_model: true } })
    ])
  ]
};

/* ───────── 1. 协议常量与上游一致 ───────── */
await test('协议常量逐字对齐上游', async () => {
  ok('agentHost', TRAE.agentHost === 'https://trae-api-cn.mchost.guru');
  ok('oauthHost', TRAE.oauthHost === 'https://api.trae.com.cn');
  ok('batch 端点', TRAE_PATHS.batchModels === '/api/ide/v1/batch_get_detail_param');
  ok('single 端点', TRAE_PATHS.singleModels === '/api/ide/v1/get_detail_param');
  ok('22 个 functions', TRAE_FUNCTIONS.length === 22, `实际 ${TRAE_FUNCTIONS.length}`);
  ok('15 个可调用通道', TRAE_CHANNELS.length === 15, `实际 ${TRAE_CHANNELS.length}`);
  ok('首位 solo_agent', TRAE_CHANNELS[0] === 'solo_agent');
  ok('默认通道', TRAE.function === 'solo_work_lite');
});

/* ───────── 2. 目录解析 ───────── */
await test('batch 目录解析与四条硬过滤', async () => {
  const m = parseCatalog(BATCH_OK);
  const ids = m.map((x) => x.id);
  ok('取到可调用模型', ids.includes('glm-5.2') && ids.includes('kimi-k3'), ids.join(','));
  ok('非白名单通道整组丢弃', !ids.includes('should-be-dropped'));
  ok('隐藏条目丢弃', !ids.includes('hidden-one'));
  ok('停用条目丢弃', !ids.includes('off-one'));
  ok('非 chat_completion 丢弃', !ids.includes('multimodal-one'));
  ok('自定义模型丢弃', !ids.includes('custom-one'));
});

await test('单通道顶层 config_info_list', async () => {
  const m = parseCatalog({ config_info_list: [item('single-model')] });
  ok('解析出 1 条', m.length === 1 && m[0].id === 'single-model');
  ok('通道回落到默认', m[0].channel === TRAE.function);
});

await test('积分消耗倍率：字符串 JSON 二次解析', async () => {
  const contact = (obj) => JSON.stringify(obj);
  ok(
    '0.08 正常读出',
    readConsumptionRate({ display_contact_config: contact({ consumption_rate: { enable: true, data: { rate: 0.08 } } }) }) === 0.08
  );
  // 0 是合法值（免费模型），用 >0 过滤会把用户最关心的免费模型全漏掉
  ok(
    'rate:0 保留（免费）',
    readConsumptionRate({ display_contact_config: contact({ consumption_rate: { data: { rate: 0 } } }) }) === 0
  );
  ok(
    'enable:false 不显示（不是当 0）',
    readConsumptionRate({ display_contact_config: contact({ consumption_rate: { enable: false, data: { rate: 0.5 } } }) }) === undefined
  );
  ok(
    '对象形态不认（上游是字符串）',
    readConsumptionRate({ display_contact_config: { consumption_rate: { data: { rate: 0.5 } } } }) === undefined
  );
  ok('坏 JSON 不抛错', readConsumptionRate({ display_contact_config: '{"oops' }) === undefined);
  ok('缺字段返回 undefined', readConsumptionRate({}) === undefined);
});

await test('活动折扣：只在真降价且未过期时生效', async () => {
  const now = 1_800_000_000;
  const mk = (current) =>
    JSON.stringify({
      consumption_rate: { data: { rate: current.consumption_rate } },
      activity_discount: { enable: true, data: { current } }
    });
  const live = readActivityDiscount(
    { display_contact_config: mk({ discount_type: 'limited', before_consumption_rate: 0.2, consumption_rate: 0.08, end_at: now + 3600 }) },
    now
  );
  ok('真降价返回原价', live?.originalRate === 0.2);
  ok('带截止时间', live?.endsAtSec === now + 3600);

  ok(
    'discount_type=none 不展示',
    readActivityDiscount(
      { display_contact_config: mk({ discount_type: 'none', before_consumption_rate: 0.13, consumption_rate: 0.13 }) },
      now
    ) === undefined
  );
  ok(
    'before === after 不展示',
    readActivityDiscount(
      { display_contact_config: mk({ discount_type: 'off_peak', before_consumption_rate: 0.13, consumption_rate: 0.13 }) },
      now
    ) === undefined
  );
  ok(
    '已过期不展示',
    readActivityDiscount(
      { display_contact_config: mk({ discount_type: 'limited', before_consumption_rate: 0.2, consumption_rate: 0.08, end_at: now - 1 }) },
      now
    ) === undefined
  );
  ok(
    'enable:false 不展示',
    readActivityDiscount(
      { display_contact_config: JSON.stringify({ activity_discount: { enable: false, data: { current: { discount_type: 'limited', before_consumption_rate: 9, consumption_rate: 1 } } } }) },
      now
    ) === undefined
  );
});

await test('目录条目带倍率，并透传到模型条目', async () => {
  const body = {
    function_configs: [
      group('solo_agent', [
        item('paid', {
          usage: 'chat_completion',
          display_contact_config: JSON.stringify({
            consumption_rate: { enable: true, data: { rate: 0.08 } },
            activity_discount: {
              enable: true,
              data: { current: { discount_type: 'limited', before_consumption_rate: 0.13, consumption_rate: 0.08, end_at: 4102444800 } }
            }
          })
        }),
        item('free', { usage: 'chat_completion', display_contact_config: JSON.stringify({ consumption_rate: { data: { rate: 0 } } }) }),
        item('plain', { usage: 'chat_completion' })
      ])
    ]
  };
  const parsed = parseCatalog(body);
  const by = Object.fromEntries(parsed.map((m) => [m.id, m]));
  ok('倍率进目录', by.paid.creditsRate === 0.08);
  ok('折扣原价进目录', by.paid.originalCreditsRate === 0.13);
  ok('折扣截止时间进目录', by.paid.discountEndsAtSec === 4102444800);
  ok('免费模型是 0 不是缺失', by.free.creditsRate === 0);
  ok('无倍率字段保持 undefined', by.plain.creditsRate === undefined);

  const entries = toModelEntries(parsed).map((m) => m.id);
  ok('透传不丢模型', entries.length === 3, entries.join(','));
  const paid = toModelEntries(parsed).find((m) => m.id === 'paid');
  ok('toModelEntries 保留倍率', paid.creditsRate === 0.08 && paid.originalCreditsRate === 0.13);
});

await test('data 信封与大写字段名', async () => {
  const m = parseCatalog({
    data: {
      FunctionConfigs: [{ Function: 'solo_agent', ConfigInfoList: [{ ConfigName: 'CamelCase', DisplayConfig: {} }] }]
    }
  });
  ok('信封解包 + 驼峰兼容', m.length === 1 && m[0].id === 'CamelCase');
  ok('脏数据返回空', parseCatalog(null).length === 0 && parseCatalog({ foo: 1 }).length === 0);
});

await test('思考档位优先于通道覆盖', async () => {
  const body = {
    function_configs: [
      group('solo_work_lite', [item('m', { usage: 'chat_completion' })]),
      group('solo_agent', [
        item('m', {
          usage: 'chat_completion',
          reasoning_effort_config: { support_thinking: true, options: [{ value: 'high' }] }
        })
      ])
    ]
  };
  const m = parseCatalog(body);
  ok('保留带档位的条目', m.length === 1 && m[0].reasoningOptions.length === 1);
});

/* ───────── 3. 兜底目录 ───────── */
await test('静态兜底目录：28 条、不重复、全带标记', async () => {
  const entries = fallbackModelEntries();
  ok('条数 28', entries.length === 28, `实际 ${entries.length}`);
  ok('与上游快照一致', TRAE_FALLBACK_MODELS.length === entries.length);
  ok('id 唯一', new Set(entries.map((e) => e.id)).size === entries.length);
  ok('全带 fallback:true', entries.every((e) => e.fallback === true));
  ok('不含隐藏条目', !entries.some((e) => /sub_agent|^summary$|browser_use/.test(e.id)));
  ok('可用作对话模型', entries.every((e) => e.function === TRAE.function));
});

/* ───────── 4. fetchModels 两次尝试 ───────── */
await test('batch 失败 → 单通道成功', async () => {
  const calls = [];
  const requestImpl = async (url) => {
    calls.push(url);
    if (url.includes('batch_get_detail_param')) return { status: 502, json: null, text: 'bad gateway' };
    return { status: 200, json: { config_info_list: [item('single-ok')] } };
  };
  const models = await fetchModels({ credential: CRED, requestImpl });
  ok('调用了两个端点', calls.length === 2, calls.join(','));
  ok('拿到单通道模型', models.length === 1 && models[0].id === 'single-ok');
});

await test('两个端点都失败 → 抛错且原因可读、不含凭据', async () => {
  const requestImpl = async () => ({ status: 401, json: null, text: 'unauthorized' });
  let err = null;
  try {
    await fetchModels({ credential: CRED, requestImpl });
  } catch (e) {
    err = e;
  }
  ok('抛出错误', Boolean(err));
  ok('错误里说明鉴权失败', /401|鉴权/.test(err.message), err.message);
  ok('错误里没有 token', !err.message.includes('SECRET_ACCESS_TOKEN'));
});

/* ───────── 5. 渠道：远端失败回退兜底 ───────── */
await test('TraeChannel 远端失败 → 兜底目录且不抛错', async () => {
  const ch = new TraeChannel({
    fetchModelsImpl: async () => {
      throw new Error(`Cloud-IDE-JWT ${CRED.access_token} 上游连接失败: ENETUNREACH`);
    }
  });
  const entries = await ch.listModels({ account: { generation: 0 }, credential: CRED });
  ok('返回 28 条兜底', entries.length === 28, `实际 ${entries.length}`);
  ok('全带 fallback', entries.every((e) => e.fallback === true));
  ok('记录了失败原因', typeof ch.lastModelWarning === 'string' && ch.lastModelWarning.includes('ENETUNREACH'));
  ok('失败原因已脱敏', !ch.lastModelWarning.includes('SECRET_ACCESS_TOKEN'));
  ok('modelIndex 已填充', ch.modelIndex.size === 28);
});

await test('TraeChannel 远端成功 → 不用兜底、清空警告', async () => {
  const ch = new TraeChannel({
    fetchModelsImpl: async () => parseCatalog(BATCH_OK)
  });
  const entries = await ch.listModels({ account: {}, credential: CRED });
  ok('用远端目录', entries.length === 2, `实际 ${entries.length}`);
  ok('无 fallback 标记', entries.every((e) => !e.fallback));
  ok('警告已清空', ch.lastModelWarning === null);
  ok('toModelEntries 保留通道', toModelEntries(parseCatalog(BATCH_OK)).every((e) => e.function));
});

/* ───────── 6. modelService 诊断 ───────── */
function fakeStore(accounts, cred) {
  return {
    settings: {
      accounts,
      disabledModels: {},
      forward: { key: 'ofm-local-key', port: 18900, host: '127.0.0.1' },
      enabled: true
    },
    readCredential: () => cred,
    writeCredential: () => {},
    update: () => {}
  };
}

await test('modelService：兜底时 diagnostics.source=fallback', async () => {
  const ch = new TraeChannel({ fetchModelsImpl: async () => { throw new Error('HTTP 401 目录鉴权失败'); } });
  const registry = { get: () => ch, list: () => [] };
  const svc = createModelService({ registry, store: fakeStore([{ id: 'a1', provider: 'trae', enabled: true }], CRED), log: { warn() {} } });
  const list = await svc.listAll({ force: true });
  ok('列表非空', list.length === 28, `实际 ${list.length}`);
  ok('条目带 fallback', list.every((m) => m.fallback === true));
  const d = svc.diagnostics().find((x) => x.provider === 'trae');
  ok('诊断存在', Boolean(d));
  ok('source=fallback', d.source === 'fallback');
  ok('诊断带原因', typeof d.warning === 'string' && d.warning.includes('401'));
  ok('诊断不含凭据', !JSON.stringify(d).includes('SECRET_ACCESS_TOKEN'));
});

await test('modelService：倍率透出到 /v1/models 字段', async () => {
  const remote = parseCatalog({
    function_configs: [
      group('solo_agent', [
        item('paid', {
          usage: 'chat_completion',
          display_contact_config: JSON.stringify({
            consumption_rate: { enable: true, data: { rate: 0.08 } },
            activity_discount: {
              enable: true,
              data: { current: { discount_type: 'limited', before_consumption_rate: 0.13, consumption_rate: 0.08, end_at: 4102444800 } }
            }
          })
        }),
        item('free', { usage: 'chat_completion', display_contact_config: JSON.stringify({ consumption_rate: { data: { rate: 0 } } }) }),
        item('plain', { usage: 'chat_completion' })
      ])
    ]
  });
  const ch = new TraeChannel({ fetchModelsImpl: async () => remote });
  const registry = { get: () => ch, list: () => [] };
  const svc = createModelService({
    registry,
    store: fakeStore([{ id: 'a1', provider: 'trae', enabled: true }], CRED),
    log: { warn() {} }
  });
  const list = await svc.listAll({ force: true });
  const by = Object.fromEntries(list.map((m) => [m.model, m]));
  ok('credits_rate 透出', by.paid.credits_rate === 0.08);
  ok('折扣原价透出', by.paid.original_credits_rate === 0.13);
  ok('折扣截止时间转毫秒', by.paid.discount_ends_at === 4102444800000);
  ok('免费模型 credits_rate=0 不被吞', by.free.credits_rate === 0);
  ok('原价缺省不出现', !('original_credits_rate' in by.free));
  ok('无倍率的模型不编造字段', !('credits_rate' in by.plain));
});

await test('modelService：无账号时 source=no-account', async () => {
  const registry = { get: () => ({ requiresAccount: true }), list: () => [] };
  const svc = createModelService({ registry, store: fakeStore([], CRED), log: { warn() {} } });
  await svc.listAll({ force: true });
  ok('无诊断项（无 provider 可查）', Array.isArray(svc.diagnostics()));
});

/* ───────── 7. 端到端：/v1/models 与 /api/models ───────── */
await test('端到端：连接 TRAE 后第三方与 App 都能拿到模型', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-trae-test-'));
  const ch = new TraeChannel({ fetchModelsImpl: async () => { throw new Error('上游连接失败: ECONNRESET'); } });
  const registry = { get: (p) => (p === 'trae' ? ch : null), list: () => [] };
  const uiToken = 'test-ui-token';
  const { server, store } = createApp({ dataDir, registry, uiToken, log: { warn() {} } });
  store.upsertAccount({ id: 'a1', provider: 'trae', enabled: true, nickname: 'TRAE', credentialRef: 'r1' });
  store.writeCredential('r1', CRED);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r1 = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer ofm-local-key' } });
    const j1 = await r1.json();
    ok('/v1/models 200', r1.status === 200);
    ok('第三方拿到 28 个模型', j1.data.length === 28, `实际 ${j1.data.length}`);
    ok('真实 id 带 provider 前缀', j1.data[0].real_id === 'trae/DeepSeek-V4-Flash-Official');
    // 该用例的 registry 桩 list() 为空，渠道名回退成 provider id「trae」
    ok('id 未被装饰', j1.data[0].id === 'trae/DeepSeek-V4-Flash-Official');
    ok('display_name 前置渠道名', j1.data[0].display_name.startsWith('[trae]'));
    ok('第三方响应带 diagnostics', Array.isArray(j1.diagnostics) && j1.diagnostics[0].source === 'fallback');
    ok('第三方响应不含凭据', !JSON.stringify(j1).includes('SECRET_ACCESS_TOKEN'));

    const r2 = await fetch(`${base}/api/models`, { headers: { 'x-ofm-ui-token': uiToken } });
    const j2 = await r2.json();
    ok('/api/models 200', r2.status === 200);
    ok('App 看到兜底提示', /兜底目录/.test(j2.hint || ''), j2.hint);
    ok('提示不含凭据', !JSON.stringify(j2).includes('SECRET_ACCESS_TOKEN'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

console.log(`\n通过 ${passed} 项`);
if (results.length) {
  console.error(`失败 ${results.length} 项:\n${results.join('\n')}`);
  process.exit(1);
}
