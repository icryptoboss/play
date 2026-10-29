// Web Worker entry. Providers run here, isolated from the page: no DOM and no
// access to the app's localStorage. Persistent provider storage (kvStore) is
// proxied to the page over postMessage.
import { createRuntime } from "./runtime.js";

const pending = new Map();
let rid = 0;

const runtime = createRuntime({
  kv: (provider, op, key, value) =>
    new Promise((resolve, reject) => {
      const r = ++rid;
      pending.set(r, { resolve, reject });
      self.postMessage({ type: "kv", r, provider, op, key, value });
    }),
});

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "kvResult") {
    const p = pending.get(m.r);
    if (p) { pending.delete(m.r); p.resolve(m.result); }
  } else if (m.type === "cancel") {
    runtime.cancel(m.id);
  } else if (m.type === "call") {
    const out = await runtime.call(m);
    self.postMessage({ type: "result", id: m.id, ...out });
  }
};
