/**
 * OpenAI wire 上的工具调用整形（对齐上游 src/forward.js 的 createToolWire）。
 *
 * 三件事，都是「转发后工具用不了」的直接原因：
 *
 *  1. **index 从 0 连续**。上游块序号和思考/正文块共用，一轮思考后的第一个
 *     工具调用常常是 index 2 起。按 index 累加的客户端会得到带空洞的稀疏
 *     数组，参数被合并或丢弃。
 *  2. **decoy 抑制**。免费车道会让模型声明 `read` / `shell` 这类指纹占位工具，
 *     模型真去调用时，客户端根本没有这个工具可执行。只允许「调用方自己声明过
 *     的同名工具」通过。
 *  3. **name 未到先挂起参数**。少数上游先吐参数片段再吐 name；乐观转发会把
 *     占位工具的参数片段泄漏给客户端。
 *
 * 另外：既没有 name/id、也没有参数字节的空帧不下发 —— 那是一个只有 index 的
 * `tool_calls` 帧，严格的客户端会当场判非法。
 */

/** 免费车道的指纹占位工具名。只在调用方没声明同名工具时抑制。 */
export const FINGERPRINT_TOOLS = ['read', 'shell'];

/**
 * @param {Array<{name:string}>} tools 调用方声明的工具（内部规范形状）
 */
export function createToolWire(tools) {
  const declared = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((t) => (typeof t?.name === 'string' ? t.name : ''))
      .filter(Boolean)
  );

  const slots = new Map(); // 上游块序号 -> 下发给客户端的连续 index
  const state = new Map(); // 上游块序号 -> true(保留) / false(抑制)
  const held = new Map(); // 上游块序号 -> { id, args: [] }
  let nextIndex = 0;

  const indexOf = (blockIndex) => {
    if (!slots.has(blockIndex)) slots.set(blockIndex, nextIndex++);
    return slots.get(blockIndex);
  };

  const executable = (name) => !(FINGERPRINT_TOOLS.includes(name) && !declared.has(name));

  return {
    get count() {
      return nextIndex;
    },

    /** 这个名字调用方能不能真的执行 */
    executable,

    /**
     * @param {{index?:number,id?:string,name?:string,argumentsDelta?:string}} delta
     * @returns {{kind:'drop'} | {kind:'open', index:number, id?:string, name?:string, args:string}
     *          | {kind:'args', index:number, args:string}}
     */
    admit(delta) {
      const block = Number.isInteger(delta?.index) ? delta.index : 0;
      const verdict = state.get(block);
      const name = typeof delta?.name === 'string' && delta.name !== '' ? delta.name : undefined;
      const args = typeof delta?.argumentsDelta === 'string' ? delta.argumentsDelta : '';

      // 已经判过：抑制的永远丢，保留的只发参数增量
      if (verdict === false) return { kind: 'drop' };
      if (verdict === true) {
        return args ? { kind: 'args', index: indexOf(block), args } : { kind: 'drop' };
      }

      // 第一次知道名字：立刻定生死
      if (name !== undefined) {
        const keep = executable(name);
        state.set(block, keep);
        if (!keep) return { kind: 'drop' };
        const parked = held.get(block);
        held.delete(block);
        const merged = (parked ? parked.args.join('') : '') + args;
        return {
          kind: 'open',
          index: indexOf(block),
          id: delta.id || parked?.id,
          name,
          args: merged
        };
      }

      // name 还没到：先挂起，别把可能属于 decoy 的参数片段发出去
      const parked = held.get(block) || { args: [] };
      if (delta?.id) parked.id = delta.id;
      if (args) parked.args.push(args);
      held.set(block, parked);
      return { kind: 'drop' };
    }
  };
}
