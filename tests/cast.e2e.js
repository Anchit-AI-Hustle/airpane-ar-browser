// Throw to another screen, end to end in real Chromium: a TV opens /catch, a phone scans its
// QR code, opens a page, presses and holds it, flicks it, and the page lands on the TV. The
// phone then scrolls the TV and pulls the page back. The Chromecast path (Presentation API)
// runs with a stand-in for the Cast device, since a test machine has none.
const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const BASE = process.env.BASE_URL || "http://localhost:3104";
const SHOTS = __dirname + "/shots";
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("ok  ", name); }
  catch (e) { fail++; console.error("FAIL", name, "\n   ", e.message.split("\n").slice(0, 8).join("\n    ")); }
}
// Floating glass fades its controls after a few seconds; a tap anywhere brings them back.
// (Focus inside the controls keeps them up while a slow test machine gets to the click.)
const wake = (p, sel = "#cast-btn") => p.evaluate((sel) => { document.getElementById("ar").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); document.querySelector(sel).focus(); }, sel);
// a point on the page that no overlay (gesture guide, camera mirror, bars) covers
const clearPoint = (p) => p.evaluate(() => {
  for (let y = 0.35; y < 0.8; y += 0.05) for (const x of [0.5, 0.35, 0.65]) {
    const px = innerWidth * x, py = innerHeight * y;
    if (document.elementFromPoint(px, py)?.classList.contains("g-touch")) return { x: px, y: py };
  }
  return null;
});
const watch = (p) => {
  p.__errors = [];
  p.on("pageerror", (e) => p.__errors.push("pageerror: " + e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/frame|Refused|ERR_|403|429|503|net::|Failed to load resource/i.test(m.text())) p.__errors.push(m.text()); });
  return p;
};

(async () => {
  let server;
  if (!process.env.BASE_URL) {
    server = spawn("node", ["scripts/dev-server.js"], { env: { ...process.env, PORT: "3104" }, stdio: "ignore" });
    for (let i = 0; i < 40; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  }
  const { PeerServer } = require("peer");
  const peerSrv = await new Promise((ok) => { const srv = PeerServer({ port: 9124, host: "127.0.0.1", path: "/" }, () => ok(srv)); });
  const PQ = "peer=127.0.0.1:9124";
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "<-loopback>,localhost,127.0.0.1" } : undefined;
  const browser = await chromium.launch({ proxy, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });

  // ---------- the screen page fits every size ----------
  for (const [w, h] of [[390, 844], [820, 1180], [1440, 900]]) {
    await t(`screen page at ${w}px: fits, shows a code and a QR code`, async () => {
      const c = await browser.newContext({ viewport: { width: w, height: h }, ignoreHTTPSErrors: true });
      const p = watch(await c.newPage());
      await p.goto(`${BASE}/catch/?${PQ}`, { waitUntil: "load" });
      await p.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById("code").textContent), null, { timeout: 20000 });
      await p.waitForSelector("#qr svg");
      const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, "sideways overflow " + over);
      await p.screenshot({ path: `${SHOTS}/cast-screen-${w}.png` });
      assert.deepEqual(p.__errors, []);
      await c.close();
    });
  }

  // ---------- phone + TV over the direct link ----------
  const tvCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const tv = watch(await tvCtx.newPage());
  tv.setDefaultTimeout(30000);
  const phCtx = await browser.newContext({ ...devices["Pixel 7"], permissions: ["camera"], ignoreHTTPSErrors: true });
  const ph = watch(await phCtx.newPage());
  ph.setDefaultTimeout(30000);
  let code = "";

  await t("TV: /catch waits under a code; its QR code opens Airpane on the phone with that code", async () => {
    await tv.goto(`${BASE}/catch/?${PQ}`, { waitUntil: "load" });
    await tv.waitForFunction(() => window.__catch.state.ready && window.__catch.state.code, null, { timeout: 20000 });
    code = await tv.evaluate(() => window.__catch.state.code);
    const qr = await tv.getAttribute("#qr", "data-url");
    assert.equal(new URL(qr).searchParams.get("cast"), code);
  });

  await t("TV: the code stays the same after a reload", async () => {
    await tv.reload({ waitUntil: "load" });
    await tv.waitForFunction(() => window.__catch.state.ready, null, { timeout: 20000 });
    assert.equal(await tv.evaluate(() => window.__catch.state.code), code);
  });

  await t("phone: scanning the QR code connects to the TV", async () => {
    await ph.goto(await tv.getAttribute("#qr", "data-url"), { waitUntil: "load" });
    await ph.waitForFunction(() => /Connected to .+ Open a site/.test(document.getElementById("cast-banner").textContent), null, { timeout: 20000 });
    assert.equal(await ph.isVisible("#cast-banner button"), true, "the banner can disconnect from a screen that isn't yours");
    await tv.waitForFunction(() => window.__catch.state.senders === 1, null, { timeout: 15000 });
    assert.match(await tv.textContent("#wait-status"), /phone is connected/);
    assert.equal(new URL(ph.url()).searchParams.has("cast"), false, "the code is taken out of the address");
    await ph.screenshot({ path: `${SHOTS}/cast-phone-landing.png` });
  });

  await t("phone: opens a page on the Floating glass (read straight off the screen)", async () => {
    await ph.click(".mode-opt:has(input[value=glass])");
    await ph.fill("#launch-input", "https://en.m.wikipedia.org/wiki/Augmented_reality");
    await ph.press("#launch-input", "Enter");
    await ph.click("#help-noflip");
    await ph.waitForFunction(() => { const g = window.__airpane.state.glass; return g && !g.loading && /Augmented_reality/.test(g.url) && g.max > 500; }, null, { timeout: 60000 });
    assert.ok(await ph.evaluate(() => document.getElementById("cast-btn").classList.contains("on")), "the Cast button shows it is connected");
    // hand tracking loads in the background; let it settle so the press is timed fairly
    await ph.waitForFunction(() => { const h = window.__airpane.state.hands; return h && (h.ready || h.error); }, null, { timeout: 90000 });
  });

  await t("phone: press, hold and flick the page: it flies off the phone and lands on the TV", async () => {
    // a little way down the page first: the TV opens it at the same place
    await ph.evaluate(() => { const g = document.querySelector("#glass"); g.dispatchEvent(new PointerEvent("pointerdown", { clientX: 195, clientY: 500, isPrimary: true, pointerId: 9, bubbles: true })); g.dispatchEvent(new PointerEvent("pointermove", { clientX: 195, clientY: 300, isPrimary: true, pointerId: 9, bubbles: true })); g.dispatchEvent(new PointerEvent("pointerup", { clientX: 195, clientY: 300, isPrimary: true, pointerId: 9, bubbles: true })); });
    const y0 = await ph.evaluate(() => window.__airpane.state.glass.pos);
    assert.ok(y0 > 0, "the drag should have scrolled the phone's page");
    const { x, y } = await clearPoint(ph);
    await ph.mouse.move(x, y);
    await ph.mouse.down();
    await ph.waitForFunction(() => window.__airpane.state.glass.air === "held", null, { timeout: 8000 }).catch(async () => { throw new Error("not held at " + JSON.stringify({ x, y }) + " " + JSON.stringify(await ph.evaluate(([x, y]) => [document.elementsFromPoint(x, y).slice(0, 3).map((e) => e.id || e.className), window.__airpane.state.glass.air, window.__airpane.state.view], [x, y]))); });
    await ph.screenshot({ path: `${SHOTS}/cast-phone-held.png` });
    for (let i = 1; i <= 6; i++) await ph.mouse.move(x, Math.max(5, y - i * 50));
    await ph.mouse.up();
    await ph.waitForFunction(() => window.__airpane.state.glass.air === "sent", null, { timeout: 8000 });
    await ph.screenshot({ path: `${SHOTS}/cast-phone-sent.png` });
    await tv.waitForFunction(() => window.__catch.state.caught === 1, null, { timeout: 10000 });
    await tv.waitForTimeout(300);
    await tv.screenshot({ path: `${SHOTS}/cast-tv-landing.png` });
    await tv.waitForFunction(() => { const g = window.__catch.state.glass; return !g.loading && g.mode === "page" && /Augmented_reality/.test(g.url); }, null, { timeout: 60000 });
    await tv.waitForFunction((p) => Math.abs(window.__catch.state.glass.pos - p) < 0.05 && window.__catch.state.glass.y > 0, y0, { timeout: 10000 }).catch(async () => { throw new Error("TV not at the same place: phone " + y0 + " TV " + JSON.stringify(await tv.evaluate(() => window.__catch.state.glass))); });
    assert.match(await tv.textContent("#badge"), /Caught from Android phone/);
    const st = await ph.evaluate(() => window.__airpane.state);
    assert.equal(st.remote, true); assert.equal(st.glass.sent, 1); assert.equal(st.glass.canBack, false, "the long press must not click a link");
    assert.equal(await ph.isVisible("#cast-bar"), true);
    await ph.waitForFunction(() => /Augmented reality/i.test(document.getElementById("cast-bar-title").textContent), null, { timeout: 30000 });
    await ph.waitForTimeout(1100);
    assert.equal(await ph.evaluate(() => window.__airpane.state.glass.air), "", "the page is back on the phone after the flight");
    await tv.screenshot({ path: `${SHOTS}/cast-tv-page.png` });
    await ph.screenshot({ path: `${SHOTS}/cast-phone-remote.png` });
  });

  await t("phone: the bar and the hand scroll the page on the TV, not on the phone", async () => {
    const tvY = await tv.evaluate(() => window.__catch.state.glass.y), phY = await ph.evaluate(() => window.__airpane.state.glass.y);
    await wake(ph, "#cast-down");
    // the remote bar, the gesture guide and the dock don't cover each other
    const hit = await ph.evaluate(() => {
      const r = (id) => document.querySelector(id).getBoundingClientRect(), a = r("#cast-bar");
      return ["#holo-guide", ".dock"].filter((id) => { const b = r(id); return b.width && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; });
    });
    assert.deepEqual(hit, [], "the remote bar overlaps");
    await ph.screenshot({ path: `${SHOTS}/cast-phone-remote-bar.png` });
    await ph.click("#cast-down");
    await tv.waitForFunction((y) => window.__catch.state.glass.y > y + 100, tvY, { timeout: 10000 });
    const tvY2 = await tv.evaluate(() => window.__catch.state.glass.y);
    await ph.evaluate(() => window.__airpane.handEvent({ t: "scroll", dy: 0.4 }));
    await tv.waitForFunction((y) => window.__catch.state.glass.y > y + 100, tvY2, { timeout: 10000 });
    assert.equal(await ph.evaluate(() => window.__airpane.state.glass.y), phY, "the phone's own page stays put");
    // the hand's cursor shows on the TV
    await ph.evaluate(() => window.__airpane.handEvent({ t: "cur", x: 0.4, y: 0.4 }));
    await tv.waitForFunction(() => !document.querySelector("#glass .g-cursor").hidden, null, { timeout: 5000 });
  });

  await t("phone: Bring back pulls the page back to the phone at the TV's place", async () => {
    const pos = await tv.evaluate(() => window.__catch.state.glass.pos);
    await wake(ph, "#cast-recall");
    await ph.click("#cast-recall");
    await ph.waitForFunction(() => !window.__airpane.state.remote, null, { timeout: 10000 });
    await ph.waitForFunction((p) => { const g = window.__airpane.state.glass; return !g.loading && Math.abs(g.pos - p) < 0.05; }, pos, { timeout: 60000 });
    assert.equal(await ph.isVisible("#cast-bar"), false);
  });

  await t("phone: a pinch-and-swing from the hand also throws to the TV", async () => {
    await ph.evaluate(() => { const a = window.__airpane; a.handEvent({ t: "grab", x: 0.5, y: 0.6 }); a.handEvent({ t: "hold", x: 0.5, y: 0.4 }); a.handEvent({ t: "throw", x: 0.5, y: 0.3, vx: 0.2, vy: -2.5 }); });
    await tv.waitForFunction(() => window.__catch.state.caught === 2, null, { timeout: 10000 });
    assert.equal(await ph.evaluate(() => window.__airpane.state.glass.sent), 2);
  });

  await t("phone: Send this page now (no gesture needed) and the sheet at 390px", async () => {
    await ph.waitForTimeout(500);
    await wake(ph);
    await ph.click("#cast-btn");
    await ph.waitForSelector("#cast-sheet:not([hidden]) #cast-on:not([hidden])");
    assert.match(await ph.textContent("#cast-name"), /Computer|Mac|PC/);
    const over = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(over <= 0);
    await ph.screenshot({ path: `${SHOTS}/cast-phone-sheet.png` });
    await ph.click("#cast-send");
    await tv.waitForFunction(() => window.__catch.state.caught === 3, null, { timeout: 10000 });
  });

  await t("TV: a YouTube page plays in the real player; bad messages are ignored", async () => {
    await tv.waitForTimeout(500);
    await tv.evaluate(() => { window.__catch.message({ t: "cast", url: "javascript:alert(1)" }); window.__catch.message({ t: "eval" }); window.__catch.message("{not json"); });
    assert.equal(await tv.evaluate(() => window.__catch.state.caught), 3);
    await tv.evaluate(() => window.__catch.message({ t: "cast", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", from: "iPhone" }));
    await tv.waitForFunction(() => /youtube\.com\/embed\/aqz-KE-bpKQ\?autoplay=1&mute=1/.test(window.__catch.state.video), null, { timeout: 5000 });
    assert.equal(await tv.isVisible("#glass"), false);
    // the phone's bar turns into a Sound on button for the video
    await ph.waitForFunction(() => document.getElementById("cast-bar").classList.contains("video"), null, { timeout: 5000 });
    await wake(ph, "#cast-sound");
    assert.equal(await ph.isVisible("#cast-sound"), true); assert.equal(await ph.isVisible("#cast-down"), false);
    await ph.click("#cast-sound");
    await tv.waitForFunction(() => /Sound on/.test(document.getElementById("badge").textContent), null, { timeout: 5000 });
  });

  await t("phone: Disconnect; the next throw goes into the air on the phone", async () => {
    await wake(ph);
    await ph.click("#cast-btn");
    await ph.click("#cast-stop");
    await ph.waitForFunction(() => !window.__airpane.state.cast.connected);
    await tv.waitForFunction(() => window.__catch.state.senders === 0, null, { timeout: 15000 });
    await ph.evaluate(() => { const a = window.__airpane; a.handEvent({ t: "grab", x: 0.5, y: 0.6 }); a.handEvent({ t: "throw", x: 0.5, y: 0.3, vx: 0, vy: -2.5 }); });
    const g = await ph.evaluate(() => window.__airpane.state.glass);
    assert.equal(g.throws, 1, "thrown into the air on the phone"); assert.equal(g.sent, 3, "not sent anywhere");
    assert.equal(await tv.evaluate(() => window.__catch.state.caught), 4, "the TV got nothing new");
  });

  await t("screen: messages from a device that was never let in are ignored", async () => {
    const n = await tv.evaluate(() => window.__catch.state.caught);
    await tv.waitForTimeout(500);
    await tv.evaluate(() => window.__catch.stranger({ t: "cast", url: "https://example.com/" }));
    await tv.waitForTimeout(300);
    assert.equal(await tv.evaluate(() => window.__catch.state.caught), n);
  });

  await t("screen: while a page shows, the code and QR code stay in the corner", async () => {
    assert.equal(await tv.isVisible("#chip"), true);
    assert.equal(await tv.textContent("#chip-code"), code);
    assert.equal(await tv.locator("#chip-qr svg").count(), 1);
  });

  await t("phone: a wrong code says so", async () => {
    await ph.waitForTimeout(1200);
    await wake(ph);
    await ph.click("#cast-btn");
    await ph.fill("#cast-code", code === "ZZZZ" ? "YYYY" : "ZZZZ");
    await ph.click("#cast-go");
    await ph.waitForSelector("#cast-err:not([hidden])", { timeout: 30000 });
    assert.match(await ph.textContent("#cast-err"), /No screen with that code/);
    await ph.click("#cast-close");
  });

  await t("phone: typing the code (no QR secret) needs Allow on the screen before anything lands", async () => {
    await ph.waitForTimeout(600);
    await wake(ph);
    await ph.click("#cast-btn");
    await ph.fill("#cast-code", code);
    await ph.click("#cast-go");
    await tv.waitForSelector("#allow:not([hidden])", { timeout: 20000 });
    assert.match(await tv.textContent("#allow-who"), /Android phone/);
    await ph.waitForSelector("#cast-wait:not([hidden])");
    assert.equal(await ph.isVisible("#cast-send"), false, "no sending before the screen allows it");
    await tv.screenshot({ path: `${SHOTS}/cast-tv-allow.png` });
    const n = await tv.evaluate(() => window.__catch.state.caught);
    await ph.click("#cast-close");
    await ph.evaluate(() => { const a = window.__airpane; a.handEvent({ t: "grab", x: 0.5, y: 0.6 }); a.handEvent({ t: "throw", x: 0.5, y: 0.3, vx: 0, vy: -2.5 }); });
    await ph.waitForTimeout(800);
    assert.equal(await tv.evaluate(() => window.__catch.state.caught), n, "nothing lands before Allow");
    await tv.keyboard.press("Enter"); // a TV remote's OK: Allow has the focus
    await tv.waitForSelector("#allow", { state: "hidden" });
    await ph.waitForFunction(() => window.__airpane.state.cast.allowed, null, { timeout: 10000 });
    await ph.evaluate(() => { const a = window.__airpane; a.handEvent({ t: "grab", x: 0.5, y: 0.6 }); a.handEvent({ t: "throw", x: 0.5, y: 0.3, vx: 0, vy: -2.5 }); });
    await tv.waitForFunction((n) => window.__catch.state.caught === n + 1, n, { timeout: 10000 });
  });

  await t("phone + TV: zero console errors", async () => { assert.deepEqual(ph.__errors, []); assert.deepEqual(tv.__errors, []); });
  await phCtx.close(); await tvCtx.close();

  // ---------- Chromecast / second display (Presentation API), with a stand-in Cast device ----------
  await t("laptop: Cast to a Chromecast shows the browser's picker path and the page lands on the cast screen", async () => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["camera"], ignoreHTTPSErrors: true });
    // The stand-in: the sender's PresentationRequest and the receiver's connection list talk
    // over a BroadcastChannel, the way Chrome joins them when it casts a tab.
    await c.addInitScript(() => {
      const bc = new BroadcastChannel("airpane-present-test");
      if (location.pathname.startsWith("/catch")) {
        if (!location.search.includes("via=present")) return;
        class Conn extends EventTarget { constructor() { super(); this.state = "connected"; } send(d) { bc.postMessage({ to: "tx", d }); } }
        const conn = new Conn();
        bc.onmessage = (e) => { if (e.data.to === "rx") conn.dispatchEvent(new MessageEvent("message", { data: e.data.d })); };
        Object.defineProperty(navigator, "presentation", { value: { receiver: { connectionList: Promise.resolve(Object.assign(new EventTarget(), { connections: [conn] })) } } });
        return;
      }
      window.__presentUrls = null;
      window.PresentationRequest = class {
        constructor(urls) { window.__presentUrls = urls; }
        getAvailability() { return Promise.resolve({ value: true, onchange: null }); }
        start() {
          const conn = { state: "connected", onmessage: null, send(d) { bc.postMessage({ to: "rx", d }); }, terminate() { this.state = "terminated"; } };
          bc.onmessage = (e) => { if (e.data.to === "tx" && conn.onmessage) conn.onmessage({ data: e.data.d }); };
          return Promise.resolve(conn);
        }
      };
    });
    const rx = watch(await c.newPage());
    await rx.goto(`${BASE}/catch/?via=present&${PQ}`, { waitUntil: "load" });
    await rx.waitForFunction(() => window.__catch.state.present && window.__catch.state.ready);
    assert.equal(await rx.isVisible("#qr"), false, "no code or QR when cast from the browser");
    const lap = watch(await c.newPage());
    await lap.goto(`${BASE}/?${PQ}`, { waitUntil: "load" });
    await lap.click(".mode-opt:has(input[value=glass])");
    await lap.fill("#launch-input", "example.com");
    await lap.press("#launch-input", "Enter");
    await lap.click("#pyr-help-ok");
    await lap.waitForFunction(() => { const g = window.__airpane.state.glass; return g && !g.loading && /example\.com/.test(g.url); }, null, { timeout: 40000 });
    await lap.click("#cast-btn");
    await lap.waitForSelector("#cast-present:not([hidden])");
    assert.match(await lap.evaluate(() => window.__presentUrls[0]), /\/catch\/\?via=present/);
    await lap.screenshot({ path: `${SHOTS}/cast-laptop-sheet.png` });
    await lap.click("#cast-present");
    await lap.waitForSelector("#cast-on:not([hidden])");
    await lap.click("#cast-send");
    await rx.waitForFunction(() => { const s = window.__catch.state; return s.caught === 1 && !s.glass.loading && /example\.com/.test(s.glass.url); }, null, { timeout: 40000 });
    await rx.screenshot({ path: `${SHOTS}/cast-present-screen.png` });
    assert.match(await lap.textContent("#cast-bar-title"), /Example Domain/);
    assert.deepEqual(lap.__errors, []); assert.deepEqual(rx.__errors, []);
    await c.close();
  });

  await browser.close();
  try { peerSrv.close && peerSrv.close(); peerSrv._server && peerSrv._server.close(); } catch {}
  if (server) server.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
