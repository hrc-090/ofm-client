/**
 * 配置与凭据仓库。
 *
 * Android 上 dataDir = context.getFilesDir()（App 私有目录），
 * 凭据单独成文件、权限 0600 —— 不要塞进 settings.json，避免一次日志打印全泄。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeWebSearch } from './search/config.js';

const SETTINGS_VERSION = 1;

/**
 * 固定的默认 API Key。
 * 以前每次首次启动都随机生成，清空应用数据 / 重装后 Key 就变了，
 * 第三方客户端（ChatBox / DSH / OpenAI SDK）里配的旧 Key 立刻 401，
 * 表现为「无法获取模型列表」。现在默认恒定，配置一次永久有效。
 * 可用环境变量 OFM_API_KEY 覆盖；App 里也可手动设成自己的固定值。
 */
export const DEFAULT_API_KEY = 'ofm-local-key';

/** 只给「换 Key」按钮用：用户主动轮换时才生成随机值 */
export function generateApiKey() {
  return `ofm-${crypto.randomBytes(24).toString('base64url')}`;
}

export function defaultApiKey() {
  const v = typeof process !== 'undefined' ? String(process.env.OFM_API_KEY || '').trim() : '';
  return v || DEFAULT_API_KEY;
}

/**
 * 常量时间比较：先 sha256 拉齐长度，再 timingSafeEqual。
 * 直接比字符串会泄漏长度与前缀信息。
 */
export function keyMatches(expected, provided) {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(String(expected)).digest();
  const b = crypto.createHash('sha256').update(String(provided)).digest();
  return crypto.timingSafeEqual(a, b);
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.credDir = path.join(dataDir, 'credentials');
    this.settingsPath = path.join(dataDir, 'settings.json');
    fs.mkdirSync(this.credDir, { recursive: true });
    this.settings = this.#load();
  }

  #load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
    } catch {
      raw = null;
    }
    const settings = {
      version: SETTINGS_VERSION,
      enabled: true,
      forward: {
        host: '127.0.0.1',
        port: 18900,
        key: defaultApiKey()
      },
      accounts: [],
      disabledModels: {},
      // 按模型保存的默认思考档位：{ "trae/X": "high" }。
      // 只在客户端没有显式传 reasoning_effort 时生效。
      modelEffort: {},
      defaultMaxTokens: 32768,
      // 省 Token：RTK 压缩工具输出默认开；提示词瘦身默认关。
      tokenSaver: { rtk: true, caveman: 'off', ponytail: 'off' },
      // 无档位模型的预算阶梯（Light/Balanced/Deep → max_tokens），默认关
      effortBudget: false,
      // 网页搜索与读取（截图里的「自定义搜索 / 自定义读取」+ 内置引擎）
      webSearch: normalizeWebSearch(null),
      ...(raw || {})
    };
    // 老配置缺字段时补齐
    settings.forward = { host: '127.0.0.1', port: 18900, ...(settings.forward || {}) };
    if (!settings.forward.key) settings.forward.key = defaultApiKey();
    if (!Array.isArray(settings.accounts)) settings.accounts = [];
    if (!settings.disabledModels || typeof settings.disabledModels !== 'object') settings.disabledModels = {};
    if (!settings.modelEffort || typeof settings.modelEffort !== 'object' || Array.isArray(settings.modelEffort)) {
      settings.modelEffort = {};
    }
    // 搜索配置白名单归一化：脏值/多余字段一律不进内存，避免后面读出奇怪结构
    settings.webSearch = normalizeWebSearch(settings.webSearch);
    // 省 Token 配置：只保留已知键，防止第三方写进任意结构
    const ts = settings.tokenSaver && typeof settings.tokenSaver === 'object' ? settings.tokenSaver : {};
    settings.tokenSaver = {
      rtk: ts.rtk !== false,
      caveman: typeof ts.caveman === 'string' ? ts.caveman : 'off',
      ponytail: typeof ts.ponytail === 'string' ? ts.ponytail : 'off'
    };
    settings.effortBudget = settings.effortBudget === true;
    if (raw === null) this.save(settings);
    return settings;
  }

  save(next = this.settings) {
    this.settings = next;
    const tmp = `${this.settingsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.settingsPath);
    return next;
  }

  update(mutator) {
    const draft = JSON.parse(JSON.stringify(this.settings));
    const result = mutator(draft) ?? draft;
    return this.save(result);
  }

  /** 手动设成用户自己想要的固定 Key，落盘后不再自动变化 */
  setApiKey(key) {
    const k = String(key ?? '').trim();
    if (!/^[A-Za-z0-9._~-]{6,128}$/.test(k)) {
      throw new Error('Key 只能是 6-128 位字母、数字或 . _ - ~');
    }
    this.update((s) => { s.forward.key = k; });
    return k;
  }

  get accounts() {
    return this.settings.accounts;
  }

  findAccount(id) {
    return this.settings.accounts.find((a) => a.id === id);
  }

  upsertAccount(account) {
    this.update((s) => {
      const idx = s.accounts.findIndex((a) => a.id === account.id);
      if (idx >= 0) s.accounts[idx] = { ...s.accounts[idx], ...account };
      else s.accounts.push(account);
    });
    return this.findAccount(account.id);
  }

  removeAccount(id) {
    const account = this.findAccount(id);
    this.update((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== id);
    });
    if (account?.credentialRef) this.deleteCredential(account.credentialRef);
    return account;
  }

  credentialPath(ref) {
    // 防目录穿越：ref 只允许 [A-Za-z0-9._-]
    const safe = String(ref).replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.credDir, `${safe}.json`);
  }

  readCredential(ref) {
    try {
      return JSON.parse(fs.readFileSync(this.credentialPath(ref), 'utf8'));
    } catch {
      return null;
    }
  }

  writeCredential(ref, data) {
    const file = this.credentialPath(ref);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows 上 chmod 无效，忽略 */
    }
    return data;
  }

  deleteCredential(ref) {
    try {
      fs.unlinkSync(this.credentialPath(ref));
    } catch {
      /* 不存在就算了 */
    }
  }
}
