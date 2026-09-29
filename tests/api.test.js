// API tests: framing analysis, SSRF guard, live header checks, session endpoint.
const assert = require("node:assert/strict");
const { analyse } = require("../api/check");
const { isPrivateIp, isBlockedForCloud } = require("../api/_lib");
const check = require("../api/check");
const session = require("../api/session");
const { Readable } = require("node:stream");

function call(handler, { method = "GET", url = "/", body } = {}) {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    Object.assign(req, { method, url });
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(s) { resolve({ status: this.statusCode, body: JSON.parse(s), headers: this.headers }); } };
    handler(req, res);
  });
}
const H = (o) => new Headers(o);
let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n", e.message); process.exitCode = 1; } }

(async () => {
  await t("analyse: no headers = frameable", () => assert.equal(analyse(H({})).frameable, true));
  await t("analyse: XFO DENY blocked", () => assert.equal(analyse(H({ "x-frame-options": "DENY" })).frameable, false));
  await t("analyse: XFO SAMEORIGIN blocked", () => assert.equal(analyse(H({ "x-frame-options": "sameorigin" })).frameable, false));
  await t("analyse: CSP frame-ancestors 'self' blocked", () => assert.equal(analyse(H({ "content-security-policy": "default-src *; frame-ancestors 'self'" })).frameable, false));
  await t("analyse: CSP frame-ancestors * allowed", () => assert.equal(analyse(H({ "content-security-policy": "frame-ancestors *" })).frameable, true));
  await t("analyse: CSP without frame-ancestors allowed", () => assert.equal(analyse(H({ "content-security-policy": "default-src 'self'" })).frameable, true));

  await t("private IPs detected", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) assert.equal(isPrivateIp(ip), true, ip);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
  });
  await t("banking/payment blocked for cloud", () => {
    assert.equal(isBlockedForCloud("https://www.paypal.com/x"), true);
    assert.equal(isBlockedForCloud("https://netbanking.hdfcbank.com"), true);
    assert.equal(isBlockedForCloud("https://en.wikipedia.org"), false);
  });

  await t("check: missing url -> 400", async () => assert.equal((await call(check, { url: "/api/check" })).status, 400));
  await t("check: localhost refused (SSRF)", async () => {
    const r = await call(check, { url: "/api/check?url=" + encodeURIComponent("http://127.0.0.1/") });
    assert.equal(r.status, 422); assert.equal(r.body.frameable, false); assert.equal(r.body.unknown, false);
  });
  await t("check: metadata IP refused (SSRF)", async () => assert.equal((await call(check, { url: "/api/check?url=" + encodeURIComponent("http://169.254.169.254/latest") })).status, 422));
  await t("check: ftp refused", async () => assert.equal((await call(check, { url: "/api/check?url=" + encodeURIComponent("ftp://example.com") })).status, 422));
  await t("check: odd port refused", async () => assert.equal((await call(check, { url: "/api/check?url=" + encodeURIComponent("https://example.com:8443/") })).status, 422));

  const live = [
    ["https://en.m.wikipedia.org/wiki/Augmented_reality", true],
    ["https://www.youtube.com/embed/aqz-KE-bpKQ", true],
    ["https://www.google.com", false],
    ["https://news.ycombinator.com", false],
    ["https://www.bing.com", false],
  ];
  for (const [u, want] of live) {
    await t(`check live: ${u} frameable=${want}`, async () => {
      let r;
      for (let i = 0; i < 3; i++) { // sandbox network is slow; retry only on timeouts
        r = await call(check, { url: "/api/check?url=" + encodeURIComponent(u) });
        if (!r.body.unknown) break;
      }
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.frameable, want, r.body.reason);
    });
  }
  await t("check: follows redirects (http -> https)", async () => {
    const r = await call(check, { url: "/api/check?url=" + encodeURIComponent("http://github.com/") });
    assert.equal(r.status, 200); assert.match(r.body.finalUrl, /^https:\/\//);
  });

  delete process.env.HYPERBEAM_API_KEY;
  await t("session GET without key -> enabled:false", async () => assert.deepEqual((await call(session)).body, { enabled: false }));
  await t("session POST without key -> 503", async () => assert.equal((await call(session, { method: "POST", body: { url: "https://google.com" } })).status, 503));
  process.env.HYPERBEAM_API_KEY = "test-key";
  await t("session GET with key -> enabled:true", async () => assert.equal((await call(session)).body.enabled, true));
  await t("session POST bank -> 403", async () => assert.equal((await call(session, { method: "POST", body: { url: "https://www.paypal.com" } })).status, 403));
  await t("session POST bad url -> 400", async () => assert.equal((await call(session, { method: "POST", body: { url: "javascript:alert(1)" } })).status, 400));
  await t("session POST private host -> 400", async () => assert.equal((await call(session, { method: "POST", body: { url: "http://localhost/" } })).status, 400));
  await t("session PUT -> 405", async () => assert.equal((await call(session, { method: "PUT" })).status, 405));
  await t("session POST ok (engine mocked) sends correct request", async () => {
    const real = global.fetch; let sent;
    global.fetch = async (u, o) => { sent = { u, o }; return new Response(JSON.stringify({ session_id: "s1", embed_url: "https://x.hyperbeam.com/e", admin_token: "a1" }), { status: 200 }); };
    try {
      const r = await call(session, { method: "POST", body: { url: "https://www.google.com", w: 420, h: 740 } });
      assert.equal(r.status, 200); assert.equal(r.body.embed_url, "https://x.hyperbeam.com/e");
      assert.equal(sent.u, "https://engine.hyperbeam.com/v0/vm");
      assert.equal(sent.o.headers.Authorization, "Bearer test-key");
      const p = JSON.parse(sent.o.body);
      assert.equal(p.start_url, "https://www.google.com/"); assert.equal(p.width, 420); assert.equal(p.height, 740); assert.equal(p.timeout.absolute, 600);
    } finally { global.fetch = real; }
  });
  await t("session POST engine error -> 502", async () => {
    const real = global.fetch; global.fetch = async () => new Response(JSON.stringify({ message: "bad key" }), { status: 401 });
    try { const r = await call(session, { method: "POST", body: { url: "https://www.google.com" } }); assert.equal(r.status, 502); assert.equal(r.body.error, "bad key"); }
    finally { global.fetch = real; }
  });
  const reader = require("../api/reader");
  await t("reader: missing url -> 400", async () => assert.equal((await call(reader, { url: "/api/reader" })).status, 400));
  await t("reader: private host refused (SSRF)", async () => assert.equal((await call(reader, { url: "/api/reader?url=" + encodeURIComponent("http://127.0.0.1/") })).status, 422));
  await t("reader: an article becomes headings, text and working links", async () => {
    const r = await call(reader, { url: "/api/reader?url=" + encodeURIComponent("https://en.m.wikipedia.org/wiki/Hologram") });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(r.body.blocks.length > 30);
    const links = r.body.blocks.flatMap((b) => b.runs).filter((x) => x.href);
    assert.ok(links.length > 50 && links.every((l) => /^https?:\/\//.test(l.href)));
  });
  await t("reader: a link-list page keeps its links", async () => {
    const r = await call(reader, { url: "/api/reader?url=" + encodeURIComponent("https://news.ycombinator.com") });
    assert.equal(r.status, 200);
    assert.ok(r.body.blocks.flatMap((b) => b.runs).filter((x) => x.href).length > 30);
  });
  const page = require("../api/page");
  const callRaw = (handler, url) => new Promise((resolve) => {
    const req = Readable.from([]); Object.assign(req, { method: "GET", url });
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(s) { resolve({ status: this.statusCode, text: String(s), headers: this.headers }); } };
    handler(req, res);
  });
  await t("page: missing url -> 400", async () => assert.equal((await callRaw(page, "/api/page")).status, 400));
  await t("page: private host refused (SSRF)", async () => assert.equal((await callRaw(page, "/api/page?url=" + encodeURIComponent("http://169.254.169.254/"))).status, 422));
  await t("page: the real page keeps its own styles, with every script and handler removed", async () => {
    const r = await callRaw(page, "/api/page?url=" + encodeURIComponent("https://anchit-tandon.com"));
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.match(r.headers["content-type"], /text\/html/);
    assert.match(decodeURIComponent(r.headers["x-final-url"]), /^https:\/\/anchit-tandon\.com/);
    assert.match(r.text, /<base href="https:\/\/anchit-tandon\.com/);
    assert.match(r.text, /<link[^>]+stylesheet|<style/i);
    assert.doesNotMatch(r.text, /<script/i);
    assert.doesNotMatch(r.text, /\son(click|load|error|mouseover)\s*=/i);
    assert.doesNotMatch(r.text, /href\s*=\s*["']\s*javascript:/i);
  });
  delete process.env.HYPERBEAM_API_KEY;
  console.log(`\n${pass} API tests passed${process.exitCode ? " (with failures)" : ""}`);
})();
