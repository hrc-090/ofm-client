/**
 * MiniMax 模型目录验收。真实配置接口是公开 GET /mavis/api/v1/models，
 * 返回 providers[].config.models **字典**（key 才是模型 id）。
 * 旧版只认 data.models 数组 → 恒空列表且不报错，即「拉不到模型」。
 * 纯 mock，不联网、不需要账号。运行：node test/minimax-models.mjs
 */
import assert from 'node:assert/strict';

import { MiniMaxChannel, parseModelsResponse, fallbackMiniMaxModels } from '../src/channels/minimax/index.js';
import { createModelService } from '../src/dispatch.js';

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

/** 实测抓到的公开配置形状（精简保留关键字段） */
const FIXTURE = {
  version: '1.0',
  ttlSeconds: 300,
  providers: [
    {
      providerId: 'minimax',
      config: {
        name: 'MiniMax',
        npm: '@ai-sdk/anthropic',
        models: {
          'MiniMax-M3': {
            name: 'M3',
            reasoning: true,
            tool_call: true,
            limit: { context: 512000, output: 128000 },
            modalities: { input: ['text', 'image', 'video'], output: ['text'] },
            thinking_config: { mode: 'switchable', default_value: 'true' }
          },
          'MiniMax-M3.1-Flash': {
            name: 'M3.1-Flash',
            reasoning: true,
            limit: { context: 512000, output: 128000 },
            modalities: { input: ['text', 'image'], output: ['text'] },
            effort_options: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
            default_effort: 'default'
          }
        },
        model_order: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
        whitelist: ['MiniMax-M3', 'MiniMax-M3.1-Flash']
      }
    }
  ]
};

function channelWith(res) {
  const ch = new MiniMaxChannel();
  ch.fetchModelsImpl = async ({ credential } = {}) => {
    channelWith.lastCredential = credential;
    return res;
  };
  ch.credential = async () => ({ access_token: 'test-token' });
  return ch;
}

const RESP = (json, status = 200) => ({ status, json, text: JSON.stringify(json) });

/* ───────── 1. 解析真实形状 ───────── */

await test('真实 providers[].config.models 字典解析出 2 个模型', () => {
  const list = parseModelsResponse(FIXTURE);
  ok('数量', list.length === 2, String(list.length));
  ok('id 是字典 key 而不是 name', list.some((m) => m.id === 'MiniMax-M3'), JSON.stringify(list.map((m) => m.id)));
  ok('displayName 取 name', list.some((m) => m.displayName === 'M3.1-Flash'));
  ok('contextWindow 取 limit.context', list.every((m) => m.contextWindow === 512000));
  ok('maxOutputTokens 取 limit.output', list.every((m) => m.maxOutputTokens === 128000));
  ok('多模态读 modalities.input', list.every((m) => m.multimodal === true));
  ok('推理读 reasoning 字段', list.every((m) => m.reasoning === true));
});

await test('按 model_order 排序（Flash 在前）', () => {
  const list = parseModelsResponse(FIXTURE);
  ok('首项是 Flash', list[0].id === 'MiniMax-M3.1-Flash', list[0].id);
  ok('次项是 M3', list[1].id === 'MiniMax-M3');
});

await test('没有 model_order 时保持字典原顺序', () => {
  const f = JSON.parse(JSON.stringify(FIXTURE));
  delete f.providers[0].config.model_order;
  const list = parseModelsResponse(f);
  ok('首项是 M3', list[0].id === 'MiniMax-M3', list[0].id);
});

/* ───────── 2. 兼容其它形状 ───────── */

await test('config.models 为数组时也认', () => {
  const list = parseModelsResponse({
    providers: [{ config: { models: [{ id: 'MM-1', name: '一号', limit: { context: 1000 } }] } }]
  });
  ok('解析出 1 个', list.length === 1);
  ok('id 正确', list[0].id === 'MM-1');
  ok('displayName 正确', list[0].displayName === '一号');
});

await test('旧扁平形状 data.models 数组兼容', () => {
  const list = parseModelsResponse({ data: { models: [{ id: 'old', thinking: true, context_window: 8000 }] } });
  ok('解析出 1 个', list.length === 1);
  ok('推理兼容 thinking', list[0].reasoning === true);
  ok('上下文兼容 context_window', list[0].contextWindow === 8000);
});

await test('顶层 models 数组兼容', () => {
  const list = parseModelsResponse({ models: [{ model: 'x', vision: true }] });
  ok('解析出 1 个', list.length === 1);
  ok('id 用 model 字段', list[0].id === 'x');
  ok('多模态兼容 vision', list[0].multimodal === true);
});

await test('providers 没有 config 时用 p.models', () => {
  const list = parseModelsResponse({ providers: [{ models: { A: { name: 'AA' } } }] });
  ok('解析出 1 个', list.length === 1 && list[0].id === 'A');
});

await test('认不出的形状与空值返回空数组（由上层抛错，不再静默）', () => {
  ok('空对象', parseModelsResponse({}).length === 0);
  ok('null', parseModelsResponse(null).length === 0);
  ok('未知 envelope', parseModelsResponse({ whatever: 1 }).length === 0);
});

/* ───────── 3. listModels 正常 / 失败 / 兜底 ───────── */

await test('HTTP 200 + 真实形状 → 正常返回且清空告警', async () => {
  const ch = channelWith(RESP(FIXTURE));
  ch.lastModelWarning = '上次失败';
  const list = await ch.listModels({ credential: { access_token: 'test-token' } });
  ok('返回 2 个', list.length === 2);
  ok('不标记 fallback', list.every((m) => !m.fallback));
  ok('告警已清空', ch.lastModelWarning === null, String(ch.lastModelWarning));
  ok('凭据透传给 fetch', channelWith.lastCredential?.access_token === 'test-token');
});

await test('HTTP 400 → 兜底目录 + 告警', async () => {
  const ch = channelWith({ status: 400, json: {}, text: '{"msg":"bad request"}' });
  const list = await ch.listModels({ credential: {} });
  ok('兜底 2 个', list.length === 2);
  ok('标记 fallback', list.every((m) => m.fallback === true));
  ok('告警含状态码', /400/.test(ch.lastModelWarning || ''), String(ch.lastModelWarning));
});

await test('HTTP 200 但形状未识别 → 兜底且告警带响应样本', async () => {
  const ch = channelWith({ status: 200, json: { unexpected: 1 }, text: '{"unexpected":1}' });
  const list = await ch.listModels({ credential: {} });
  ok('兜底 2 个', list.length === 2);
  ok('告警含「形状未识别」', /形状未识别/.test(ch.lastModelWarning || ''), String(ch.lastModelWarning));
  ok('告警带样本', /unexpected/.test(ch.lastModelWarning || ''));
});

await test('目录为空数组 → 兜底而不是静默空列表', async () => {
  const ch = channelWith(RESP({ providers: [{ config: { models: {} } }] }));
  const list = await ch.listModels({ credential: {} });
  ok('兜底 2 个', list.length === 2);
  ok('有告警', Boolean(ch.lastModelWarning));
});

await test('网络异常 → 兜底且告警脱敏', async () => {
  const ch = new MiniMaxChannel();
  ch.fetchModelsImpl = async () => { throw new Error('connect ECONNREFUSED Bearer sk-abcdef123456789'); };
  const list = await ch.listModels({ credential: {} });
  ok('兜底 2 个', list.length === 2);
  ok('Bearer 已脱敏', !/sk-abcdef/.test(ch.lastModelWarning || ''), String(ch.lastModelWarning));
  ok('保留原始错误线索', /ECONNREFUSED/.test(ch.lastModelWarning || ''));
});

await test('兜底目录字段完整', () => {
  const list = fallbackMiniMaxModels();
  ok('2 个', list.length === 2);
  ok('id 可直接用于请求', list[0].id === 'MiniMax-M3');
  ok('上下文 512000', list.every((m) => m.contextWindow === 512000));
  ok('推理标记', list.every((m) => m.reasoning === true));
  ok('都带 fallback', list.every((m) => m.fallback === true));
});

/* ───────── 4. 端到端：/api/models 的输出 ───────── */

function serviceFor(ch) {
  const store = {
    settings: { accounts: [{ provider: 'minimax', enabled: true }], disabledModels: {}, modelEffort: {} }
  };
  const registry = { list: () => [ch], get: (id) => (id === ch.id ? ch : undefined) };
  return createModelService({ registry, store });
}

await test('模型服务输出带 provider 前缀的条目', async () => {
  const svc = serviceFor(channelWith(RESP(FIXTURE)));
  const list = await svc.listAll();
  ok('2 个', list.length === 2, String(list.length));
  ok('id 带前缀', list.some((m) => m.id === 'minimax/MiniMax-M3'));
  ok('display_name 正确', list.some((m) => m.display_name === 'M3.1-Flash'));
  ok('context_window 透出', list.every((m) => m.context_window === 512000));
  ok('supports_reasoning 透出', list.every((m) => m.supports_reasoning === true));
  ok('supports_images 透出', list.every((m) => m.supports_images === true));
  ok('正常路径不带 fallback', list.every((m) => !m.fallback));
  ok('diagnostics 为 remote', svc.diagnostics()[0].source === 'remote', JSON.stringify(svc.diagnostics()));
});

await test('失败路径：diagnostics 标 fallback 且带原因', async () => {
  const ch = channelWith({ status: 503, json: {}, text: 'upstream down' });
  const svc = serviceFor(ch);
  const list = await svc.listAll();
  ok('仍返回 2 个兜底模型', list.length === 2);
  ok('列表带 fallback', list.every((m) => m.fallback === true));
  const d = svc.diagnostics()[0];
  ok('diagnostics 标 fallback', d.source === 'fallback', JSON.stringify(d));
  ok('diagnostics 带原因', /503/.test(d.warning || ''), String(d.warning));
});

await test('凭据过期也不影响公开目录（publicModels 跳过取凭据）', async () => {
  const ch = channelWith(RESP(FIXTURE));
  ch.credential = async () => { throw new Error('MiniMax 续期失败，需要重新登录'); };
  const svc = serviceFor(ch);
  const list = await svc.listAll();
  ok('仍返回 2 个模型', list.length === 2, String(list.length));
  ok('是远端目录不是兜底', list.every((m) => !m.fallback));
  ok('diagnostics 无告警', !svc.diagnostics()[0].warning, JSON.stringify(svc.diagnostics()));
});

if (results.length) {
  console.error(`\n✗ ${results.length} 项失败：\n${results.join('\n')}`);
  process.exit(1);
}
console.log(`\n✓ test/minimax-models.mjs 通过 ${passed} 项断言`);
