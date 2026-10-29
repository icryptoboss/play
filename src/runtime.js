// Provider runtime: runs Vega-compatible provider modules (CommonJS bundles that
// export getPosts / getMeta / getStream / ...) and gives them the same
// `providerContext` the Android app does (axios, cheerio, commonHeaders, kvStore,
// openWebView). All HTTP goes through the site's own proxy function.
import axios from "axios";
import * as cheerio from "cheerio";
import { Buffer } from "buffer";

export const commonHeaders = {
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
};

function b64ToBytes(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function bytesToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function buildAdapter(state) {
  return async function proxyAdapter(config) {
    const url = axios.getUri(config);
    const headers = {};
    const raw = config.headers && typeof config.headers.toJSON === "function" ? config.headers.toJSON() : config.headers || {};
    for (const [k, v] of Object.entries(raw)) {
      if (v == null || v === false) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    if (config.auth) headers.Authorization = "Basic " + btoa(`${config.auth.username || ""}:${config.auth.password || ""}`);

    let body, bodyEncoding;
    const d = config.data;
    if (d != null) {
      if (typeof d === "string") { body = d; bodyEncoding = "utf8"; }
      else if (d instanceof URLSearchParams) {
        body = d.toString(); bodyEncoding = "utf8";
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
      } else if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) {
        const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        body = bytesToB64(u8); bodyEncoding = "base64";
      } else {
        throw new axios.AxiosError("Unsupported request body type", axios.AxiosError.ERR_BAD_OPTION_VALUE, config);
      }
    }

    const ctrl = new AbortController();
    let timedOut = false, timer;
    const onAbort = () => ctrl.abort();
    if (config.signal) {
      if (config.signal.aborted) ctrl.abort();
      else config.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (config.timeout) timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, config.timeout);
    const cleanup = () => { clearTimeout(timer); if (config.signal) config.signal.removeEventListener("abort", onAbort); };

    let res;
    try {
      res = await state.fetch(state.cfg.proxyUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(state.cfg.proxyKey ? { "x-proxy-key": state.cfg.proxyKey } : {}) },
        body: JSON.stringify({
          url, method: (config.method || "get").toUpperCase(), headers, body, bodyEncoding,
          maxRedirects: config.maxRedirects == null ? 5 : config.maxRedirects,
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      cleanup();
      if (timedOut) throw new axios.AxiosError(`timeout of ${config.timeout}ms exceeded`, axios.AxiosError.ECONNABORTED, config);
      if (ctrl.signal.aborted) throw new axios.CanceledError("canceled", config);
      throw new axios.AxiosError("Proxy unreachable: " + (e && e.message), axios.AxiosError.ERR_NETWORK, config);
    }
    let env;
    try { env = await res.json(); } catch (e) {
      cleanup();
      throw new axios.AxiosError(`Proxy returned HTTP ${res.status}. Is the /api/proxy function deployed?`, axios.AxiosError.ERR_NETWORK, config);
    }
    cleanup();
    if (!res.ok || env.proxyError) throw new axios.AxiosError("Proxy: " + (env.proxyError || "HTTP " + res.status), axios.AxiosError.ERR_NETWORK, config);

    let data = env.body;
    const rt = config.responseType;
    if (rt === "arraybuffer" || rt === "blob" || rt === "stream") {
      data = env.encoding === "base64" ? b64ToBytes(env.body).buffer : new TextEncoder().encode(env.body).buffer;
    } else if (env.encoding === "base64") {
      data = new TextDecoder().decode(b64ToBytes(env.body));
    }
    const hdrs = { ...(env.headers || {}) };
    if (env.setCookie && env.setCookie.length) hdrs["set-cookie"] = env.setCookie;
    const response = {
      data, status: env.status, statusText: env.statusText || "", headers: hdrs, config,
      request: { responseURL: env.url, res: { responseUrl: env.url } },
    };
    const ok = !config.validateStatus || config.validateStatus(env.status);
    if (ok) return response;
    throw new axios.AxiosError(
      "Request failed with status code " + env.status,
      env.status >= 500 ? axios.AxiosError.ERR_BAD_RESPONSE : axios.AxiosError.ERR_BAD_REQUEST,
      config, response.request, response,
    );
  };
}

function resolveCatalog(v, a) {
  if (typeof v === "function") return Promise.resolve(v({ signal: a.signal, providerContext: a.providerContext }));
  return Promise.resolve(v || []);
}

export function createRuntime({ kv, fetchImpl }) {
  const state = { cfg: { proxyUrl: "/api/proxy", proxyKey: "" }, fetch: fetchImpl || ((...a) => globalThis.fetch(...a)) };
  axios.defaults.adapter = buildAdapter(state);
  const modules = new Map();
  const running = new Map();

  function makeContext(provider) {
    return {
      axios, cheerio, commonHeaders,
      // Challenge-solving web views only exist in the Android app.
      openWebView: async (url) => ({ success: false, data: "", cookies: "", cookieMap: {}, userAgent: commonHeaders["User-Agent"], url }),
      kvStore: {
        get: (k) => kv(provider, "get", k),
        set: (k, v) => kv(provider, "set", k, v),
        delete: (k) => kv(provider, "delete", k),
        keys: () => kv(provider, "keys"),
        clear: () => kv(provider, "clear"),
      },
    };
  }

  function evaluate(code, ctx) {
    const mod = { exports: {} };
    const req = (name) => {
      if (name === "axios") return ctx.axios;
      if (name === "cheerio") return ctx.cheerio;
      throw new Error(`Provider called require("${name}"), which is not available in the web runtime`);
    };
    const proc = { env: {}, platform: "browser", browser: true, version: "v18.0.0", versions: {}, cwd: () => "/", nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };
    new Function("module", "exports", "require", "process", "Buffer", "global", code)(mod, mod.exports, req, proc, Buffer, globalThis);
    return mod.exports;
  }

  async function call(msg) {
    const { id, provider, module: modName, fn, args, code, key, cfg } = msg;
    if (cfg) Object.assign(state.cfg, cfg);
    let exp = modules.get(key);
    if (!exp) {
      if (code == null) return { needCode: true };
      try { exp = evaluate(code, makeContext(provider)); } catch (e) { return { ok: false, error: { message: `Could not load ${provider}/${modName}: ${e && e.message}` } }; }
      modules.set(key, exp);
    }
    const ctrl = new AbortController();
    running.set(id, ctrl);
    try {
      const providerContext = makeContext(provider);
      const a = { ...(args || {}), signal: ctrl.signal, providerContext };
      let result;
      if (modName === "catalog") {
        result = { catalog: await resolveCatalog(exp.catalog, a), genres: await resolveCatalog(exp.genres, a) };
      } else {
        const f = exp[fn];
        if (typeof f !== "function") throw new Error(`${provider}/${modName} does not export ${fn}`);
        result = await f(a);
      }
      return { ok: true, result: JSON.parse(JSON.stringify(result === undefined ? null : result)) };
    } catch (e) {
      const status = e && e.response && e.response.status;
      return { ok: false, error: { message: (status ? `HTTP ${status}: ` : "") + ((e && e.message) || String(e)) } };
    } finally {
      running.delete(id);
    }
  }

  return { call, cancel: (id) => { const c = running.get(id); if (c) c.abort(); }, state };
}
