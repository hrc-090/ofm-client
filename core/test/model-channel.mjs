/**
 * 模型目录带渠道显示名（provider_name）验收。
 *
 * 覆盖：
 *  - listAll() 给每个模型附上渠道显示名，缺失时按 name / provider id 逐级回退；
 *  - /api/models 与第三方 /v1/models 都能拿到该字段；
 *  - 渠道显示名不影响原有 id / provider / display_name / 禁用模型逻辑。
 *
 * 运行：node test/model-channel.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createModelService } from '../src/dispatch.js';
import { createApp } from '../src/server.js';
import { DEFAULT_API_KEY } from '../src/store.js';
import {
  MODEL_LABEL_SEP, MODEL_LABEL_PREFIX,
  decorateModelId, decorateDisplayName, resolveModelId
} from '../src/model-label.js';

const log = { log() {}, warn() {}, error() {} };
let passed = 0;
const results = [];
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name} ${detail}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};
async function test(name, fn) {
  try { await fn(); } catch (e) {
    results.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

/* 三个免账号渠道：displayName 齐全 / 只有 name / 两个都没有 */
const seen = [];
function fakeChannel({ id, name, displayName, models }) {
  return {
    id,
    ...(name ? { name } : {}),
    ...(displayName ? { displayName } : {}),
    supported: true,
    requiresAccount: false,
    loginMode: 'none',
    listModels: async () => models,
    async *stream(req) {
      seen.push({ provider: req.provider, modelId: req.modelId, model: req.model });
      yield { type: 'text', text: 'ok' };
      yield { type: 'finish', reason: 'stop' };
    }
  };
}
const chA = fakeChannel({
  id: 'alpha', name: 'AlphaRaw', displayName: 'Alpha 渠道（示例）',
  models: [
    {
      id: 'a-1', displayName: 'A One', reasoning: true,
      reasoningOptions: [
        { value: 'light', label: 'Light' },
        { value: 'high', label: 'High' },
        { value: 'extra_light', label: 'Extra Light' }
      ]
    },
    { id: 'a-2', fallback: true }
  ]
});
const chB = fakeChannel({ id: 'beta', name: 'BetaRaw', models: [{ id: 'b-1' }] });
const chC = fakeChannel({ id: 'gamma', models: [{ id: 'c-1' }] });
const all = [chA, chB, chC];
const registry = {
  list: () => all,
  get: (id) => all.find((c) => c.id === id)
};
const storeOf = (accounts = []) => ({
  settings: { accounts, disabledModels: {}, modelEffort: {} }
});

/* ───────── 1. modelService 输出 ───────── */

await test('listAll 给每个模型附上渠道显示名', async () => {
  const svc = createModelService({ registry, store: storeOf(), log });
  const list = await svc.listAll({ force: true });
  ok('三个渠道的模型都在', list.length === 4, JSON.stringify(list.map((m) => m.id)));
  const byId = Object.fromEntries(list.map((m) => [m.id, m]));
  ok('displayName 优先', byId['alpha/a-1'].provider_name === 'Alpha 渠道（示例）');
  ok('同一渠道两条都带', byId['alpha/a-2'].provider_name === 'Alpha 渠道（示例）');
  ok('无 displayName 回退 name', byId['beta/b-1'].provider_name === 'BetaRaw');
  ok('name/displayName 都缺回退 provider id', byId['gamma/c-1'].provider_name === 'gamma');
  ok('字段都是非空字符串', list.every((m) => typeof m.provider_name === 'string' && m.provider_name.length > 0));
});

await test('新增字段不破坏原有模型结构', async () => {
  const svc = createModelService({ registry, store: storeOf(), log });
  const list = await svc.listAll({ force: true });
  const a = list.find((m) => m.id === 'alpha/a-1');
  ok('id 仍是 provider/model', a.id === 'alpha/a-1');
  ok('provider 不变', a.provider === 'alpha');
  ok('owned_by 不变', a.owned_by === 'alpha');
  ok('model 不变', a.model === 'a-1');
  ok('display_name 不变', a.display_name === 'A One');
  ok('兜底标记不变', list.find((m) => m.id === 'alpha/a-2').fallback === true);
  ok('provider_name 不是把 id 拼进显示名', a.display_name === 'A One' && !a.display_name.includes('alpha'));
});

await test('未知渠道 / 账号不拖垮整份目录', async () => {
  const svc = createModelService({
    registry,
    store: storeOf([{ id: 'x1', provider: 'ghost', enabled: true }]),
    log
  });
  const list = await svc.listAll({ force: true });
  ok('其它渠道照常返回', list.length === 4);
  ok('没有 ghost 的残留条目', list.every((m) => !m.id.startsWith('ghost/')));
});

await test('禁用模型不影响渠道名', async () => {
  const store = storeOf();
  store.settings.disabledModels = { alpha: { 'a-1': true } };
  const svc = createModelService({ registry, store, log });
  const list = await svc.listAll({ force: true });
  ok('被禁模型不出现', !list.some((m) => m.id === 'alpha/a-1'));
  ok('剩下的还带渠道名', list.every((m) => m.provider_name === 'Alpha 渠道（示例）' || m.provider_name === 'BetaRaw' || m.provider_name === 'gamma'));
});

/* ───────── 2. 展示 id 装饰与反解 ───────── */

await test('展示 id 装饰 / 反解往返', () => {
  const real = 'trae/Doubao-Seed-Code';
  const shown = decorateModelId(real, 'TRAE');
  ok('前置渠道名', shown.startsWith('[TRAE]'), shown);
  ok('保留真实 id', shown.endsWith(MODEL_LABEL_SEP + real), shown);
  ok('反解回真实 id', resolveModelId(shown) === real);
  ok('显示名也前置渠道名', decorateDisplayName('Doubao-Seed-Code', 'TRAE') === '[TRAE] Doubao-Seed-Code');
});

await test('真实 id / 非字符串 / 多段分隔符都兼容', () => {
  ok('真实 id 原样返回', resolveModelId('trae/xxx') === 'trae/xxx');
  ok('null 原样返回', resolveModelId(null) === null);
  ok('undefined 原样返回', resolveModelId(undefined) === undefined);
  ok('取最后一段', resolveModelId(`[A]${MODEL_LABEL_SEP}[B]${MODEL_LABEL_SEP}trae/xxx`) === 'trae/xxx');
  ok('渠道名为空时不装饰', decorateModelId('trae/xxx', '') === 'trae/xxx');
});

await test('可选统一前缀（如 Tune）不影响反解', () => {
  const real = 'trae/xxx';
  const shown = decorateModelId(real, 'TRAE', 'Tune');
  ok('前缀在最前面', shown.startsWith('Tune [TRAE]'), shown);
  ok('反解仍得到真实 id', resolveModelId(shown) === real);
  ok('显示名同样带前缀', decorateDisplayName('xxx', 'TRAE', 'Tune') === 'Tune [TRAE] xxx');
  ok('默认不启用统一前缀', MODEL_LABEL_PREFIX === '');
});

await test('脏输入反解：编码 / 引号 / display_name 形态', () => {
  const real = 'trae/Doubao-Seed-Code';
  const shown = decorateModelId(real, 'TRAE');
  ok('URL 编码的展示 id', resolveModelId(encodeURIComponent(shown)) === real);
  ok('包裹引号', resolveModelId(`"${shown}"`) === real);
  ok('首尾空白', resolveModelId(`  ${shown}  `) === real);
  // 客户端把 display_name 当 model 回传
  ok('方括号显示名被剥掉', resolveModelId('[TRAE] Seed-Code') === 'Seed-Code');
  ok('中文方括号', resolveModelId('【TRAE】Seed-Code') === 'Seed-Code');
  ok('无括号的纯名原样', resolveModelId('Seed-Code') === 'Seed-Code');
});

/* ───────── 3. HTTP 层：App 接口与第三方接口 ───────── */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-model-channel-'));
const { server, uiToken } = createApp({ dataDir: dir, log, registry });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const uiGet = (p) => fetch(base + p, { headers: { 'x-ofm-ui-token': uiToken } });
  const v1Get = (p) => fetch(base + p, { headers: { authorization: `Bearer ${DEFAULT_API_KEY}` } });
  const v1Post = (p, body) => fetch(base + p, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEFAULT_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  await test('/api/models 下发渠道名，但 id 保持真实值（App 不受影响）', async () => {
    const r = await uiGet('/api/models');
    const j = await r.json();
    ok('HTTP 200', r.status === 200);
    ok('有模型', j.data.length === 4);
    ok('带 provider_name', j.data.every((m) => typeof m.provider_name === 'string' && m.provider_name.length > 0));
    ok('值与渠道显示名一致', j.data.find((m) => m.id === 'alpha/a-1')?.provider_name === 'Alpha 渠道（示例）');
    ok('id 没被装饰', j.data.every((m) => !m.id.includes(MODEL_LABEL_SEP)));
    ok('显示名没被装饰', j.data.find((m) => m.id === 'alpha/a-1')?.display_name === 'A One');
  });

  await test('/v1/models 默认：id 保持原始，渠道名只进 display_name', async () => {
    const r = await v1Get('/v1/models');
    const j = await r.json();
    ok('HTTP 200', r.status === 200);
    ok('object=list 未被破坏', j.object === 'list');
    // 第三方常把 display_name 与 id 分两行显示，两行都带渠道就是重复 + 脏
    ok('id 没被装饰', j.data.every((m) => !m.id.includes(MODEL_LABEL_SEP)));
    ok('id 就是路由键', j.data.every((m) => m.id === m.real_id));
    const a = j.data.find((m) => m.id === 'alpha/a-1');
    ok('能按 id 找到模型', Boolean(a));
    ok('display_name 带渠道名', a?.display_name === '[Alpha 渠道（示例）] A One');
    ok('带 provider_name', j.data.every((m) => m.provider_name));
  });

  await test('任何参数都不会让 id 变形（旧的 ?id_label=1 通道已移除）', async () => {
    for (const p of ['/v1/models?id_label=1', '/v1/models?id_label=1&channel=1']) {
      const j = await (await v1Get(p)).json();
      ok(`id 仍是真实值: ${p}`, j.data.every((m) => m.id === m.real_id));
      ok(`id 不含分隔符: ${p}`, j.data.every((m) => !m.id.includes(MODEL_LABEL_SEP)));
      ok(`id 不含展示前缀: ${p}`, j.data.every((m) => !m.id.includes('[')));
    }
  });

  await test('下发内容里不出现厂商后缀与旧分隔符', async () => {
    const j = await (await v1Get('/v1/models')).json();
    const text = JSON.stringify(j);
    ok('没有「（字节）」', !text.includes('（字节）'));
    ok('没有「（讯飞）」', !text.includes('（讯飞）'));
    ok('没有 " :: " 分隔符', !text.includes(MODEL_LABEL_SEP));
  });

  await test('/v1/models?channel=0：两行都不带渠道', async () => {
    const j = await (await v1Get('/v1/models?channel=0')).json();
    ok('display_name 是纯模型名', j.data.find((m) => m.id === 'alpha/a-1')?.display_name === 'A One');
    ok('id 仍是原始值', j.data.every((m) => m.id === m.real_id && !m.id.includes(MODEL_LABEL_SEP)));
  });

  await test('/v1/models 与 /api/models 的真实 id 集合一致', async () => {
    const a = await (await uiGet('/api/models')).json();
    const b = await (await v1Get('/v1/models')).json();
    ok('数量一致', a.data.length === b.data.length);
    ok('集合一致', a.data.map((m) => m.id).sort().join() === b.data.map((m) => m.real_id).sort().join());
  });

  await test('真实思考档位出现在 App 与第三方接口', async () => {
    const a = await (await uiGet('/api/models')).json();
    const b = await (await v1Get('/v1/models')).json();
    const m = a.data.find((x) => x.id === 'alpha/a-1');
    const n = b.data.find((x) => x.real_id === 'alpha/a-1');
    ok('/api/models 带三档', m?.reasoning_options?.length === 3);
    ok('value 未做映射', m.reasoning_options.map((o) => o.value).join(',') === 'light,high,extra_light');
    ok('label 是上游原文', m.reasoning_options[2].label === 'Extra Light');
    ok('supports_reasoning 为真', m.supports_reasoning === true);
    ok('/v1/models 同样带三档', n?.reasoning_options?.length === 3);
    ok('第三方看到的 label 一致', n.reasoning_options[2].label === 'Extra Light');
  });

  await test('刷新参数下字段仍稳定', async () => {
    const j = await (await uiGet('/api/models?refresh=1')).json();
    ok('仍带渠道名', j.data.every((m) => m.provider_name));
    ok('回退值仍是 gamma', j.data.find((m) => m.id === 'gamma/c-1')?.provider_name === 'gamma');
  });

  // 模拟「装了旧版、把装饰 id 缓存下来继续发回来」的客户端：
  // 新版不再下发这种串，但入口必须认得，否则老用户升级后全部 400。
  const displayIdOf = async () => {
    const j = await (await v1Get('/v1/models')).json();
    const a = j.data.find((m) => m.real_id === 'alpha/a-1');
    return decorateModelId(a.real_id, a.provider_name);
  };

  await test('第三方用展示 id 发请求能正确路由（OpenAI）', async () => {
    const shown = await displayIdOf();
    seen.length = 0;
    const r = await v1Post('/v1/chat/completions', {
      model: shown, messages: [{ role: 'user', content: 'hi' }]
    });
    const j = await r.json();
    ok('HTTP 200', r.status === 200, JSON.stringify(j));
    ok('有正文', j.choices?.[0]?.message?.content === 'ok', JSON.stringify(j));
    ok('响应 model 回显归一化后的 id', j.model === 'alpha/a-1', j.model);
    ok('路由到 alpha', seen.at(-1)?.provider === 'alpha');
    ok('modelId 是 a-1', seen.at(-1)?.modelId === 'a-1');
    ok('渠道拿到的 model 已反解', seen.at(-1)?.model === 'alpha/a-1');
  });

  await test('旧客户端继续用真实 id 也正常', async () => {
    seen.length = 0;
    const r = await v1Post('/v1/chat/completions', {
      model: 'alpha/a-1', messages: [{ role: 'user', content: 'hi' }]
    });
    const j = await r.json();
    ok('HTTP 200', r.status === 200, JSON.stringify(j));
    ok('有正文', j.choices?.[0]?.message?.content === 'ok');
    ok('路由到 alpha', seen.at(-1)?.provider === 'alpha');
  });

  await test('客户端把 display_name 当 model 回传也能路由', async () => {
    // 实测：有的客户端在历史记录/标题里用显示名当 model，回传后 splitModelId 直接 400，
    // 表现就是「聊到一半断掉」。唯一命中时按目录还原成真实 id。
    const shown = (await (await v1Get('/v1/models')).json())
      .data.find((m) => m.real_id === 'alpha/a-1').display_name;
    ok('拿到 display_name', typeof shown === 'string' && shown.length > 0, shown);
    seen.length = 0;
    const r = await v1Post('/v1/chat/completions', {
      model: shown, messages: [{ role: 'user', content: 'hi' }]
    });
    const j = await r.json();
    ok('HTTP 200', r.status === 200, JSON.stringify(j));
    ok('有正文', j.choices?.[0]?.message?.content === 'ok');
    ok('路由到 alpha', seen.at(-1)?.provider === 'alpha');
    ok('modelId 是 a-1', seen.at(-1)?.modelId === 'a-1');
  });

  await test('URL 编码过的展示 id 也能路由', async () => {
    const raw = await displayIdOf();
    const encoded = encodeURIComponent(raw);
    seen.length = 0;
    const r = await v1Post('/v1/chat/completions', {
      model: encoded, messages: [{ role: 'user', content: 'hi' }]
    });
    const j = await r.json();
    ok('HTTP 200', r.status === 200, JSON.stringify(j));
    ok('路由到 alpha', seen.at(-1)?.provider === 'alpha');
  });

  await test('目录里查不到时不猜渠道，给清晰 400', async () => {
    seen.length = 0;
    const r = await v1Post('/v1/chat/completions', {
      model: '不存在的模型', messages: [{ role: 'user', content: 'hi' }]
    });
    const j = await r.json();
    ok('不是 200', r.status !== 200, JSON.stringify(j));
    ok('提示需要 provider/model', JSON.stringify(j).includes('provider/model'));
    ok('没有乱路由', seen.length === 0);
  });

  await test('Anthropic / Responses 入口同样支持展示 id', async () => {
    const shown = await displayIdOf();
    seen.length = 0;
    const a = await v1Post('/v1/messages', {
      model: shown, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }]
    });
    const aText = await a.text();
    ok('Anthropic 200', a.status === 200, aText.slice(0, 200));
    ok('Anthropic 路由到 alpha', seen.at(-1)?.provider === 'alpha');

    seen.length = 0;
    const b = await v1Post('/v1/responses', { model: shown, input: 'hi' });
    const bText = await b.text();
    ok('Responses 200', b.status === 200, bText.slice(0, 200));
    ok('Responses 路由到 alpha', seen.at(-1)?.provider === 'alpha');
  });
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (results.length) {
  console.error(`✗ 失败 ${results.length} 项`);
  for (const r of results) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ test/model-channel.mjs 通过 ${passed} 项断言`);
