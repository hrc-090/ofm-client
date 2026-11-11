/**
 * 渠道注册表。模型 id 一律 `${provider}/${model}`（§4）。
 */
import { OfmError, Codes } from './errors.js';
import { TraeChannel } from './channels/trae/index.js';
import { QoderChannel } from './channels/qoder/index.js';
import { ClineChannel } from './channels/cline/index.js';
import { LobsterChannel } from './channels/lobsterai/index.js';
import { LoomyChannel } from './channels/loomy/index.js';
import { RaccoonChannel } from './channels/raccoon/index.js';
import { MiniMaxChannel } from './channels/minimax/index.js';
import { ZCodeChannel } from './channels/zcode/index.js';
import { KiloChannel } from './channels/kilo/index.js';
import { MockChannel } from './channels/mock.js';

export function createRegistry() {
  const channels = new Map();
  for (const ch of [
    new MockChannel(),
    new TraeChannel(),
    new QoderChannel({ id: 'qoder' }),
    new QoderChannel({ id: 'qodercn' }),
    new ClineChannel(),
    new LobsterChannel(),
    new LoomyChannel(),
    new RaccoonChannel(),
    new MiniMaxChannel(),
    new ZCodeChannel(),
    new KiloChannel()
  ]) {
    channels.set(ch.id, ch);
  }
  return {
    channels,
    get(id) {
      const ch = channels.get(id);
      if (!ch) {
        throw new OfmError(Codes.INVALID_REQUEST, `未知的渠道: ${id}（模型 id 应为 provider/model）`, {
          status: 400
        });
      }
      return ch;
    },
    list() {
      return [...channels.values()].map((c) => ({
        id: c.id,
        name: c.name,
        displayName: c.displayName,
        loginMode: c.loginMode,
        requiresAccount: c.requiresAccount !== false,
        supported: c.supported !== false,
        note: c.note
      }));
    }
  };
}

export function splitModelId(modelId) {
  if (typeof modelId !== 'string' || !modelId.includes('/')) {
    throw new OfmError(
      Codes.INVALID_REQUEST,
      `模型 id 必须形如 provider/model，收到 "${modelId}"`,
      { status: 400 }
    );
  }
  const idx = modelId.indexOf('/');
  return { provider: modelId.slice(0, idx), modelId: modelId.slice(idx + 1) };
}
