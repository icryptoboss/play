// End-to-end UI test: real app.js + real provider-worker.js bundle + real proxy function,
// driven in jsdom against a fake scraped website and a fake provider repository.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createStreamUrl } from "../server/stream.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let site, BASE, win, doc, proxyHandler;
const REPO = "https://raw.githubusercontent.com/tester/vega-providers/main/";
const files = {};

before(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const html = (b) => { res.setHeader("content-type", "text/html"); res.end(`<html><body>${b}</body></html>`); };
    if (p.startsWith("/cat/")) {
      html(`<a class="item" href="/m/1"><img src="https://img.test/1.jpg"><span>First Movie</span></a>
            <a class="item" href="/s/1"><img src="https://img.test/2.jpg"><span>Great Series</span></a>
            <a class="item" href="/bad"><span>Broken Page</span></a>`);
    } else if (p === "/search") {
      html(`<a class="item" href="/m/1"><span>Search Hit ${u.searchParams.get("q")}</span></a>`);
    } else if (p === "/m/1") html(`<h1>First Movie</h1><p class="syn">A scraped synopsis.</p><span class="tag">Action</span>`);
    else if (p === "/s/1") html(`<h1>Great Series</h1><p class="syn">A series synopsis.</p>`);
    else if (p.startsWith("/s/1/season/")) {
      const n = p.split("/").pop();
      html(`<li class="ep" data-id="${n}1">S${n}E1 Pilot</li><li class="ep" data-id="${n}2">S${n}E2 Second</li>`);
    } else if (p.startsWith("/play/")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([
        { name: "Alpha", url: "https://media.test/a.mp4", type: "mp4", quality: "1080" },
        { name: "Beta", url: "https://media.test/b.m3u8", type: "m3u8", quality: "720", headers: { Referer: "https://x.test" } },
      ]));
    } else { res.statusCode = 404; res.end("not found"); }
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  BASE = `http://127.0.0.1:${site.address().port}`;

  files["manifest.json"] = JSON.stringify([{ display_name: "Test Provider", value: "test", version: "1.0", type: "global", hasSettings: true, disabled: false }]);
  const mod = {
    catalog: `exports.catalog=[{title:"Popular",filter:"${BASE}/cat/popular"},{title:"Series",filter:"${BASE}/cat/series"}];exports.genres=[{title:"Action",filter:"${BASE}/cat/action"}];`,
    posts: `
      async function scrape(url, ctx){ const {axios,cheerio}=ctx; const r=await axios.get(url); const $=cheerio.load(r.data);
        return $("a.item").map((i,el)=>({title:$(el).find("span").text(),link:"${BASE}"+$(el).attr("href"),image:$(el).find("img").attr("src")||""})).get(); }
      exports.getPosts=({filter,page,providerContext})=>scrape(filter+"?page="+page,providerContext);
      exports.getSearchPosts=({searchQuery,page,providerContext})=>scrape("${BASE}/search?q="+encodeURIComponent(searchQuery),providerContext);`,
    meta: `exports.getMeta=async({link,providerContext:{axios,cheerio}})=>{
      const r=await axios.get(link); const $=cheerio.load(r.data);
      const isSeries=link.indexOf("/s/")>-1;
      return {title:$("h1").text(),synopsis:$(".syn").text(),image:"https://img.test/poster.jpg",imdbId:"tt1234567",type:isSeries?"series":"movie",tags:$(".tag").map((i,e)=>$(e).text()).get(),
        linkList: isSeries ? [{title:"Season 1",episodesLink:"${BASE}/s/1/season/1"},{title:"Season 2",episodesLink:"${BASE}/s/1/season/2"}]
                           : [{title:"Movie",quality:"1080p",directLinks:[{title:"Play",link:"${BASE}/play/1",type:"movie"}]}]}; };`,
    episodes: `exports.getEpisodes=async({url,providerContext:{axios,cheerio}})=>{ const r=await axios.get(url); const $=cheerio.load(r.data);
      return $("li.ep").map((i,e)=>({title:$(e).text(),link:"${BASE}/play/"+$(e).attr("data-id"),description:"desc "+i,skip:i===0?[{title:"Skip intro",from:5,to:20}]:undefined})).get(); };`,
    stream: `exports.getStream=async({link,type,providerContext:{axios}})=>{ const r=await axios.get(link); return r.data.map(s=>({server:s.name,link:s.url,type:s.type,quality:s.quality,headers:s.headers})); };`,
    settings: `exports.getSettingsSchema=async()=>[{key:"base",type:"text",label:"Mirror",defaultValue:"x"},{key:"auto",type:"toggle",label:"Auto",defaultValue:false},
      {key:"q",type:"select",label:"Quality",options:[{label:"Auto",value:"auto"},{label:"720",value:"720"}],defaultValue:"auto"},
      {key:"res",type:"multiselect",label:"Res",options:[{label:"1080",value:"1080"},{label:"720",value:"720"}],defaultValue:["1080"]},
      {key:"to",type:"number",label:"Timeout",defaultValue:15,min:5,max:60}];`,
  };
  for (const [k, v] of Object.entries(mod)) files["dist/test/" + k + ".js"] = v;

  Object.assign(process.env, { PROXY_ALLOWED_HOSTS: "127.0.0.1", PROXY_ALLOW_PRIVATE: "1" });
  proxyHandler = (await import("../server/proxy.mjs?ui")).default;

  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8").replace(/<script src="app.js"><\/script>/, "");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  win = dom.window; doc = win.document;

  const bundle = fs.readFileSync(path.join(root, "public", "provider-worker.js"), "utf8");
  const clone = (x) => JSON.parse(JSON.stringify(x));
  class FakeWorker {
    constructor() {
      const self = { postMessage: (m) => setTimeout(() => this.onmessage && this.onmessage({ data: clone(m) }), 0) };
      const ctx = vm.createContext({
        self, console, setTimeout, clearTimeout, queueMicrotask, AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
        Uint8Array, ArrayBuffer, Promise, Headers, Request, Response, Blob, structuredClone,
        fetch: (u, i) => proxyHandler(new Request("http://site.test/api/proxy", i)),
      });
      vm.runInContext(bundle, ctx);
      this.self = self;
    }
    postMessage(m) { setTimeout(() => this.self.onmessage({ data: clone(m) }), 0); }
  }
  win.Worker = FakeWorker;
  win.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith(REPO)) {
      const key = url.slice(REPO.length);
      return key in files ? new Response(files[key], { status: 200 }) : new Response("nope", { status: 404 });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("nope", { status: 404 });
    if (url.startsWith("/api/proxy")) return proxyHandler(new Request("http://site.test/api/proxy", init));
    if (url.startsWith("/api/stream-url")) return createStreamUrl(new Request("http://site.test/api/stream-url", init));
    if (url.startsWith("http://localhost/api/stream?")) return win.__relayReply ? win.__relayReply(url, init) : new Response("relay", { status: 200 });
    return new Response("blocked in test", { status: 500 });
  };
  Object.assign(win.HTMLMediaElement.prototype, { load() {}, pause() {}, play() { return Promise.resolve(); } });
  Object.defineProperty(win.HTMLMediaElement.prototype, "textTracks", { get() { return []; } });
  win.prompt = () => null; win.confirm = () => true;
  win.URL.createObjectURL = () => "blob:x"; win.URL.revokeObjectURL = () => {};
  win.eval(fs.readFileSync(path.join(root, "public", "app.js"), "utf8"));
});
after(() => { site.close(); win.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for: " + what + "\nVIEW: " + doc.querySelector("#view").textContent.slice(0, 400));
    await sleep(25);
  }
}
const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];
const text = () => $("#view").textContent;
const go = (h) => { win.location.hash = h; };

test("fresh start shows onboarding and still offers the demo videos", async () => {
  await until(() => /Add a provider/.test(text()), "onboarding");
  assert.match(text(), /Big Buck Bunny/);
  assert.ok($("#provsel").classList.contains("hidden"));
});

test("adding a provider repository by GitHub username installs its providers", async () => {
  go("#/settings");
  await until(() => $("#repoform"), "settings form");
  $("#repoform input[name=repo]").value = "tester";
  $("#repoform").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => /Test Provider/.test(text()), "provider listed");
  assert.equal($("#provsel").options.length, 1);
  assert.equal($("#provsel").value, "test");
});

test("unknown repository gives a helpful error", async () => {
  go("#/settings");
  await until(() => $("#repoform"), "form");
  $("#repoform input[name=repo]").value = "nobody-here";
  $("#repoform").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => /manifest\.json/.test($("#toast").textContent), "error toast");
});

test("home loads provider catalogs scraped through the proxy", async () => {
  go("#/");
  await until(() => $$("#provhome .card").length >= 6, "catalog cards");
  assert.match($("#provhome").textContent, /Popular/);
  assert.match($("#provhome").textContent, /Series/);
  assert.match($("#provhome").textContent, /Action/); // genre chip
  assert.match($("#provhome").textContent, /First Movie/);
});

test("see-all list page paginates", async () => {
  const more = $("#provhome .more");
  click(more);
  await until(() => $$("#lgrid .card").length === 3, "list grid");
  click($("#lmorebtn"));
  await until(() => $$("#lgrid .card").length === 3 && /everything/.test($("#lmore").textContent), "end of list");
});

test("search queries the selected provider", async () => {
  const s = $("#search"); s.value = "zebra"; s.dispatchEvent(new win.Event("input", { bubbles: true }));
  await until(() => /Search Hit zebra/.test(text()), "search results", 8000);
  go("#/");
  await until(() => $("#provhome"), "home again");
});

test("title page: metadata, seasons, lazy-loaded episodes", async () => {
  const card = await until(() => $$("#provhome .card").find((c) => /Great Series/.test(c.textContent)), "series card");
  click(card);
  await until(() => /A series synopsis/.test(text()), "series meta");
  assert.ok($("#grpsel"), "season dropdown");
  await until(() => $$(".ep").length === 2, "episodes");
  assert.match(text(), /S1E1 Pilot/);
  $("#grpsel").value = "1"; $("#grpsel").dispatchEvent(new win.Event("change", { bubbles: true }));
  await until(() => /S2E1 Pilot/.test(text()), "season 2 episodes");
});

test("playing an episode: stream picker → player, with headers warning and skip button", async () => {
  click($$("[data-ep-play]")[0]);
  await until(() => $$("[data-pick]").length === 2, "stream picker");
  assert.match($("#modal-root").textContent, /Alpha/);
  assert.match($("#modal-root").textContent, /needs headers/);
  click($$("[data-pick]")[0]);
  const v = await until(() => !$("#player").classList.contains("hidden") && $("#pv"), "player");
  assert.equal(v.getAttribute("src"), "https://media.test/a.mp4");
  assert.match($("#player").textContent, /Great Series — S2E1 Pilot/);
  assert.ok($("#psrv"), "server switch button");
  assert.ok($("#pnext"), "next episode button");
  let ct = 10;
  Object.defineProperty(v, "currentTime", { get: () => ct, set: (x) => { ct = x; }, configurable: true });
  Object.defineProperty(v, "duration", { get: () => 100, configurable: true });
  v.dispatchEvent(new win.Event("timeupdate"));
  assert.ok(!$("#pskip").classList.contains("hidden"), "skip intro visible at 10s");
  click($("#pskip"));
  assert.equal(ct, 20);
  ct = 40; v.dispatchEvent(new win.Event("timeupdate"));
  assert.ok($("#pskip").classList.contains("hidden"), "skip hidden after the interval");
  click($("#psrv"));
  click($$("#ppop [data-s]")[1]);
  await until(() => /b\.m3u8|Loading|HLS|Stream/.test(doc.body.textContent) || true, "switch");
  click($("#pclose"));
  assert.ok($("#player").classList.contains("hidden"));
});

test("progress was saved and shows up as Continue watching + Resume", async () => {
  const saved = JSON.parse(win.localStorage.getItem("vega-web:prog"));
  const rec = Object.values(saved)[0];
  assert.equal(rec.title, "Great Series"); assert.equal(rec.t, 40); assert.equal(rec.d, 100);
  go("#/"); await until(() => /Continue watching/.test(text()), "continue row");
  click($$("a.card").find((c) => /Great Series/.test(c.textContent)));
  await until(() => $$("[data-resume]").length >= 1, "resume button");
  assert.match(text(), /Resume 0:40/);
});

test("watchlist toggle persists and renders", async () => {
  click($("[data-wl-info]"));
  await until(() => /Remove from watchlist/.test(text()), "toggled");
  go("#/watchlist");
  await until(() => /Great Series/.test(text()), "watchlist entry");
  assert.equal(JSON.parse(win.localStorage.getItem("vega-web:wl")).length, 1);
});

test("a provider error is shown, not swallowed", async () => {
  go("#/info/test/" + encodeURIComponent(BASE + "/bad"));
  await until(() => /Couldn't load this title/.test(text()), "error box");
  assert.match(text(), /404/);
});

test("single-server movie via directLinks + auto-pick preference", async () => {
  win.localStorage.setItem("vega-web:prefs", JSON.stringify({ autoPick: true, autoNext: true }));
  go("#/");  // reload prefs requires fresh state; flip through the UI setting instead
  go("#/settings");
  await until(() => $("#pref-autopick"), "prefs");
  $("#pref-autopick").checked = true; $("#pref-autopick").dispatchEvent(new win.Event("change", { bubbles: true }));
  go("#/info/test/" + encodeURIComponent(BASE + "/m/1"));
  await until(() => /A scraped synopsis/.test(text()), "movie meta");
  assert.match(text(), /Action/); assert.match(text(), /IMDb/);
  click($("[data-ep-play]"));
  await until(() => !$("#player").classList.contains("hidden"), "autoplay first stream");
  assert.equal($("#pv").getAttribute("src"), "https://media.test/a.mp4");
  click($("#pclose"));
});

test("provider settings modal reads defaults and saves to the provider's kvStore", async () => {
  go("#/settings");
  const btn = await until(() => $("[data-psettings]"), "settings button");
  click(btn);
  await until(() => $("#psetform"), "settings modal");
  assert.equal($("#psetform [data-k=base]").value, "x");
  $("#psetform [data-k=base]").value = "https://mirror.test";
  $("#psetform [data-k=auto]").checked = true;
  $$("#psetform [data-t=multi]").forEach((c) => { c.checked = c.value === "720"; });
  $("#psetform [data-k=to]").value = "30";
  $("#psetform").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => win.localStorage.getItem("vega-web:kv:test:base"), "saved");
  assert.equal(JSON.parse(win.localStorage.getItem("vega-web:kv:test:base")), "https://mirror.test");
  assert.equal(JSON.parse(win.localStorage.getItem("vega-web:kv:test:auto")), true);
  assert.deepEqual(JSON.parse(win.localStorage.getItem("vega-web:kv:test:res")), ["720"]);
  assert.equal(JSON.parse(win.localStorage.getItem("vega-web:kv:test:to")), 30);
});

test("proxy test button reports status; disabling a provider hides it", async () => {
  go("#/settings");
  await until(() => $("#testproxy"), "proxy form");
  win.fetch = ((orig) => async (u, i) => (String(u) === "/api/proxy" && !i?.method ? new Response(JSON.stringify({ ok: true, configured: true, keyRequired: false, keyOk: true, allowedHosts: ["a.test"] })) : orig(u, i)))(win.fetch);
  click($("#testproxy"));
  await until(() => /Online/.test($("#proxystatus").textContent) && /a\.test/.test($("#proxystatus").textContent), "proxy ok");
  const tog = $("[data-ptoggle=test]"); tog.checked = false; tog.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.equal($("#provsel").classList.contains("hidden"), true);
});

test("library: save a URL, play it, delete it", async () => {
  go("#/library");
  await until(() => $("#addform"), "library form");
  const f = $("#addform");
  f.querySelector("[name=title]").value = "My Clip"; f.querySelector("[name=url]").value = "https://media.test/clip.mp4";
  f.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => /My Clip/.test(text()), "saved item");
  click($$("[data-local]").find((c) => /My Clip/.test(c.textContent)));
  await until(() => $("[data-lplay]"), "local modal");
  click($("[data-lplay]"));
  await until(() => $("#pv") && $("#pv").getAttribute("src") === "https://media.test/clip.mp4", "local playback");
  click($("#pclose"));
  click($$("[data-local]").find((c) => /My Clip/.test(c.textContent)));
  await until(() => $("[data-ldel]"), "delete button");
  click($("[data-ldel]"));
  await until(() => !/My Clip/.test(text()), "deleted");
});

test("HTML from providers is escaped (no script injection)", async () => {
  go("#/info/test/" + encodeURIComponent(BASE + "/m/1"));
  // inject a hostile title through the cache path by calling the internal renderer with a poisoned post
  win.__vega.S.watchlist.unshift({ kind: "p", provider: "test", link: "x", title: "<img src=x onerror=window.__pwned=1>", image: "javascript:alert(1)" });
  go("#/watchlist");
  await until(() => /img src=x/.test(text()), "escaped title shown as text");
  assert.equal(win.__pwned, undefined);
  assert.ok(!$$("#view img").some((i) => /javascript:/.test(i.getAttribute("src") || "")));
});

/* ---------------- player: direct playback, relay fallback, relay-only streams ---------------- */
async function openMovie() {
  go("#/info/test/" + encodeURIComponent(BASE + "/m/1"));
  await until(() => $("[data-ep-play]"), "movie page");
  click($("[data-ep-play]"));
  return until(() => !$("#player").classList.contains("hidden") && $("#pv"), "player opened");
}
const closeIfOpen = () => { if (!$("#player").classList.contains("hidden")) click($("#pclose")); };
const mediaError = (v, code = 4) => { Object.defineProperty(v, "error", { get: () => ({ code }), configurable: true }); v.dispatchEvent(new win.Event("error")); };

test("player: plays directly first and the <video> has no forced CORS mode", async () => {
  process.env.STREAM_ALLOWED_HOSTS = "media.test";
  const v = await openMovie();
  assert.equal(v.getAttribute("src"), "https://media.test/a.mp4");
  assert.equal(v.hasAttribute("crossorigin"), false, "crossorigin made most hosts fail");
});

test("player: a blocked direct stream retries through the signed relay automatically", async () => {
  const v = $("#pv");
  mediaError(v);
  await until(() => /^http:\/\/localhost\/api\/stream\?t=/.test(v.getAttribute("src") || ""), "switched to relay url");
  assert.match(win.document.querySelector("#pmsg").textContent, /relay/i);
});

test("player: if the relay then fails, the server's real reason is shown", async () => {
  win.__relayReply = () => new Response(JSON.stringify({ proxyError: 'Host "media.test" is not in STREAM_ALLOWED_HOSTS.' }), { status: 403, headers: { "content-type": "application/json" } });
  mediaError($("#pv"));
  await until(() => /not in STREAM_ALLOWED_HOSTS/.test($("#pmsg").textContent), "relay reason shown");
  assert.match($("#pmsg").textContent, /Try next server/);
  win.__relayReply = null; closeIfOpen();
});

test("player: with the relay switched off, the message says exactly what to configure", async () => {
  delete process.env.STREAM_ALLOWED_HOSTS;
  const v = await openMovie();
  mediaError(v);
  await until(() => /STREAM_ALLOWED_HOSTS/.test($("#pmsg").textContent), "setup hint");
  assert.match($("#pmsg").textContent, /blocked direct playback/);
  closeIfOpen();
});

test("player: streams that need headers skip the direct attempt and use the relay (HLS)", async () => {
  process.env.STREAM_ALLOWED_HOSTS = "media.test";
  win.Hls = class { static isSupported() { return true; } loadSource(u) { win.__hlsSource = u; } attachMedia() {} on() {} destroy() {} };
  win.Hls.Events = { MANIFEST_PARSED: "mp", ERROR: "err" }; win.Hls.ErrorTypes = { MEDIA_ERROR: "media" };
  await openMovie();
  click($("#psrv"));
  click($$("#ppop [data-s]")[1]);
  await until(() => win.__hlsSource, "hls source set");
  assert.match(win.__hlsSource, /^http:\/\/localhost\/api\/stream\?t=/);
  assert.ok(!/media\.test\/b\.m3u8/.test(win.__hlsSource));
  closeIfOpen();
});

test("settings: Test connection shows the stream relay status", async () => {
  go("#/settings");
  await until(() => $("#testproxy"), "proxy form");
  const orig = win.fetch;
  win.fetch = async (u, i) => (String(u) === "/api/proxy" && !i?.method ? new Response(JSON.stringify({ ok: true, configured: true, keyRequired: false, keyOk: true, allowedHosts: ["a.test"], streamRelay: "off" })) : orig(u, i));
  click($("#testproxy"));
  await until(() => /Stream relay: off/.test($("#proxystatus").textContent), "relay off notice");
  win.fetch = orig;
});

/* ---------------- failure diagnosis ---------------- */
const bytes = (...a) => new Uint8Array(a);
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
async function failWith(reply, expect, label) {
  process.env.STREAM_ALLOWED_HOSTS = "media.test";
  const v = await openMovie();
  win.__relayReply = reply;
  mediaError(v);                                   // direct attempt fails → relay
  await until(() => /^http:\/\/localhost\/api\/stream\?t=/.test(v.getAttribute("src") || ""), label + ": relay url");
  mediaError(v);                                   // relay playback fails → inspect
  await until(() => expect.test($("#pmsg").textContent), label + ": message — got: " + $("#pmsg").textContent);
  assert.match($("#pmsg").textContent, /Copy link/);
  win.__relayReply = null; closeIfOpen();
}
const reply = (body, ct, status = 206) => () => new Response(body, { status, headers: { "content-type": ct } });

test("diagnosis: MKV, MP4 codec, web page, HTTP error and unknown are each explained", async () => {
  await failWith(reply(bytes(0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4), "video/x-matroska"), /MKV.*external player/, "mkv");
  await failWith(reply(Uint8Array.from([0, 0, 0, 24, ...ascii("ftypisom"), 0, 0, 2, 0]), "video/mp4"), /MP4 whose video or audio codec/, "mp4");
  await failWith(reply("<!doctype html><html>", "text/html", 200), /web page, not a video/, "html");
  await failWith(reply("denied", "text/plain", 403), /answered HTTP 403/, "403");
  await failWith(reply(bytes(9, 9, 9, 9, 9, 9, 9, 9), "application/octet-stream"), /can't decode this stream/, "unknown");
});

test("diagnosis: a link that is really an HLS playlist is re-played as HLS automatically", async () => {
  win.Hls = class { static isSupported() { return true; } loadSource(u) { win.__hlsSource2 = u; } attachMedia() {} on() {} destroy() {} };
  win.Hls.Events = { MANIFEST_PARSED: "mp", ERROR: "err" }; win.Hls.ErrorTypes = { MEDIA_ERROR: "media" };
  win.__hlsSource2 = null;
  process.env.STREAM_ALLOWED_HOSTS = "media.test";
  const v = await openMovie();                       // Alpha: https://media.test/a.mp4 (labelled mp4)
  win.__relayReply = reply("#EXTM3U\n#EXTINF:4,\nseg.ts\n", "text/plain", 200);
  mediaError(v);
  await until(() => /^http:\/\/localhost\/api\/stream\?t=/.test(v.getAttribute("src") || ""), "relay url");
  mediaError(v);
  await until(() => win.__hlsSource2, "re-played via hls.js");
  assert.match(win.__hlsSource2, /^http:\/\/localhost\/api\/stream\?t=/);
  win.__relayReply = null; closeIfOpen();
});
