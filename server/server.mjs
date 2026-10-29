// Vega Web server: serves the static app from ./public and the provider proxy at /api/proxy.
// Zero runtime dependencies (Node 20+). Designed for Koyeb, works anywhere Node runs.
//
// Environment:
//   PORT                   listen port (Koyeb sets this; default 8000)
//   PROXY_ALLOWED_HOSTS    hostnames the proxy may contact (required for providers to work)
//   PROXY_ACCESS_KEY       optional shared secret; required if PROXY_ALLOWED_HOSTS="*"
//   PROXY_TIMEOUT_MS       upstream timeout, default 20000
//   RATE_LIMIT_PER_MIN     per-client requests to /api/proxy per minute, default 120 (0 = off)
//   STREAM_ALLOWED_HOSTS   video hosts the stream relay may contact ("*" needs PROXY_ACCESS_KEY). Relay is off if unset.
//   STREAM_RATE_LIMIT_PER_MIN  per-client relay requests per minute, default 3000 (0 = off)
//   STREAM_SECRET          optional token-signing secret (default derives from PROXY_ACCESS_KEY)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import proxy from "./proxy.mjs";
import { createStreamUrl, relayStream } from "./stream.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, "..", "public");
const MAX_BODY = 2 * 1024 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
  ".wasm": "application/wasm",
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|javascript)|image\/svg)/;

// Everything in public/ is small, so load it once at startup. Only paths found in this
// table can be served, which rules out path traversal by construction.
function loadStatic(dir) {
  const files = new Map();
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name), r = rel + "/" + e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        const type = TYPES[path.extname(e.name).toLowerCase()] || "application/octet-stream";
        files.set(r, {
          buf, type,
          gz: COMPRESSIBLE.test(type) && buf.length > 1024 ? zlib.gzipSync(buf, { level: 9 }) : null,
          etag: '"' + crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + '"',
        });
      }
    }
  })(dir, "");
  return files;
}

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "fullscreen=(self), picture-in-picture=(self)",
  "x-frame-options": "SAMEORIGIN",
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj, extra) => send(res, status, { "content-type": "application/json", "cache-control": "no-store", ...extra }, JSON.stringify(obj));

function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || "unknown"; // last hop = added by Koyeb's edge
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createApp(opts = {}) {
  const files = loadStatic(opts.publicDir || PUBLIC_DIR);
  const limitPerMin = opts.rateLimitPerMin ?? (process.env.RATE_LIMIT_PER_MIN === undefined ? 120 : Number(process.env.RATE_LIMIT_PER_MIN));
  const hits = new Map();
  const sweeper = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000);
  sweeper.unref();

  const streamLimit = opts.streamRateLimitPerMin ?? (process.env.STREAM_RATE_LIMIT_PER_MIN === undefined ? 3000 : Number(process.env.STREAM_RATE_LIMIT_PER_MIN));
  function limited(ip, bucket = "proxy") {
    const max = bucket === "stream" ? streamLimit : limitPerMin;
    if (!max) return false;
    const key = bucket + "|" + ip, now = Date.now(); let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + 60_000 }; hits.set(key, h); }
    return ++h.n > max;
  }

  async function handleStreamUrl(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "*"
      });
      return res.end();
    }
    if (limited(clientIp(req))) return sendJson(res, 429, { proxyError: "Too many requests. Slow down and try again in a minute." }, { "retry-after": "60" });
    let body;
    try { body = req.method === "POST" ? await readBody(req, 64 * 1024) : undefined; }
    catch (e) { return sendJson(res, e.status || 400, { proxyError: "Bad request" }); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const r = await createStreamUrl(new Request("http://localhost/api/stream-url", { method: req.method, headers, body }));
    send(res, r.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "*"
    }, Buffer.from(await r.arrayBuffer()));
  }

  async function handleStream(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "*",
        "access-control-max-age": "86400"
      });
      return res.end();
    }
    if (limited(clientIp(req), "stream")) return sendJson(res, 429, { proxyError: "Too many requests. Slow down and try again in a minute." }, { "retry-after": "60" });
    return relayStream(req, res);
  }

  async function handleProxy(req, res) {
    if (req.method !== "GET" && req.method !== "POST") return sendJson(res, 405, { proxyError: "Method not allowed" }, { allow: "GET, POST" });
    if (req.method === "POST" && limited(clientIp(req))) return sendJson(res, 429, { proxyError: "Too many requests. Slow down and try again in a minute." }, { "retry-after": "60" });
    let body;
    try { body = req.method === "POST" ? await readBody(req, MAX_BODY) : undefined; }
    catch (e) { return sendJson(res, e.status || 400, { proxyError: e.status === 413 ? "Request body too large" : "Bad request" }); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const r = await proxy(new Request("http://localhost/api/proxy", { method: req.method, headers, body }));
    const out = Buffer.from(await r.arrayBuffer());
    send(res, r.status, { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "no-store" }, out);
  }

  function handleStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { allow: "GET, HEAD" }, "");
    const key = pathname === "/" ? "/index.html" : pathname;
    let f = files.get(key);
    if (!f) {
      const baseDir = path.resolve(opts.publicDir || PUBLIC_DIR);
      const diskPath = path.resolve(baseDir, "." + pathname);
      if (diskPath.startsWith(baseDir + path.sep) && fs.existsSync(diskPath) && fs.statSync(diskPath).isFile()) {
        const buf = fs.readFileSync(diskPath);
        const type = TYPES[path.extname(diskPath).toLowerCase()] || "application/octet-stream";
        const h = {
          "content-type": type,
          "access-control-allow-origin": "*",
          "cross-origin-resource-policy": "cross-origin",
          "cache-control": "no-cache",
          "content-length": buf.length
        };
        return send(res, 200, h, req.method === "HEAD" ? "" : buf);
      }
      if (!path.extname(pathname) && (req.headers["sec-fetch-mode"] === "navigate" || (req.headers["accept"] && req.headers["accept"].includes("text/html")))) {
        f = files.get("/index.html");
      }
      if (!f) return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
    }
    const h = {
      "content-type": f.type,
      etag: f.etag,
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      vary: "Accept-Encoding"
    };
    if (req.headers["if-none-match"] === f.etag) return send(res, 304, h, "");
    let body = f.buf;
    if (f.gz && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) { body = f.gz; h["content-encoding"] = "gzip"; }
    h["content-length"] = body.length;
    send(res, 200, h, req.method === "HEAD" ? "" : body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, {}, "Bad request"); }
      if (pathname === "/healthz") return sendJson(res, 200, { ok: true, ...(process.env.STREAM_ACCELERATOR_URL ? { acceleratorUrl: process.env.STREAM_ACCELERATOR_URL } : {}) });
      if (pathname === "/api/proxy") return await handleProxy(req, res);
      if (pathname === "/api/stream-url") return await handleStreamUrl(req, res);
      if (pathname === "/api/stream" || pathname.startsWith("/source") || pathname.startsWith("/playlist.m3u8") || pathname.startsWith("/segment.ts") || pathname === "/subs") {
        return await handleStream(req, res);
      }
      return handleStatic(req, res, pathname);
    } catch (e) {
      console.error("request failed:", e && e.stack || e);
      if (!res.headersSent) sendJson(res, 500, { proxyError: "Internal error" });
      else res.destroy();
    }
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return server;
}

// Run directly: `node server/server.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.PROXY_ALLOWED_HOSTS ||= "*";
  process.env.STREAM_ALLOWED_HOSTS ||= "*";
  process.env.PROXY_ACCESS_KEY ||= "mysecret";
  process.env.STREAM_SECRET ||= "mysecretkey";

  const port = Number(process.env.PORT) || 8000;
  const server = createApp();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Vega Web listening on http://localhost:${port}`);
    console.log(`Stream Relay & Accelerator: Active (CORS enabled for mobile & desktop)`);
    console.log(`Scraper Proxy: Active (hosts: ${process.env.PROXY_ALLOWED_HOSTS})`);
  });
  const stop = () => { console.log("Shutting down…"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
