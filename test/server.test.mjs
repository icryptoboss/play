import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { createApp } from "../server/server.mjs";

let upstream, app, base, up;

before(async () => {
  upstream = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ m: req.method, b })); });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  up = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(process.env, { PROXY_ALLOWED_HOSTS: "127.0.0.1", PROXY_ALLOW_PRIVATE: "1" });
  delete process.env.PROXY_ACCESS_KEY;
  app = createApp({ rateLimitPerMin: 5 });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => { app.close(); upstream.close(); });

const post = (body) => fetch(base + "/api/proxy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("health check", async () => {
  const r = await fetch(base + "/healthz");
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });

  process.env.STREAM_ACCELERATOR_URL = "https://accelerator.example.workers.dev";
  const r2 = await fetch(base + "/healthz");
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { ok: true, acceleratorUrl: "https://accelerator.example.workers.dev" });
  delete process.env.STREAM_ACCELERATOR_URL;
});

test("serves the app, with security headers and correct types", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(await r.text(), /Vega Web/);
  for (const [p, t] of [["/app.js", /javascript/], ["/styles.css", /css/], ["/provider-worker.js", /javascript/], ["/manifest.webmanifest", /manifest/]]) {
    const x = await fetch(base + p); assert.equal(x.status, 200, p); assert.match(x.headers.get("content-type"), t, p);
  }
});

test("gzip for big text assets and ETag revalidation", async () => {
  const r = await new Promise((resolve) => http.get(base + "/provider-worker.js", { headers: { "accept-encoding": "gzip" } }, (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ res, buf: Buffer.concat(c) })); }));
  assert.equal(r.res.headers["content-encoding"], "gzip");
  assert.ok(r.buf.length < 300_000);
  assert.match(zlib.gunzipSync(r.buf).toString().slice(0, 200000), /function|=>/);
  const again = await fetch(base + "/app.js", { headers: { "if-none-match": (await fetch(base + "/app.js")).headers.get("etag") } });
  assert.equal(again.status, 304);
});

test("unknown paths 404; traversal is impossible", async () => {
  assert.equal((await fetch(base + "/nope")).status, 404);
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fserver/server.mjs", "/server/server.mjs", "/%00", "/%zz"]) {
    const s = await new Promise((resolve) => { const q = http.request({ host: "127.0.0.1", port: app.address().port, path: p, method: "GET" }, (res) => { res.resume(); resolve(res.statusCode); }); q.end(); });
    assert.ok(s === 404 || s === 400, p + " -> " + s);
  }
});

test("only GET/HEAD on static; HEAD has no body", async () => {
  assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
  const h = await fetch(base + "/", { method: "HEAD" }); assert.equal(h.status, 200); assert.equal((await h.text()), "");
});

test("proxy: GET status endpoint and a relayed POST", async () => {
  const s = await (await fetch(base + "/api/proxy")).json();
  assert.equal(s.configured, true); assert.deepEqual(s.allowedHosts, ["127.0.0.1"]);
  const r = await post({ url: up + "/x", method: "POST", headers: { "content-type": "text/plain" }, body: "hello", bodyEncoding: "utf8" });
  const j = await r.json();
  assert.equal(j.status, 200); assert.deepEqual(JSON.parse(j.body), { m: "POST", b: "hello" });
});

test("proxy: refuses unlisted hosts and bad input", async () => {
  const r = await post({ url: "http://example.org/", method: "GET" });
  assert.equal(r.status, 403); assert.match((await r.json()).proxyError, /PROXY_ALLOWED_HOSTS/);
  const bad = await fetch(base + "/api/proxy", { method: "POST", body: "not json" });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(base + "/api/proxy", { method: "DELETE" })).status, 405);
});

test("proxy: oversized request body rejected", async () => {
  const r = await fetch(base + "/api/proxy", { method: "POST", body: "x".repeat(3 * 1024 * 1024) }).catch((e) => e);
  assert.ok(r instanceof Error || r.status === 413);
});

test("proxy: per-client rate limit returns 429 with retry-after", async () => {
  let last;
  for (let i = 0; i < 8; i++) last = await post({ url: up + "/x", method: "GET" });
  assert.equal(last.status, 429); assert.equal(last.headers.get("retry-after"), "60");
  assert.equal((await fetch(base + "/")).status, 200); // static pages are not limited
});
