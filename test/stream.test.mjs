import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../server/server.mjs";
import { signToken, rewritePlaylist } from "../server/stream.mjs";

let video, app, base, up;
const seen = [];
const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

before(async () => {
  video = http.createServer((req, res) => {
    seen.push({ url: req.url, h: req.headers });
    const p = req.url.split("?")[0];
    if (p === "/video.mp4" || p === "/video.mkv" || p === "/abs/seg2.ts" || p === "/live/seg1.ts") {
      if (req.headers.referer !== "https://ref.test/") { res.statusCode = 403; return res.end("need referer"); }
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      res.setHeader("accept-ranges", "bytes"); res.setHeader("content-type", p.endsWith(".ts") ? "video/mp2t" : p.endsWith(".mkv") ? "video/x-matroska" : "video/mp4");
      if (m) {
        const a = +m[1], b = m[2] ? +m[2] : BYTES.length - 1;
        res.statusCode = 206; res.setHeader("content-range", `bytes ${a}-${b}/${BYTES.length}`);
        return res.end(BYTES.subarray(a, b + 1));
      }
      return res.end(BYTES);
    }
    if (p === "/live/master.m3u8") {
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      return res.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\n/abs/seg2.ts\n#EXTINF:4,\nhttp://127.0.0.1:${video.address().port}/live/seg1.ts?x=1\n#EXT-X-ENDLIST\n`);
    }
    if (p === "/noext") { res.setHeader("content-type", "text/plain"); return res.end("#EXTM3U\nseg1.ts\n"); } // not detected as a playlist by type/extension
    if (p === "/redir") { res.statusCode = 302; res.setHeader("location", "/video.mp4"); return res.end(); }
    if (p === "/echo") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(req.headers)); }
    res.statusCode = 404; res.end("nope");
  });
  await new Promise((r) => video.listen(0, "127.0.0.1", r));
  up = `http://127.0.0.1:${video.address().port}`;
  app = createApp({ rateLimitPerMin: 0, streamRateLimitPerMin: 0 });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => { app.close(); video.close(); });

function env(o) {
  for (const k of ["PROXY_ACCESS_KEY", "STREAM_ALLOWED_HOSTS", "PROXY_ALLOWED_HOSTS", "PROXY_ALLOW_PRIVATE", "STREAM_SECRET"]) delete process.env[k];
  Object.assign(process.env, { PROXY_ALLOW_PRIVATE: "1", ...o });
}
const mint = (url, headers, key) => fetch(base + "/api/stream-url", { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-proxy-key": key } : {}) }, body: JSON.stringify({ url, headers }) });
const REF = { referer: "https://ref.test/" };

test("relay is off by default and says exactly what to set", async () => {
  env({ PROXY_ALLOWED_HOSTS: "127.0.0.1" });
  const r = await mint(up + "/video.mp4", REF);
  assert.equal(r.status, 403); assert.match((await r.json()).proxyError, /STREAM_ALLOWED_HOSTS/);
  assert.equal((await (await fetch(base + "/api/proxy")).json()).streamRelay, "off");
});

test("status reports allowlist / any / needs-key modes", async () => {
  env({ PROXY_ALLOWED_HOSTS: "127.0.0.1", STREAM_ALLOWED_HOSTS: "a.test,b.test" });
  let s = await (await fetch(base + "/api/proxy")).json(); assert.equal(s.streamRelay, "allowlist"); assert.deepEqual(s.streamHosts, ["a.test", "b.test"]);
  env({ PROXY_ALLOWED_HOSTS: "127.0.0.1", STREAM_ALLOWED_HOSTS: "*" });
  s = await (await fetch(base + "/api/proxy")).json(); assert.equal(s.streamRelay, "needs-key");
  env({ PROXY_ALLOWED_HOSTS: "127.0.0.1", STREAM_ALLOWED_HOSTS: "*", PROXY_ACCESS_KEY: "k" });
  s = await (await fetch(base + "/api/proxy", { headers: { "x-proxy-key": "k" } })).json(); assert.equal(s.streamRelay, "any");
});

test("headers are attached, Range works, unsafe headers are dropped", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1" });
  const m = await mint(up + "/video.mp4", { ...REF, "X-Evil": "1", host: "evil.test", cookie: "a=b" });
  assert.equal(m.status, 200);
  const { url } = await m.json(); assert.match(url, /^\/api\/stream\?t=/);
  const full = await fetch(base + url);
  assert.equal(full.status, 200); assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), BYTES);
  const part = await fetch(base + url, { headers: { range: "bytes=10-19" } });
  assert.equal(part.status, 206); assert.equal(part.headers.get("content-range"), "bytes 10-19/1000");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), BYTES.subarray(10, 20));
  const sent = seen.filter((s) => s.url === "/video.mp4").pop().h;
  assert.equal(sent.referer, "https://ref.test/"); assert.equal(sent.cookie, "a=b");
  assert.equal(sent["x-evil"], undefined); assert.notEqual(sent.host, "evil.test");
  assert.match(sent["user-agent"], /Mozilla/);
});

test("upstream errors pass through with their status", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1" });
  const { url } = await (await mint(up + "/video.mp4", {})).json(); // no referer → upstream 403
  assert.equal((await fetch(base + url)).status, 403);
});

test("redirects are followed", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1" });
  const { url } = await (await mint(up + "/redir", REF)).json();
  const r = await fetch(base + url); assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 1000);
});

test("HLS playlists are rewritten so segments, keys and init maps also use the relay", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1" });
  const { url } = await (await mint(up + "/live/master.m3u8", REF)).json();
  const r = await fetch(base + url);
  assert.match(r.headers.get("content-type"), /mpegurl/);
  const txt = await r.text();
  assert.match(txt, /^#EXTM3U/);
  assert.ok(!txt.includes("127.0.0.1"), "no direct upstream URLs left: " + txt);
  const uris = [...txt.matchAll(/(?:URI=")?(\/api\/stream\?t=[\w.-]+)/g)].map((m) => m[1]);
  assert.equal(uris.length, 5, txt); // key, map, 3 segments
  // a rewritten segment fetches the right file with the Referer still attached
  const segLine = txt.split("\n").filter((l) => l.startsWith("/api/stream"))[1]; // the /abs/seg2.ts line
  const seg = await fetch(base + segLine);
  assert.equal(seg.status, 200); assert.equal(seg.headers.get("content-type"), "video/mp2t");
  assert.equal(seen.filter((s) => s.url === "/abs/seg2.ts").pop().h.referer, "https://ref.test/");
});

test("rewritePlaylist: relative, absolute, data: URIs and comments", () => {
  process.env.STREAM_ALLOWED_HOSTS = "x";
  const out = rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXT-X-MEDIA:URI="data:text/plain;base64,AA=="\n# comment\n\na/b.ts\n', "https://cdn.test/v/index.m3u8", {});
  const lines = out.split("\n");
  assert.match(lines[1], /URI="\/api\/stream\?t=/); assert.equal(lines[2], '#EXT-X-MEDIA:URI="data:text/plain;base64,AA=="');
  assert.equal(lines[3], "# comment"); assert.equal(lines[4], ""); assert.match(lines[5], /^\/api\/stream\?t=/);
});

test("forged, tampered and expired tokens are refused", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1" });
  const { url } = await (await mint(up + "/video.mp4", REF)).json();
  const [body, sig] = decodeURIComponent(url.split("t=")[1]).split(".");
  const evilBody = Buffer.from(JSON.stringify({ u: "http://127.0.0.1:1/x", h: {}, e: Date.now() + 1e6 })).toString("base64url");
  for (const t of [evilBody + "." + sig, body + ".AAAA", "garbage", "", body]) assert.equal((await fetch(base + "/api/stream?t=" + t)).status, 403, t.slice(0, 20));
  const expired = signToken({ u: up + "/video.mp4", h: REF, e: Date.now() - 1000 });
  assert.equal((await fetch(base + "/api/stream?t=" + expired)).status, 403);
  assert.equal((await fetch(base + "/api/stream")).status, 403);
});

test("hosts outside STREAM_ALLOWED_HOSTS are refused at mint time and at fetch time", async () => {
  env({ STREAM_ALLOWED_HOSTS: "cdn.example" });
  const r = await mint(up + "/video.mp4", REF);
  assert.equal(r.status, 403); assert.match((await r.json()).proxyError, /127\.0\.0\.1.*STREAM_ALLOWED_HOSTS/);
  const t = signToken({ u: up + "/video.mp4", h: REF, e: Date.now() + 1e6 }); // valid signature, but host no longer allowed
  const f = await fetch(base + "/api/stream?t=" + t); assert.equal(f.status, 403);
});

test("private addresses are refused unless explicitly allowed", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1", PROXY_ALLOW_PRIVATE: undefined });
  delete process.env.PROXY_ALLOW_PRIVATE;
  const { url } = await (await mint(up + "/video.mp4", REF)).json();
  const f = await fetch(base + url); assert.equal(f.status, 403); assert.match((await f.json()).proxyError, /private/);
  const m = await mint("http://169.254.169.254/latest/", {}); // minting is allowed by name, fetch must still refuse
  env({ STREAM_ALLOWED_HOSTS: "169.254.169.254", PROXY_ALLOW_PRIVATE: undefined }); delete process.env.PROXY_ALLOW_PRIVATE;
  const m2 = await (await mint("http://169.254.169.254/latest/", {})).json();
  assert.equal((await fetch(base + m2.url)).status, 403);
  void m;
});

test("wildcard requires a key; key is enforced for minting", async () => {
  env({ STREAM_ALLOWED_HOSTS: "*" });
  assert.match((await (await mint(up + "/video.mp4", REF)).json()).proxyError, /requires PROXY_ACCESS_KEY/);
  env({ STREAM_ALLOWED_HOSTS: "*", PROXY_ACCESS_KEY: "s3cret" });
  assert.equal((await mint(up + "/video.mp4", REF)).status, 401);
  assert.equal((await mint(up + "/video.mp4", REF, "wrong")).status, 401);
  const ok = await mint(up + "/video.mp4", REF, "s3cret"); assert.equal(ok.status, 200);
  const { url } = await ok.json();
  assert.equal((await fetch(base + url)).status, 200); // playing needs no header: the signed link is the credential
});

test("tokens survive across requests only with the same secret", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1", STREAM_SECRET: "one" });
  const { url } = await (await mint(up + "/video.mp4", REF)).json();
  assert.equal((await fetch(base + url)).status, 200);
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1", STREAM_SECRET: "two" });
  assert.equal((await fetch(base + url)).status, 403);
});

test("only GET/HEAD on the relay; bad bodies and bad URLs are rejected cleanly", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1" });
  const { url } = await (await mint(up + "/video.mp4", REF)).json();
  assert.equal((await fetch(base + url, { method: "POST" })).status, 405);
  const h = await fetch(base + url, { method: "HEAD" }); assert.equal(h.status, 200); assert.equal(await h.text(), "");
  assert.equal((await fetch(base + "/api/stream-url", { method: "POST", body: "nope" })).status, 400);
  assert.equal((await mint("ftp://x.test/a", {})).status, 400);
  assert.equal((await mint("not a url", {})).status, 400);
  assert.equal((await fetch(base + "/api/stream-url")).status, 405);
});

test("CORS headers and OPTIONS preflight work for player engines", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1" });
  const optStreamUrl = await fetch(base + "/api/stream-url", { method: "OPTIONS" });
  assert.equal(optStreamUrl.status, 204);
  assert.equal(optStreamUrl.headers.get("access-control-allow-origin"), "*");

  const { url } = await (await mint(up + "/video.mp4", REF)).json();
  const optStream = await fetch(base + url, { method: "OPTIONS" });
  assert.equal(optStream.status, 204);
  assert.equal(optStream.headers.get("access-control-allow-origin"), "*");

  const getStream = await fetch(base + url);
  assert.equal(getStream.status, 200);
  assert.equal(getStream.headers.get("access-control-allow-origin"), "*");
  assert.match(getStream.headers.get("access-control-expose-headers"), /Content-Range/);
  assert.equal(getStream.headers.get("accept-ranges"), "bytes");
});

test("Direct /source and /playlist.m3u8 endpoints stream with CORS and Range", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1" });
  const directUrl = `${base}/source/video.mp4?url=${encodeURIComponent(up + "/video.mp4")}&headers=${encodeURIComponent(JSON.stringify(REF))}`;
  const res = await fetch(directUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), BYTES);

  const mkvUrl = `${base}/source/video.mkv?url=${encodeURIComponent(up + "/video.mkv")}&headers=${encodeURIComponent(JSON.stringify(REF))}`;
  const mkvRes = await fetch(mkvUrl);
  assert.equal(mkvRes.status, 200);
  assert.equal(mkvRes.headers.get("content-type"), "video/x-matroska");

  const part = await fetch(directUrl, { headers: { range: "bytes=0-9" } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), BYTES.subarray(0, 10));

  const hlsUrl = `${base}/playlist.m3u8?url=${encodeURIComponent(up + "/live/master.m3u8")}&headers=${encodeURIComponent(JSON.stringify(REF))}`;
  const hlsRes = await fetch(hlsUrl);
  assert.equal(hlsRes.status, 200);
  assert.equal(hlsRes.headers.get("access-control-allow-origin"), "*");
  const hlsText = await hlsRes.text();
  assert.match(hlsText, /segment\.ts\?url=/);
});

test("client disconnect mid-stream doesn't crash the server", async () => {
  env({ STREAM_ALLOWED_HOSTS: "127.0.0.1" });
  const { url } = await (await mint(up + "/video.mp4", REF)).json();
  const ac = new AbortController();
  const p = fetch(base + url, { signal: ac.signal }).then((r) => { ac.abort(); return r.arrayBuffer(); }).catch(() => "aborted");
  await p;
  assert.equal((await fetch(base + "/healthz")).status, 200);
});
