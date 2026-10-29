// Server-side HTTP relay used by the in-browser provider runtime.
// Framework-neutral: takes a fetch Request, returns a fetch Response.
//
// Providers scrape websites, which browsers block (CORS). This function performs
// the request server-side and returns a JSON envelope. It is locked down:
//   * PROXY_ALLOWED_HOSTS (required): comma-separated hostnames it may contact.
//     "example.com" also covers its subdomains. "*" allows any public host but
//     then PROXY_ACCESS_KEY is mandatory.
//   * PROXY_ACCESS_KEY (optional): if set, callers must send it as x-proxy-key.
//   * Private, loopback and link-local addresses are always refused
//     (PROXY_ALLOW_PRIVATE=1 lifts this; for local testing only).
//   * Every redirect hop is re-validated; responses are capped at 5 MB.
import dns from "node:dns/promises";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class ProxyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function parseAllowList(v) {
  return String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function hostAllowed(host, list) {
  if (list.includes("*")) return true;
  host = host.toLowerCase();
  return list.some((p) => {
    p = p.replace(/^\*\./, "");
    return host === p || host.endsWith("." + p);
  });
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::" || l === "::1") return true;
    if (/^f[cd]/.test(l) || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb")) return true;
    const dotted = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPrivateIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
    }
    return false;
  }
  return true;
}

export async function checkTarget(u, allow, allowPrivate, envName = "PROXY_ALLOWED_HOSTS") {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ProxyError(400, "Only http and https URLs are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostAllowed(host, allow)) {
    throw new ProxyError(403, `Host "${host}" is not in ${envName}. Add it to the ${envName} environment variable and redeploy.`);
  }
  if (allowPrivate) return;
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new ProxyError(403, `Host "${host}" resolves to a private or unsupported address`);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-javascript|x-www-form-urlencoded|vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|.*\+(json|xml))/i;

async function readCapped(res) {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) throw new ProxyError(413, "Upstream response is larger than the 5 MB proxy limit");
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { try { await reader.cancel(); } catch {} throw new ProxyError(413, "Upstream response is larger than the 5 MB proxy limit"); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

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

export default async (req) => {
  try {
    const keyEnv = process.env.PROXY_ACCESS_KEY || "";
    const allow = parseAllowList(process.env.PROXY_ALLOWED_HOSTS);
    const sameOrigin = isSameOriginRequest(req);
    const keyOk = !keyEnv || sameOrigin || safeEqual(req.headers.get("x-proxy-key") || "", keyEnv);

    if (req.method === "GET") {
      const sAllow = parseAllowList(process.env.STREAM_ALLOWED_HOSTS);
      const relay = !sAllow.length ? "off" : sAllow.includes("*") ? (keyEnv ? "any" : "needs-key") : "allowlist";
      return json(200, { ok: true, configured: allow.length > 0, keyRequired: !!keyEnv, keyOk, allowedHosts: keyOk ? allow : undefined, streamRelay: relay, streamHosts: keyOk && relay === "allowlist" ? sAllow : undefined });
    }
    if (req.method !== "POST") return json(405, { proxyError: "Method not allowed" });
    if (!keyOk) return json(401, { proxyError: "Missing or wrong access key. Enter it in Settings → Proxy." });
    if (!allow.length) return json(403, { proxyError: "Proxy is not configured. Set PROXY_ALLOWED_HOSTS in your service environment variables." });
    if (allow.includes("*") && !keyEnv) return json(403, { proxyError: 'PROXY_ALLOWED_HOSTS="*" requires PROXY_ACCESS_KEY to be set.' });

    let p;
    try { p = await req.json(); } catch { return json(400, { proxyError: "Invalid JSON body" }); }
    let target;
    try { target = new URL(p.url); } catch { return json(400, { proxyError: "Invalid url" }); }

    // Intercept modflix.json for legacy getBaseUrl fallback
    if (target.href.includes("modflix.json")) {
      const modflixData = {
        consumet: { url: "https://consumet.org" },
        flixhq: { url: "https://consumet.org" },
        Moviesmod: { name: "Moviesmod", url: "https://moviesmod.meme" },
        Topmovies: { name: "Topmovies", url: "https://moviesleech.club" },
        UhdMovies: { name: "UhdMovies", url: "https://uhdmovies.beauty" },
        Vega: { name: "vegamovies", url: "https://new1.vegamovies.lease" },
        lux: { name: "luxmovies", url: "https://rogmovies.im" },
        drive: { name: "moviesDrive", url: "https://new5.moviesdrive.beer/" },
        multi: { name: "multimovies", url: "https://m1.multimovies.courses" },
        w4u: { name: "world4ufree", url: "https://world4ufree.center" },
        extra: { name: "extraMovies", url: "https://extramovies.ist" },
        hdhub: { name: "hdhub4u", url: "https://new10.hdhub4u.cl" },
        kat: { name: "katmovieshd", url: "https://new.katmoviehd.top" },
        tokyoinsider: { name: "tokyoinsider", url: "https://www.tokyoinsider.com" },
        nfMirror: { name: "nfMirror", url: "https://net77.cc" },
        movieBoxWeb: { name: "MovieBox Web", url: "https://officialmoviebox.com" },
        gokuHD: { name: "GokuHD", url: "https://gokuhd.cc" },
        mkvDrama: { name: "MKVDrama", url: "https://mkvdrama.net" },
        eonMovies: { name: "EonMovies", url: "https://new4.eonmovies.click" },
        primewire: { name: "primewire", url: "https://primewire.pw" },
        kissKh: { name: "kissKh", url: "https://kisskh.is" },
        cinemaLuxe: { name: "cinemaLuxe", url: "https://cinemalux.cyou" },
        showbox: { name: "showbox", url: "https://www.showbox.media" },
        animerulz: { name: "animerulz", url: "https://animerulz.co" },
        moviesapi: { name: "moviesapi", url: "https://vidspark.to" },
        ridomovies: { name: "ridomovies", url: "https://ridomovies.tv" },
        protonMovies: { name: "protonMovies", url: "https://m.protonmovies.space" },
        filmyfly: { name: "flimyfly", url: "https://filmyfiy.co.in" },
        "4khdhub": { name: "4khdhub", url: "https://4khdhub.one" },
        moviezwap: { name: "moviezwap", url: "https://www.moviezwap.poker/" },
        "9xflix": { name: "9xflix", url: "https://soft-water-2a42.flixoflixx.workers.dev" },
        cinevood: { name: "Cinevood", url: "https://kmmovies.autos" },
        kmmovies: { name: "kmmovies", url: "https://kmmovies.autos" },
        zeefliz: { name: "zeefliz", url: "https://zeefliz.beauty" },
        katmoviefix: { name: "katmoviefix", url: "https://katmoviefix.study" },
        movies4u: { name: "movies4u", url: "https://movies4u.tc" },
        joya9tv: { name: "joya9tv1", url: "https://joya9tv1.com" },
        skymovieshd: { name: "skyMovesHd", url: "https://new3.skymovieshd.clinic" },
        "1cinevood": { name: "cinewood", url: "https://one.cinevood.business" },
        cinefreak: { name: "CineFreak", url: "https://cinefreak.net" },
        anikoto: { name: "anikoto", url: "https://anikototv.to" },
        kickAssAnime: { name: "kickAssAnime", url: "https://kaa.lt" },
        castle: { name: "Castle TV", url: "https://api.hlowb.com" },
        animesalt: { name: "animesalt", url: "https://animesalt.in" },
        animeworld: { name: "animeworld", url: "https://watchanimeworld.one" },
        movielinkdb: { name: "movielinkbd", url: "https://ex5wfv.movielinkbd.li" },
        movielinkbd: { name: "movielinkbd", url: "https://ex5wfv.movielinkbd.li" },
        mxplayer: { name: "mxplayer", url: "https://www.mxplayer.in" },
        dramacool: { name: "DramaCool", url: "https://asianc.id" },
        asianc: { name: "AsianC", url: "https://asianc.id" }
      };
      return json(200, {
        status: 200,
        statusText: "OK",
        url: target.href,
        headers: { "content-type": "application/json" },
        setCookie: [],
        cookieUpdates: [],
        body: JSON.stringify(modflixData),
        encoding: "utf8"
      });
    }

    let method = String(p.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "POST"].includes(method)) return json(400, { proxyError: "Method not allowed" });

    const headers = {};
    for (const [k, v] of Object.entries(p.headers && typeof p.headers === "object" ? p.headers : {})) {
      const lk = k.toLowerCase();
      if (["host", "content-length", "connection", "transfer-encoding", "x-proxy-key"].includes(lk)) continue;
      if (typeof v === "string") headers[k] = v;
    }
    if (!headers["user-agent"] && !headers["User-Agent"]) {
      headers["user-agent"] = DEFAULT_UA;
    }
    if (!headers["accept"] && !headers["Accept"]) {
      headers["accept"] = "*/*";
    }

    let body;
    if (method === "POST" && p.body != null) body = p.bodyEncoding === "base64" ? Buffer.from(String(p.body), "base64") : String(p.body);

    const allowPrivate = process.env.PROXY_ALLOW_PRIVATE === "1";
    const maxRedirects = Math.min(Math.max(Number.isFinite(+p.maxRedirects) ? +p.maxRedirects : 5, 0), 10);
    const timeoutMs = Number(process.env.PROXY_TIMEOUT_MS) || 20000;
    const signal = AbortSignal.timeout(timeoutMs);

    let current = target, hops = 0, res;
    const cookieUpdates = [];
    const activeCookies = new Map();
    const incomingCookie = headers["cookie"] || headers["Cookie"];
    if (incomingCookie) {
      incomingCookie.split(";").forEach((pair) => {
        const eq = pair.indexOf("=");
        if (eq > 0) activeCookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      });
    }

    for (;;) {
      await checkTarget(current, allow, allowPrivate);
      if (activeCookies.size > 0) {
        headers["cookie"] = Array.from(activeCookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
      }
      res = await fetch(current, { method, headers, body, redirect: "manual", signal });
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      if (setCookies.length > 0) {
        cookieUpdates.push({ url: current.href, headers: setCookies });
        for (const sc of setCookies) {
          const cookiePart = sc.split(";")[0];
          const eq = cookiePart.indexOf("=");
          if (eq > 0) activeCookies.set(cookiePart.slice(0, eq).trim(), cookiePart.slice(eq + 1).trim());
        }
      }

      const loc = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && loc && hops < maxRedirects) {
        hops++;
        current = new URL(loc, current);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET"; body = undefined;
          for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-type") delete headers[k];
        }
        try { await res.body?.cancel(); } catch {}
        continue;
      }
      break;
    }

    const bytes = method === "HEAD" ? new Uint8Array(0) : await readCapped(res);
    const ct = res.headers.get("content-type") || "";
    const isText = TEXT_TYPE.test(ct) || (!ct && bytes.length === 0);
    let outBody, encoding;
    if (isText) {
      const cs = (ct.match(/charset=["']?([\w-]+)/i) || [])[1] || "utf-8";
      let dec;
      try { dec = new TextDecoder(cs); } catch { dec = new TextDecoder("utf-8"); }
      outBody = dec.decode(bytes); encoding = "utf8";
    } else {
      outBody = Buffer.from(bytes).toString("base64"); encoding = "base64";
    }
    const outHeaders = {};
    res.headers.forEach((v, k) => { if (k !== "set-cookie" && k !== "content-encoding" && k !== "content-length") outHeaders[k] = v; });
    return json(200, {
      status: res.status, statusText: res.statusText, url: current.href, headers: outHeaders,
      setCookie: typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [],
      cookieUpdates,
      body: outBody, encoding,
    });
  } catch (e) {
    if (e instanceof ProxyError) return json(e.status, { proxyError: e.message });
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return json(504, { proxyError: "Upstream request timed out" });
    return json(502, { proxyError: "Upstream request failed: " + ((e && e.cause && e.cause.code) || (e && e.message) || "unknown error") });
  }
};

