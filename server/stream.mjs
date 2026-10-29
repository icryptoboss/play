// Stream relay: lets the browser play streams that block cross-origin requests or need
// request headers (Referer, Origin, Cookie…) that a <video> element can't send.
//
//   POST /api/stream-url  {url, headers?}  (needs x-proxy-key if PROXY_ACCESS_KEY is set)
//        → {url: "/api/stream?t=<signed token>"}
//   GET  /api/stream?t=…  fetches the upstream URL with the signed headers, forwards Range,
//        rewrites HLS playlists so every segment/key also goes through the relay.
//
// Safety: relay is OFF until STREAM_ALLOWED_HOSTS is set ("*" requires PROXY_ACCESS_KEY).
// Tokens are HMAC-signed and expire, so only a caller who passed the key check can mint
// them. Private addresses are refused on every redirect hop. Only a fixed set of request
// headers can be attached.
import crypto from "node:crypto";
import { Readable, pipeline } from "node:stream";
import { parseAllowList, hostAllowed, checkTarget, ProxyError, safeEqual } from "./proxy.mjs";

const FORWARDABLE = new Set(["referer", "origin", "user-agent", "cookie", "authorization", "accept", "accept-language", "x-requested-with"]);
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PLAYLIST = 5 * 1024 * 1024;
const HEADER_TIMEOUT_MS = 25_000;

function secret() {
  if (process.env.STREAM_SECRET) return process.env.STREAM_SECRET;
  if (process.env.PROXY_ACCESS_KEY) return "vega-stream:" + process.env.PROXY_ACCESS_KEY;
  return (secret.rand ||= crypto.randomBytes(32).toString("hex"));
}
const b64u = (x) => Buffer.from(x).toString("base64url");

export function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  return body + "." + crypto.createHmac("sha256", secret()).update(body).digest("base64url");
}
export function verifyToken(token) {
  const i = String(token || "").lastIndexOf(".");
  if (i < 1) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const want = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (!safeEqual(sig, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return p && typeof p.u === "string" && p.e > Date.now() ? p : null;
  } catch { return null; }
}

function config() {
  const allow = parseAllowList(process.env.STREAM_ALLOWED_HOSTS);
  const key = process.env.PROXY_ACCESS_KEY || "";
  if (!allow.length) return { error: "The stream relay is off. Set STREAM_ALLOWED_HOSTS on the server (a list of video hosts, or * together with PROXY_ACCESS_KEY)." };
  if (allow.includes("*") && !key) return { error: 'STREAM_ALLOWED_HOSTS="*" requires PROXY_ACCESS_KEY to be set.' };
  return { allow, key, allowPrivate: process.env.PROXY_ALLOW_PRIVATE === "1" };
}

function cleanHeaders(h) {
  if (typeof h === "string") {
    try { h = JSON.parse(h); } catch {}
  }
  const out = {};
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h)) {
      const lk = String(k).toLowerCase();
      if (FORWARDABLE.has(lk) && typeof v === "string" && v.length <= 4096 && !/[\r\n]/.test(v)) out[lk] = v;
    }
  }
  return out;
}

const mint = (url, headers) => "/api/stream?t=" + signToken({ u: url, h: headers, e: Date.now() + TOKEN_TTL_MS });

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "*"
    }
  });

function isSameOriginRequest(req) {
  const secSite = req.headers.get("sec-fetch-site");
  if (secSite === "same-origin") return true;
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (origin && host && (origin === `http://${host}` || origin === `https://${host}`)) return true;
  if (referer && host && (referer.startsWith(`http://${host}/`) || referer.startsWith(`https://${host}/`))) return true;
  return false;
}

// fetch-style handler: POST /api/stream-url
export async function createStreamUrl(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "*"
      }
    });
  }
  if (req.method !== "POST") return json(405, { proxyError: "Method not allowed" });
  const cfg = config();
  if (cfg.error) return json(403, { proxyError: cfg.error });
  const sameOrigin = isSameOriginRequest(req);
  if (cfg.key && !sameOrigin && !safeEqual(req.headers.get("x-proxy-key") || "", cfg.key)) return json(401, { proxyError: "Missing or wrong access key. Enter it in Settings → Proxy." });
  let p; try { p = await req.json(); } catch { return json(400, { proxyError: "Invalid JSON body" }); }
  let u; try { u = new URL(p.url); } catch { return json(400, { proxyError: "Invalid url" }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return json(400, { proxyError: "Only http and https URLs are allowed" });
  if (!hostAllowed(u.hostname.replace(/^\[|\]$/g, ""), cfg.allow)) {
    return json(403, { proxyError: `Host "${u.hostname}" is not in STREAM_ALLOWED_HOSTS. Add it to the STREAM_ALLOWED_HOSTS environment variable and redeploy.` });
  }
  return json(200, { url: mint(u.href, cleanHeaders(p.headers)) });
}

export function rewritePlaylist(text, base, headers) {
  const mk = (abs) => {
    let u; try { u = new URL(abs); } catch { return null; }
    return u.protocol === "http:" || u.protocol === "https:" ? mint(u.href, headers) : null;
  };
  return text.replace(/^﻿/, "").replace(/\r/g, "").split("\n").map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) {
      return line.replace(/URI="([^"]*)"/g, (m, u) => {
        if (!u || /^data:/i.test(u)) return m;
        let abs; try { abs = new URL(u, base).href; } catch { return m; }
        const r = mk(abs); return r ? `URI="${r}"` : m;
      });
    }
    let abs; try { abs = new URL(t, base).href; } catch { return line; }
    return mk(abs) || line;
  }).join("\n");
}

export function rewriteDirectPlaylist(text, base, headers, origin = "") {
  const hStr = typeof headers === "object" ? JSON.stringify(headers) : (headers || "{}");
  const mk = (abs, isSub) => {
    let u; try { u = new URL(abs); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const ep = isSub ? "/playlist.m3u8" : "/segment.ts";
    return `${origin}${ep}?url=${encodeURIComponent(u.href)}&headers=${encodeURIComponent(hStr)}`;
  };
  return text.replace(/^﻿/, "").replace(/\r/g, "").split("\n").map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) {
      return line.replace(/URI="([^"]*)"/g, (m, u) => {
        if (!u || /^data:/i.test(u)) return m;
        let abs; try { abs = new URL(u, base).href; } catch { return m; }
        const r = mk(abs, false);
        return r ? `URI="${r}"` : m;
      });
    }
    let abs; try { abs = new URL(t, base).href; } catch { return line; }
    const isSub = /\.m3u8(?:[?#]|$)/i.test(abs);
    return mk(abs, isSub) || line;
  }).join("\n");
}

function fail(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "*"
  });
  res.end(JSON.stringify({ proxyError: message }));
}

async function readText(r) {
  const reader = r.body.getReader(); const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    n += value.length;
    if (n > MAX_PLAYLIST) { try { await reader.cancel(); } catch {} throw new ProxyError(413, "Playlist is larger than 5 MB"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// node-style handler: GET /api/stream?t=…
export async function relayStream(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "*",
      "access-control-max-age": "86400"
    });
    return res.end();
  }
  const cfg = config();
  if (cfg.error) return fail(res, 403, cfg.error);
  if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Method not allowed");

  const parsedUrl = new URL(req.url, "http://x");
  let targetUrl, targetHeaders, isDirect = false;
  const tokenParam = parsedUrl.searchParams.get("t");
  const directUrlParam = parsedUrl.searchParams.get("url") || parsedUrl.searchParams.get("u");

  if (tokenParam) {
    let token = verifyToken(tokenParam);
    if (!token) return fail(res, 403, "This stream link is invalid or has expired. Press play again.");
    targetUrl = token.u;
    targetHeaders = token.h;
  } else if (directUrlParam) {
    targetUrl = directUrlParam;
    targetHeaders = parsedUrl.searchParams.get("headers") || parsedUrl.searchParams.get("h");
    isDirect = true;
  } else {
    return fail(res, 403, "This stream link is invalid or has expired. Press play again.");
  }

  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());
  const timer = setTimeout(() => ctrl.abort(), HEADER_TIMEOUT_MS);
  try {
    let headers = {
      "user-agent": DEFAULT_UA,
      accept: "*/*",
      "accept-encoding": "identity",
      ...cleanHeaders(targetHeaders)
    };
    if (!headers.referer) {
      try { headers.referer = new URL(targetUrl).origin + "/"; } catch {}
    }
    for (const k of ["range", "if-range"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
    let current = new URL(targetUrl), hops = 0, r;
    for (;;) {
      await checkTarget(current, cfg.allow, cfg.allowPrivate, "STREAM_ALLOWED_HOSTS");
      r = await fetch(current, { method: "GET", headers, redirect: "manual", signal: ctrl.signal });
      const loc = r.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(r.status) && loc && hops < 5) {
        hops++;
        const next = new URL(loc, current);
        if (next.host !== current.host) { headers = { ...headers }; delete headers.cookie; delete headers.authorization; }
        current = next;
        try { await r.body?.cancel(); } catch {}
        continue;
      }
      break;
    }
    clearTimeout(timer);

    const ct = r.headers.get("content-type") || "";
    const isPlaylist = r.ok && (/mpegurl/i.test(ct) || /\.m3u8$/i.test(current.pathname) || parsedUrl.pathname.includes("playlist.m3u8"));
    if (isPlaylist) {
      const text = await readText(r);
      if (/^﻿?\s*#EXTM3U/.test(text)) {
        const body = isDirect
          ? Buffer.from(rewriteDirectPlaylist(text, current.href, targetHeaders, ""))
          : Buffer.from(rewritePlaylist(text, current.href, cleanHeaders(targetHeaders)));
        res.writeHead(200, {
          "content-type": "application/vnd.apple.mpegurl",
          "cache-control": "no-store",
          "content-length": body.length,
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
          "cross-origin-resource-policy": "cross-origin"
        });
        return res.end(req.method === "HEAD" ? undefined : body);
      }
      const raw = Buffer.from(text);
      res.writeHead(200, {
        "content-type": ct || "text/plain",
        "cache-control": "no-store",
        "content-length": raw.length,
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "*",
        "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
        "cross-origin-resource-policy": "cross-origin"
      });
      return res.end(req.method === "HEAD" ? undefined : raw);
    }

    let finalCt = ct;
    const lowerPath = (current.pathname + " " + parsedUrl.pathname + " " + targetUrl).toLowerCase();
    if (!finalCt || finalCt === "application/octet-stream" || finalCt === "binary/octet-stream" || finalCt.startsWith("text/")) {
      if (lowerPath.includes(".mkv")) finalCt = "video/x-matroska";
      else if (lowerPath.includes(".mp4") || lowerPath.includes(".m4v")) finalCt = "video/mp4";
      else if (lowerPath.includes(".webm")) finalCt = "video/webm";
      else if (lowerPath.includes(".ts")) finalCt = "video/mp2t";
      else if (lowerPath.includes(".m3u8")) finalCt = "application/vnd.apple.mpegurl";
      else finalCt = "video/mp4";
    }

    const out = {
      "cache-control": "private, max-age=300",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "*",
      "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
      "cross-origin-resource-policy": "cross-origin"
    };
    for (const k of ["content-range", "accept-ranges", "etag", "last-modified"]) { const v = r.headers.get(k); if (v) out[k] = v; }
    out["content-type"] = finalCt;
    if (!r.headers.get("content-encoding")) { const cl = r.headers.get("content-length"); if (cl) out["content-length"] = cl; }
    if (!out["accept-ranges"]) out["accept-ranges"] = "bytes";
    res.socket?.setNoDelay(true);
    res.socket?.setKeepAlive(true, 30_000);
    res.writeHead(r.status, out);
    if (req.method === "HEAD" || !r.body) { try { await r.body?.cancel(); } catch {} return res.end(); }
    const stream = Readable.fromWeb(r.body, { highWaterMark: 1024 * 1024 });
    pipeline(stream, res, () => {});
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof ProxyError) return fail(res, e.status, e.message);
    if (e && (e.name === "AbortError" || e.name === "TimeoutError")) return fail(res, 504, "The video server took too long to respond");
    return fail(res, 502, "Could not reach the video server: " + ((e && e.cause && e.cause.code) || (e && e.message) || "unknown error"));
  }
}
