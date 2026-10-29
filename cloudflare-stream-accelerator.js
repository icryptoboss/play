/**
 * Cloudflare Edge Stream Accelerator & CORS Proxy for Vega Web
 * 
 * Deploy as a Cloudflare Worker (Free tier: 100,000 req/day with multi-gigabit global CDN caching).
 * Provides low-latency, zero-buffer video streaming and website scraping on mobile & desktop.
 * 
 * How to use:
 * 1. Deploy this worker to Cloudflare Workers (e.g. https://my-accelerator.workers.dev).
 * 2. In Vega Web Settings or browser console, set:
 *    localStorage.setItem('vegaStreamAccelerator', 'https://my-accelerator.workers.dev');
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, accelerator: "cloudflare-edge" }), {
        headers: { "content-type": "application/json", ...corsHeaders }
      });
    }

    // 1. Streaming endpoints: /source, /segment.ts, /playlist.m3u8, /api/stream (including /source/video.mp4 etc.)
    if (["/source", "/segment.ts", "/playlist.m3u8", "/api/stream"].includes(url.pathname) || url.pathname.startsWith("/source") || url.pathname.startsWith("/segment.ts") || url.pathname.startsWith("/playlist.m3u8")) {
      const targetUrl = url.searchParams.get("url") || url.searchParams.get("u");
      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing url parameter" }), {
          status: 400,
          headers: { "content-type": "application/json", ...corsHeaders }
        });
      }

      let customHeaders = {};
      const headersParam = url.searchParams.get("headers") || url.searchParams.get("h");
      if (headersParam) {
        try { customHeaders = JSON.parse(headersParam); } catch {}
      }

      const reqHeaders = new Headers();
      reqHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
      reqHeaders.set("Accept", "*/*");

      // Forward custom headers from provider (Referer, Origin, Cookie, etc.)
      for (const [k, v] of Object.entries(customHeaders)) {
        if (typeof v === "string") reqHeaders.set(k, v);
      }
      if (!reqHeaders.has("Referer")) {
        try { reqHeaders.set("Referer", new URL(targetUrl).origin + "/"); } catch {}
      }

      // Forward Range header from video player for byte-range seeking
      const range = request.headers.get("range");
      if (range) reqHeaders.set("range", range);

      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers: reqHeaders,
        redirect: "follow",
        cf: {
          cacheEverything: true,
          cacheTtl: 86400,
          cacheTtlByStatus: { "200-299": 86400, "404": 1, "500-599": 0 }
        }
      });

      // Handle HLS playlist rewriting
      const isHls = url.pathname === "/playlist.m3u8" || /\.m3u8(?:[?#]|$)/i.test(targetUrl);
      if (isHls && upstream.ok) {
        const text = await upstream.text();
        if (text.trimStart().startsWith("#EXTM3U")) {
          const hStr = JSON.stringify(customHeaders);
          const rewritten = text.replace(/^﻿/, "").replace(/\r/g, "").split("\n").map(line => {
            const t = line.trim();
            if (!t) return line;
            if (t.startsWith("#")) {
              return line.replace(/URI="([^"]*)"/g, (m, u) => {
                if (!u || /^data:/i.test(u)) return m;
                try {
                  const abs = new URL(u, targetUrl).href;
                  return `URI="${url.origin}/segment.ts?url=${encodeURIComponent(abs)}&headers=${encodeURIComponent(hStr)}"`;
                } catch { return m; }
              });
            }
            try {
              const abs = new URL(t, targetUrl).href;
              const isSub = /\.m3u8(?:[?#]|$)/i.test(abs);
              const ep = isSub ? "/playlist.m3u8" : "/segment.ts";
              return `${url.origin}${ep}?url=${encodeURIComponent(abs)}&headers=${encodeURIComponent(hStr)}`;
            } catch { return line; }
          }).join("\n");

          return new Response(rewritten, {
            status: 200,
            headers: {
              ...corsHeaders,
              "content-type": "application/vnd.apple.mpegurl",
              "cache-control": "no-store"
            }
          });
        }
      }

      // Stream media chunks (MP4, MKV, TS) with Range and CORS
      const respHeaders = new Headers(corsHeaders);
      for (const h of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
        const v = upstream.headers.get(h);
        if (v) respHeaders.set(h, v);
      }
      if (!respHeaders.has("accept-ranges")) respHeaders.set("accept-ranges", "bytes");

      let ct = upstream.headers.get("content-type") || "";
      const lower = (url.pathname + " " + targetUrl).toLowerCase();
      if (!ct || ct === "application/octet-stream" || ct === "binary/octet-stream" || ct.startsWith("text/")) {
        if (lower.includes(".mkv")) ct = "video/x-matroska";
        else if (lower.includes(".mp4") || lower.includes(".m4v")) ct = "video/mp4";
        else if (lower.includes(".webm")) ct = "video/webm";
        else if (lower.includes(".ts")) ct = "video/mp2t";
        else if (lower.includes(".m3u8")) ct = "application/vnd.apple.mpegurl";
        else ct = "video/mp4";
      }
      respHeaders.set("content-type", ct);
      respHeaders.set("cross-origin-resource-policy", "cross-origin");
      respHeaders.set("cache-control", "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400");

      return new Response(upstream.body, {
        status: upstream.status,
        headers: respHeaders
      });
    }

    // 2. Scraper Proxy endpoint: /api/proxy
    if (url.pathname === "/api/proxy" && request.method === "POST") {
      const payload = await request.json();
      const target = payload.url;

      if (target && target.includes("modflix.json")) {
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
        const enc = btoa(JSON.stringify(modflixData));
        return new Response(JSON.stringify({
          url: target,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: enc,
          encoding: "base64",
          setCookie: [],
          cookieUpdates: []
        }), {
          headers: { "content-type": "application/json", ...corsHeaders }
        });
      }

      const headers = new Headers();
      headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
      headers.set("Accept", "*/*");
      if (payload.headers) {
        for (const [k, v] of Object.entries(payload.headers)) {
          if (typeof v === "string") headers.set(k, v);
        }
      }
      let body;
      if (payload.body) {
        body = payload.bodyEncoding === "base64" ? Uint8Array.from(atob(payload.body), c => c.charCodeAt(0)) : payload.body;
      }
      const resp = await fetch(target, {
        method: payload.method || "GET",
        headers,
        body: ["GET", "HEAD"].includes(payload.method) ? undefined : body,
        redirect: payload.maxRedirects === 0 ? "manual" : "follow"
      });
      const respBuffer = await resp.arrayBuffer();
      const bytes = new Uint8Array(respBuffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64Body = btoa(binary);
      const outHeaders = {};
      resp.headers.forEach((v, k) => { outHeaders[k] = v; });

      return new Response(JSON.stringify({
        url: resp.url || target,
        status: resp.status,
        statusText: resp.statusText,
        headers: outHeaders,
        body: base64Body,
        encoding: "base64"
      }), {
        headers: { "content-type": "application/json", ...corsHeaders }
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};
