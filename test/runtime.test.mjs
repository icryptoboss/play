import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let server, base;
const kvData = new Map();

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const pathname = req.url.split("?")[0];
      if (pathname === "/list") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<html><body><div class="grid">
          <a class="item" href="/m/1"><img src="/i/1.jpg"><span>First Movie</span></a>
          <a class="item" href="/m/2"><img src="/i/2.jpg"><span>Second Movie</span></a></div></body></html>`);
      } else if (pathname === "/redirect") {
        res.statusCode = 302; res.setHeader("location", "/list"); res.end();
      } else if (pathname === "/echo") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ method: req.method, ua: req.headers["user-agent"], referer: req.headers.referer, ct: req.headers["content-type"], body }));
      } else if (pathname === "/bin") {
        res.setHeader("content-type", "application/octet-stream");
        res.end(Buffer.from([1, 2, 3, 250]));
      } else if (pathname === "/big") {
        res.setHeader("content-type", "text/plain");
        res.end("x".repeat(6 * 1024 * 1024));
      } else { res.statusCode = 404; res.end("nope"); }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function makeEnv(env = {}) {
  Object.assign(process.env, { PROXY_ALLOWED_HOSTS: "127.0.0.1", PROXY_ALLOW_PRIVATE: "1" }, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  const proxy = (await import("../server/proxy.mjs?" + Math.random())).default;
  const { createRuntime } = await import("../src/runtime.js");
  const fetchImpl = (url, init) => proxy(new Request("http://site.test/api/proxy", init));
  const rt = createRuntime({
    fetchImpl,
    kv: async (provider, op, key, value) => {
      const k = provider + ":" + key;
      if (op === "get") return kvData.get(k);
      if (op === "set") return void kvData.set(k, value);
      if (op === "delete") return kvData.delete(k);
      if (op === "keys") return [...kvData.keys()].filter((x) => x.startsWith(provider + ":")).map((x) => x.slice(provider.length + 1));
      if (op === "clear") return void kvData.clear();
    },
  });
  let n = 0;
  const run = (provider, module, fn, args, code) => rt.call({ id: ++n, provider, module, fn, args, code, key: provider + module + Math.random(), cfg: { proxyUrl: "/api/proxy", proxyKey: env.__key || "" } });
  return { rt, run, proxy };
}

test("runs the real built example provider from providers-template", async () => {
  const dist = process.env.TEMPLATE_DIST;
  if (!dist || !fs.existsSync(dist)) return; // optional
  const { run } = await makeEnv();
  const code = (m) => fs.readFileSync(path.join(dist, "example", m + ".js"), "utf8");
  const cat = await run("example", "catalog", "catalog", {}, code("catalog"));
  assert.ok(cat.ok); assert.equal(cat.result.catalog[0].title, "Popular Movies"); assert.equal(cat.result.genres[0].title, "Action");
  const posts = await run("example", "posts", "getPosts", { filter: "/x", page: 1, providerValue: "example" }, code("posts"));
  assert.equal(posts.result.length, 2);
  const meta = await run("example", "meta", "getMeta", { link: "https://example.com/post-1" }, code("meta"));
  assert.equal(meta.result.linkList[0].directLinks[0].title, "Play Movie");
  const st = await run("example", "stream", "getStream", { link: "x", type: "movie" }, code("stream"));
  assert.equal(st.result[0].type, "m3u8");
  const se = await run("example", "settings", "getSettingsSchema", {}, code("settings"));
  assert.equal(se.result.length, 5);
});

// A scraper written the way real providers are (CommonJS, providerContext.axios + cheerio)
const scraper = `
exports.getPosts = async function ({ filter, page, providerContext }) {
  const { axios, cheerio, commonHeaders } = providerContext;
  const res = await axios.get(filter, { headers: { ...commonHeaders, Referer: "https://ref.test/" } });
  const $ = cheerio.load(res.data);
  return $("a.item").map((i, el) => ({ title: $(el).find("span").text(), link: new URL($(el).attr("href"), filter).href, image: $(el).find("img").attr("src") })).get();
};
exports.postForm = async function ({ filter, providerContext }) {
  const { axios } = providerContext;
  const a = await axios.post(filter, new URLSearchParams({ q: "hello world" }));
  const b = await axios.post(filter, { x: 1 });
  const inst = axios.create({ baseURL: filter.replace("/echo", ""), headers: { "X-Test": "1" } });
  const c = await inst.get("/echo", { params: { a: 1 } });
  return { a: a.data, b: b.data, c: c.data };
};
exports.finalUrl = async function ({ filter, providerContext }) {
  const r = await providerContext.axios.get(filter);
  return { url: r.request.responseURL, status: r.status };
};
exports.notFound = async function ({ filter, providerContext }) {
  try { await providerContext.axios.get(filter + "/missing"); } catch (e) { return { status: e.response.status, data: e.response.data }; }
};
exports.binary = async function ({ filter, providerContext }) {
  const r = await providerContext.axios.get(filter, { responseType: "arraybuffer" });
  return Array.from(new Uint8Array(r.data));
};
exports.kv = async function ({ providerContext }) {
  const { kvStore } = providerContext;
  await kvStore.set("quality", "1080");
  return { v: await kvStore.get("quality"), keys: await kvStore.keys() };
};
exports.buf = async function () { return Buffer.from("hi").toString("base64") + typeof process.env; };
exports.boom = async function () { throw new Error("provider exploded"); };
`;

test("scraper provider: axios + cheerio through the proxy", async () => {
  const { run } = await makeEnv();
  const r = await run("s", "posts", "getPosts", { filter: base + "/list", page: 1 }, scraper);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.result.map((p) => p.title), ["First Movie", "Second Movie"]);
  assert.equal(r.result[0].link, base + "/m/1");
});

test("headers, POST bodies, axios.create, params all survive the relay", async () => {
  const { run } = await makeEnv();
  const r = await run("s", "posts", "postForm", { filter: base + "/echo" }, scraper);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.result.a.method, "POST");
  assert.equal(r.result.a.body, "q=hello+world");
  assert.match(r.result.a.ct, /x-www-form-urlencoded/);
  assert.equal(r.result.b.body, '{"x":1}');
  assert.match(r.result.b.ct, /json/);
  assert.equal(r.result.c.method, "GET");
});

test("referer + user agent are forwarded", async () => {
  const { run } = await makeEnv();
  const code = `exports.f = async ({filter, providerContext:{axios,commonHeaders}}) => (await axios.get(filter,{headers:{...commonHeaders, Referer:"https://ref.test/"}})).data;`;
  const r = await run("s", "m", "f", { filter: base + "/echo" }, code);
  assert.equal(r.result.referer, "https://ref.test/");
  assert.match(r.result.ua, /Chrome/);
});

test("redirects are followed and responseURL is exposed", async () => {
  const { run } = await makeEnv();
  const r = await run("s", "posts", "finalUrl", { filter: base + "/redirect" }, scraper);
  assert.equal(r.result.url, base + "/list");
  assert.equal(r.result.status, 200);
});

test("non-2xx rejects like axios, with the response attached", async () => {
  const { run } = await makeEnv();
  const r = await run("s", "posts", "notFound", { filter: base }, scraper);
  assert.equal(r.result.status, 404);
  assert.equal(r.result.data, "nope");
});

test("binary responses come back as ArrayBuffer", async () => {
  const { run } = await makeEnv();
  const r = await run("s", "posts", "binary", { filter: base + "/bin" }, scraper);
  assert.deepEqual(r.result, [1, 2, 3, 250]);
});

test("kvStore, Buffer and process shims work; errors surface", async () => {
  const { run } = await makeEnv();
  const r = await run("s", "posts", "kv", {}, scraper);
  assert.deepEqual(r.result, { v: "1080", keys: ["quality"] });
  const b = await run("s", "posts", "buf", {}, scraper);
  assert.equal(b.result, "aGk=object");
  const e = await run("s", "posts", "boom", {}, scraper);
  assert.equal(e.ok, false); assert.match(e.error.message, /provider exploded/);
});

test("worker asks for code first, then caches the module", async () => {
  const { rt } = await makeEnv();
  const first = await rt.call({ id: 1, provider: "x", module: "m", fn: "boom", key: "k1", args: {} });
  assert.equal(first.needCode, true);
});

test("proxy refuses hosts outside the allowlist and names the host", async () => {
  const { run } = await makeEnv({ PROXY_ALLOWED_HOSTS: "allowed.example" });
  const r = await run("s", "posts", "getPosts", { filter: base + "/list" }, scraper);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /127\.0\.0\.1.*PROXY_ALLOWED_HOSTS/);
});

test("proxy blocks private addresses unless explicitly allowed", async () => {
  const { run } = await makeEnv({ PROXY_ALLOW_PRIVATE: undefined });
  const r = await run("s", "posts", "getPosts", { filter: base + "/list" }, scraper);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /private|unsupported/);
  const meta = await run("s", "posts", "getPosts", { filter: "http://169.254.169.254/latest/meta-data/" }, scraper);
  assert.equal(meta.ok, false);
});

test("unconfigured proxy and wildcard-without-key both fail closed", async () => {
  let { run } = await makeEnv({ PROXY_ALLOWED_HOSTS: "" });
  let r = await run("s", "posts", "getPosts", { filter: base + "/list" }, scraper);
  assert.match(r.error.message, /not configured/);
  ({ run } = await makeEnv({ PROXY_ALLOWED_HOSTS: "*" }));
  r = await run("s", "posts", "getPosts", { filter: base + "/list" }, scraper);
  assert.match(r.error.message, /requires PROXY_ACCESS_KEY/);
});

test("access key is enforced when set", async () => {
  process.env.PROXY_ACCESS_KEY = "s3cret";
  const bad = await makeEnv({ PROXY_ACCESS_KEY: "s3cret" });
  let r = await bad.run("s", "posts", "getPosts", { filter: base + "/list" }, scraper);
  assert.match(r.error.message, /access key/i);
  const good = await makeEnv({ PROXY_ACCESS_KEY: "s3cret", __key: "s3cret" });
  r = await good.run("s", "posts", "getPosts", { filter: base + "/list" }, scraper);
  assert.ok(r.ok, JSON.stringify(r));
  delete process.env.PROXY_ACCESS_KEY; delete process.env.__key;
});

test("responses over 5 MB are rejected", async () => {
  const { run } = await makeEnv();
  const r = await run("s", "posts", "binary", { filter: base + "/big" }, scraper);
  assert.equal(r.ok, false); assert.match(r.error.message, /5 MB/);
});

test("allowlist and private-IP helpers", async () => {
  const { hostAllowed, isPrivateIp } = await import("../server/proxy.mjs");
  assert.ok(hostAllowed("a.b.example.com", ["example.com"]));
  assert.ok(hostAllowed("example.com", ["*.example.com"]));
  assert.ok(!hostAllowed("evilexample.com", ["example.com"]));
  assert.ok(!hostAllowed("example.com.evil.io", ["example.com"]));
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.9", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.ok(!isPrivateIp(ip), ip);
});

test("the shipped worker bundle loads axios+cheerio and answers messages", async () => {
  const { default: proxyHandler } = await (async () => { await makeEnv(); return import("../server/proxy.mjs?" + Math.random()); })();
  const sent = [];
  const self = { postMessage: (m) => sent.push(m) };
  const ctx = vm.createContext({
    self, console, setTimeout, clearTimeout, queueMicrotask, AbortController, URL, URLSearchParams, TextEncoder, TextDecoder,
    atob, btoa, Uint8Array, ArrayBuffer, Promise, Headers, Request, Response, Blob, FormData, structuredClone,
    fetch: (u, i) => proxyHandler(new Request("http://site.test/api/proxy", i)),
  });
  vm.runInContext(fs.readFileSync(path.join(root, "public", "provider-worker.js"), "utf8"), ctx);
  assert.equal(typeof self.onmessage, "function");
  await self.onmessage({ data: { type: "call", id: 1, provider: "s", module: "posts", fn: "getPosts", key: "z", code: scraper, args: { filter: base + "/list", page: 1 }, cfg: { proxyUrl: "/api/proxy" } } });
  const res = sent.find((m) => m.type === "result");
  assert.ok(res && res.ok, JSON.stringify(res));
  assert.equal(res.result.length, 2);
});
