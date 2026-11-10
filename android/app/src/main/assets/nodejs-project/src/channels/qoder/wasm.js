/**
 * Qoder 内嵌 WASM 的 wasm-bindgen 桥（移植自上游 channel-pack，MIT）。
 *
 * 三个必须保留的坑（改动时务必保留）：
 *  1. 两个 getRandomValues import 的签名**方向相反**：
 *     `_d49329ff89a07af1` 写 wasm 内存，`_c44a50d8cfdaebeb` 调 JS 对象。
 *     写反 → Rust panic `unreachable`。
 *  2. 返回值布局两套：字符串类 `ptr/len/valIdx/isErr`，
 *     `qodercontext_new` / `prepareInferRequest` 是 `ptr/errIdx/isErr`。
 *     混用 → `null pointer passed to rust`。
 *  3. `requestresult_url(栈指针, ptr)` 参数顺序与直觉相反（栈指针在前）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(HERE, 'qoder-auth-wasm.wasm');
const IMPORT_MODULE = './qoder_auth_wasm_bg.js';

let gluePromise = null;

function getGlue() {
  if (!gluePromise) gluePromise = createGlue();
  return gluePromise;
}

function randomFill(view) {
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(view);
  const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  crypto.randomFillSync(buf);
  return view;
}

async function createGlue() {
  const bytes = fs.readFileSync(WASM_PATH);
  const module = await WebAssembly.compile(bytes);

  let exports = {};
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  const encoder = new TextEncoder();

  let cachedHeap = null;
  const heap = () => {
    const buf = exports.memory.buffer;
    if (!cachedHeap || cachedHeap.buffer !== buf) cachedHeap = new Uint8Array(buf);
    return cachedHeap;
  };
  let cachedView = null;
  const view = () => {
    const buf = exports.memory.buffer;
    if (!cachedView || cachedView.buffer !== buf) cachedView = new DataView(buf);
    return cachedView;
  };
  const readString = (ptr, len) => decoder.decode(heap().subarray(ptr >>> 0, (ptr >>> 0) + len));

  const objects = new Array(1024).fill(undefined);
  objects.push(undefined, null, true, false);
  let firstFree = objects.length;
  const heapObject = (i) => objects[i];
  const pushObject = (value) => {
    if (firstFree === objects.length) objects.push(objects.length + 1);
    const index = firstFree;
    firstFree = objects[index];
    objects[index] = value;
    return index;
  };
  const takeObject = (index) => {
    const value = heapObject(index);
    if (index >= 1028) {
      objects[index] = firstFree;
      firstFree = index;
    }
    return value;
  };

  let lastLength = 0;
  const writeString = (text) => {
    const encoded = encoder.encode(text);
    const ptr = exports.__wbindgen_export2(encoded.length, 1) >>> 0;
    heap().subarray(ptr, ptr + encoded.length).set(encoded);
    lastLength = encoded.length;
    return ptr;
  };

  /** 字符串返回值布局：ptr / len / valIdx / isErr */
  const callString = (invoke) => {
    let ptr = 0;
    let len = 0;
    const stack = exports.__wbindgen_add_to_stack_pointer(-16);
    try {
      invoke(stack);
      const v = view();
      ptr = v.getInt32(stack + 0, true);
      len = v.getInt32(stack + 4, true);
      const isError = v.getInt32(stack + 12, true);
      if (isError) throw takeObject(v.getInt32(stack + 8, true));
      return readString(ptr, len);
    } finally {
      exports.__wbindgen_add_to_stack_pointer(16);
      if (ptr) exports.__wbindgen_export4(ptr, len, 1);
    }
  };

  /** 指针返回值布局：ptr / errIdx / isErr */
  const callPointer = (invoke) => {
    const stack = exports.__wbindgen_add_to_stack_pointer(-16);
    try {
      invoke(stack);
      const v = view();
      const ptr = v.getInt32(stack + 0, true);
      const isError = v.getInt32(stack + 8, true);
      if (isError) throw takeObject(v.getInt32(stack + 4, true));
      return ptr;
    } finally {
      exports.__wbindgen_add_to_stack_pointer(16);
    }
  };

  const guard = (fn, args) => {
    try {
      fn(...args);
    } catch (error) {
      exports.__wbindgen_export(pushObject(error));
    }
  };

  const imports = {
    __wbindgen_object_drop_ref: (a) => takeObject(a),
    __wbindgen_object_clone_ref: (a) => pushObject(heapObject(a)),
    __wbindgen_cast_0000000000000001: (a, e) => pushObject(heap().subarray(a >>> 0, (a >>> 0) + e)),
    __wbindgen_cast_0000000000000002: (a, e) => pushObject(readString(a, e)),
    __wbg_set_08463b1df38a7e29: (a, e, t) =>
      pushObject(heapObject(a).set(heapObject(e), heapObject(t))),
    // ⚠️ 方向相反：一个写 wasm 内存，一个调 JS 对象
    __wbg_getRandomValues_d49329ff89a07af1: (...a) =>
      guard((x, y) => {
        randomFill(heap().subarray(x >>> 0, (x >>> 0) + y));
      }, a),
    __wbg_getRandomValues_c44a50d8cfdaebeb: (...a) =>
      guard((x, y) => {
        heapObject(x).getRandomValues(heapObject(y));
      }, a),
    __wbg_crypto_38df2bab126b63dc: (a) => pushObject(heapObject(a).crypto),
    __wbg_process_44c7a14e11e9f69e: (a) => pushObject(heapObject(a).process),
    __wbg_versions_276b2795b1c6a219: (a) => pushObject(heapObject(a).versions),
    __wbg_node_84ea875411254db1: (a) => pushObject(heapObject(a).node),
    __wbg_require_b4edbdcf3e2a1ef0: (...a) => guard(() => pushObject(module), a),
    __wbg_msCrypto_bd5a034af96bcba6: (a) => pushObject(heapObject(a).msCrypto),
    __wbg_randomFillSync_6c25eac9869eb53c: (...a) =>
      guard((x, y) => {
        heapObject(x).randomFillSync(takeObject(y));
      }, a),
    __wbg_call_d578befcc3145dee: (...a) =>
      guard((fn, self, arg) => {
        pushObject(heapObject(fn).call(heapObject(self), heapObject(arg)));
      }, a),
    __wbg_new_with_length_9cedd08484b73942: (a) => pushObject(new Uint8Array(a >>> 0)),
    __wbg_length_0c32cb8543c8e4c8: (a) => heapObject(a).length,
    __wbg_prototypesetcall_3e05eb9545565046: (a, e, t) => {
      Uint8Array.prototype.set.call(heap().subarray(a >>> 0, (a >>> 0) + e), heapObject(t));
    },
    __wbg_subarray_0f98d3fb634508ad: (a, e, t) => pushObject(heapObject(a).subarray(e >>> 0, t >>> 0)),
    __wbg_new_99cabae501c0a8a0: () => pushObject(new Map()),
    __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
    __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => pushObject(globalThis),
    __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => pushObject(globalThis),
    __wbg_static_accessor_SELF_24f78b6d23f286ea: () => (globalThis.self === undefined ? 0 : pushObject(globalThis.self)),
    __wbg_static_accessor_WINDOW_59fd959c540fe405: () =>
      globalThis.window === undefined ? 0 : pushObject(globalThis.window),
    __wbg___wbindgen_throw_81fc77679af83bc6: (p, l) => {
      throw new Error(readString(p, l));
    },
    __wbg_Error_2e59b1b37a9a34c3: (p, l) => pushObject(new Error(readString(p, l))),
    __wbg___wbindgen_is_object_40c5a80572e8f9d3: (id) => {
      const v = heapObject(id);
      return typeof v === 'object' && v !== null;
    },
    __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (id) => typeof heapObject(id) === 'string',
    __wbg___wbindgen_is_function_49868bde5eb1e745: (id) => typeof heapObject(id) === 'function',
    __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (id) => heapObject(id) === undefined
  };

  const instance = await WebAssembly.instantiate(module, { [IMPORT_MODULE]: imports });
  exports = instance.exports;

  return { exports, heap, view, readString, writeString, lastLength: () => lastLength, heapObject, pushObject, takeObject, callString, callPointer };
}

function needsUid(uid) {
  if (!uid) throw new Error('Qoder 凭据缺少 uid，无法生成加密签名（先调用 /api/v1/userinfo 补齐）');
  return uid;
}

export async function generateRuntimeAuthFields(user) {
  const g = await getGlue();
  const payload = JSON.stringify({
    uid: needsUid(user.uid),
    security_oauth_token: user.securityOauthToken,
    organization_id: user.organizationId ?? '',
    organization_tags: user.organizationTags ?? [],
    data_policy_agreed: user.dataPolicyAgreed ?? false
  });
  const raw = g.callString((stack) => {
    const a = g.writeString(payload);
    g.exports.generate_runtime_auth_fields(stack, a, g.lastLength());
  });
  return JSON.parse(raw);
}

export class QoderEncryptedInfer {
  constructor(g, context, host) {
    this.g = g;
    this.context = context;
    this.host = host;
  }

  static async create({ user, machineId, metadata, host, clientVersion }) {
    const g = await getGlue();
    const fields = await generateRuntimeAuthFields(user);
    const version = clientVersion || '1.1.49';
    const userInfoJson = JSON.stringify({
      uid: user.uid,
      encrypt_user_info: fields.encrypt_user_info,
      key: fields.key,
      organization_id: user.organizationId ?? '',
      organization_tags: user.organizationTags ?? [],
      data_policy_agreed: user.dataPolicyAgreed ?? false
    });

    const context = g.callPointer((stack) => {
      const machine = g.writeString(machineId);
      const machineLen = g.lastLength();
      const ver = g.writeString(version);
      const verLen = g.lastLength();
      const info = g.writeString(userInfoJson);
      const infoLen = g.lastLength();
      const meta = g.writeString(JSON.stringify(metadata));
      const metaLen = g.lastLength();
      g.exports.qodercontext_new(stack, machine, machineLen, ver, verLen, info, infoLen, meta, metaLen);
    });

    return new QoderEncryptedInfer(g, context, host);
  }

  /** @returns {{url:string, headers:Record<string,string>, body:string}} */
  prepareInfer({ modelKey, payload, source }) {
    const g = this.g;
    const result = g.callPointer((stack) => {
      const host = g.writeString(this.host);
      const hostLen = g.lastLength();
      const body = g.writeString(JSON.stringify(payload));
      const bodyLen = g.lastLength();
      const key = g.writeString(modelKey);
      const keyLen = g.lastLength();
      const src = g.writeString(source || 'system');
      const srcLen = g.lastLength();
      g.exports.qodercontext_prepareInferRequest(stack, this.context, host, hostLen, body, bodyLen, key, keyLen, src, srcLen);
    });

    const headerMap = g.takeObject(g.exports.requestresult_headers(result));
    const headers = {};
    if (headerMap instanceof Map) for (const [k, v] of headerMap) headers[String(k)] = String(v);

    const readResultString = (invoke) => {
      const v = g.view();
      const stack = g.exports.__wbindgen_add_to_stack_pointer(-16);
      try {
        invoke(stack, result);
        const ptr = v.getInt32(stack + 0, true);
        const len = v.getInt32(stack + 4, true);
        return ptr ? g.readString(ptr, len) : '';
      } finally {
        g.exports.__wbindgen_add_to_stack_pointer(16);
      }
    };

    return {
      // ⚠️ 参数顺序：(栈指针, ptr)
      url: readResultString((stack, ptr) => g.exports.requestresult_url(stack, ptr)),
      headers,
      body: readResultString((stack, ptr) => g.exports.requestresult_body(stack, ptr))
    };
  }
}
