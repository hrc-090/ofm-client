/**
 * 延迟提交流式响应头（移植自上游 src/deferred-response.js）。
 *
 * 问题：SSE 一旦 `writeHead(200)` 发出去，后面任何失败都只能往流里塞错误帧，
 * 客户端看到的仍是 200。第三方 SDK 的重试逻辑、`x-should-retry`、
 * `retry-after` 全部失效 —— 一个鉴权失败会被当成「模型返回空」。
 *
 * 做法：把 `writeHead` / `write` 拦在 Proxy 里先记账，不真正发出去。
 *  - 首个正文帧到达时由调用方 `commit()`：发头 + 刷缓冲；
 *  - 等待超过 `heartbeatMs` 自动 commit，用 SSE 注释帧保活，
 *    避免长思考时客户端自己超时；
 *  - 缓冲超过 64KB 也 commit（大帧模型不该被内存兜住）。
 *
 * 失败且**未 commit** 时，`res.headersSent` 仍为 false，外层就能返回真实的
 * 4xx/5xx。已 commit 才退回「流内 error 帧」这条老路。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} heartbeatMs 未提交时的最长等待，<=0 表示不自动提交
 */
export function deferStreamResponse(res, heartbeatMs = 15000) {
  let pending = true;
  let head = null;
  let writes = [];
  let bytes = 0;
  let timer;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const commit = () => {
    if (!pending || res.destroyed) return;
    pending = false;
    clear();
    if (head) res.writeHead(...head);
    for (const row of writes) res.write(...row);
    writes = [];
    bytes = 0;
  };

  const response = new Proxy(res, {
    get(target, key) {
      if (key === 'writeHead') {
        return (...args) => {
          if (!pending) return target.writeHead(...args);
          head = args;
          // 错误状态码不进缓冲：它意味着这一轮不会有正文了。
          if (typeof args[0] === 'number' && args[0] >= 400) {
            writes = [];
            bytes = 0;
          }
          if (!timer && heartbeatMs > 0) {
            timer = setTimeout(commit, heartbeatMs);
            if (timer.unref) timer.unref();
          }
          return response;
        };
      }
      if (key === 'flushHeaders') {
        return () => {
          if (!pending) target.flushHeaders();
        };
      }
      if (key === 'write') {
        return (...args) => {
          if (!pending) return target.write(...args);
          const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
          writes.push(args);
          bytes += Buffer.byteLength(args[0] || '');
          if (callback) queueMicrotask(callback);
          if (bytes >= 64 * 1024) commit();
          return true;
        };
      }
      if (key === 'end') {
        return (...args) => {
          commit();
          return target.end(...args);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  res.once('finish', clear);
  res.once('close', clear);

  return {
    response,
    commit,
    /** 是否已经把响应头发出去了 */
    get committed() {
      return !pending;
    },
    dispose: clear
  };
}
