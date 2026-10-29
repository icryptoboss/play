import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import proxy from "../server/proxy.mjs";

let upstream, up;

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/redirect-1") {
      res.writeHead(302, {
        "location": "/redirect-2",
        "set-cookie": "session_id=12345; Path=/; HttpOnly"
      });
      res.end();
      return;
    }
    if (url.pathname === "/redirect-2") {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "user_pref=dark; Path=/"
      });
      res.end(JSON.stringify({
        receivedCookie: req.headers["cookie"],
        receivedUserAgent: req.headers["user-agent"]
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ua: req.headers["user-agent"] }));
  });

  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  up = `http://127.0.0.1:${upstream.address().port}`;
  process.env.PROXY_ALLOWED_HOSTS = "127.0.0.1";
  process.env.PROXY_ALLOW_PRIVATE = "1";
  delete process.env.PROXY_ACCESS_KEY;
});

after(() => {
  upstream.close();
});

test("proxy intercept modflix.json returns complete provider mappings", async () => {
  const req = new Request("http://localhost/api/proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://himanshu8443.github.io/providers/modflix.json" })
  });
  const res = await proxy(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 200);
  const body = JSON.parse(data.body);
  assert.ok(body.consumet?.url, "consumet url should exist");
  assert.ok(body.Vega?.url, "Vega url should exist");
  assert.ok(body.drive?.url, "drive url should exist");
  assert.equal(body.consumet.url, "https://consumet.org");
});

test("proxy forwards cookies across redirects and accumulates cookieUpdates", async () => {
  const req = new Request("http://localhost/api/proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${up}/redirect-1` })
  });
  const res = await proxy(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 200);

  // cookieUpdates should have recorded hop 1 and hop 2
  assert.ok(Array.isArray(data.cookieUpdates), "cookieUpdates should be an array");
  assert.equal(data.cookieUpdates.length, 2);
  assert.match(data.cookieUpdates[0].headers[0], /session_id=12345/);
  assert.match(data.cookieUpdates[1].headers[0], /user_pref=dark/);

  // Upstream hop 2 should have received hop 1's cookie and default UA
  const body = JSON.parse(data.body);
  assert.match(body.receivedCookie, /session_id=12345/);
  assert.match(body.receivedUserAgent, /Chrome\/131/);
});
