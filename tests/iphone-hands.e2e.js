// iPhone Safari (WebKit) hand tracking, end to end. Playwright's WebKit has no camera, so the
// camera is replaced by a canvas stream that shows real hand photos (pointing down, then an
// open hand). Everything after getUserMedia is the real thing: WebKit's video pipeline,
// MediaPipe in WebKit, the gestures and the floating page.
// This is the case that failed before: MediaPipe's default OffscreenCanvas WebGL does not
// work in Safari, so the hand was never found.
const pw = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3103";
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("ok  ", name); }
  catch (e) { fail++; console.error("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    ")); }
}
const fx = path.join(__dirname, "..", "desktop", "tests", "fixtures");
const b64 = (f) => "data:image/jpeg;base64," + fs.readFileSync(path.join(fx, f)).toString("base64");

(async () => {
  let server;
  if (!process.env.BASE_URL) {
    server = spawn("node", ["scripts/dev-server.js"], { env: { ...process.env, PORT: "3103" }, stdio: "ignore" });
    for (let i = 0; i < 40; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  }
  const b = await pw.webkit.launch();
  const ctx = await b.newContext({ ...pw.devices["iPhone 15"] });
  // the fake camera: a canvas stream of hand photos
  const fakeCam = ({ point, palm }) => {
    const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
    if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    navigator.mediaDevices.getUserMedia = async () => {
      const [pt, pa] = await Promise.all([load(point), load(palm)]);
      const c = document.createElement("canvas"); c.width = 640; c.height = 480;
      const g = c.getContext("2d"), t0 = performance.now();
      const draw = () => {
        const s = (performance.now() - t0) / 1000;
        g.fillStyle = "#c8cdd2"; g.fillRect(0, 0, 640, 480);
        const img = s < 14 ? pt : pa, k = 300 / Math.max(img.width, img.height), w = img.width * k, h = img.height * k;
        g.save(); g.translate(320, 240); if (img === pt) g.rotate(Math.PI); // pointing down
        g.drawImage(img, -w / 2, -h / 2, w, h); g.restore();
        window.__camShown = img === pt ? "point-down" : "open";
      };
      draw(); setInterval(draw, 66);
      return c.captureStream(15);
    };
  };
  const imgs = { point: b64("pointing_up.jpg"), palm: b64("open_palm.jpg") };
  await ctx.addInitScript(fakeCam, imgs);
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));

  await t("iPhone Safari: Floating glass opens and the camera stream plays", async () => {
    await p.goto(BASE + "/", { waitUntil: "load" });
    await p.waitForFunction(() => window.__airpane, null, { timeout: 30000 });
    await p.evaluate(fakeCam, imgs); // again, in case the init script lost a race with the page
    await p.tap("#landing .chip >> text=Wikipedia");
    await p.waitForFunction(() => { const g = window.__airpane.state.glass; return g && !g.loading && g.mode === "page"; }, null, { timeout: 60000 });
    try { await p.waitForFunction(() => document.getElementById("cam").readyState >= 2, null, { timeout: 20000 }); }
    catch { throw new Error("camera video not playing: " + JSON.stringify(await p.evaluate(() => { const v = document.getElementById("cam"); return { rs: v.readyState, src: !!v.srcObject, md: !!navigator.mediaDevices, status: document.getElementById("holo-hand").textContent }; })) + " direct call: " + (await p.evaluate(async () => { try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); return "ok " + s.getVideoTracks().length + " " + String(navigator.mediaDevices.getUserMedia).slice(0, 30); } catch (e) { return "error " + e + " " + String(navigator.mediaDevices.getUserMedia).slice(0, 30); } }))); }
  });

  await t("iPhone Safari: hand tracking loads and reads frames", async () => {
    await p.waitForFunction(() => { const h = window.__airpane.state.hands; return h && (h.error || (h.ready && h.frames > 5)); }, null, { timeout: 120000 });
    const h = await p.evaluate(() => window.__airpane.state.hands);
    assert.equal(h.error, "", "tracking error: " + h.error);
    console.log("      (mode: " + h.delegate + ", frames read: " + h.frames + ")");
  });

  await t("iPhone Safari: the hand is found and pointing down scrolls the page down", async () => {
    await p.waitForFunction(() => window.__airpane.state.hands.hand, null, { timeout: 60000 });
    const y0 = await p.evaluate(() => window.__airpane.state.glass.y);
    await p.waitForFunction((y) => window.__airpane.state.glass.y > y + 200, y0, { timeout: 60000 });
  });

  await t("iPhone Safari: an open hand shows the cursor", async () => {
    await p.waitForFunction(() => window.__camShown === "open", null, { timeout: 30000 });
    await p.waitForFunction(() => !document.querySelector("#glass .g-cursor").hidden, null, { timeout: 30000 });
  });

  await t("iPhone Safari: the camera is shown as a small on-screen mirror (Safari needs it visible) and the guide shows a live readout", async () => {
    const box = await p.locator("#cam").boundingBox();
    assert.ok(box && box.width >= 90 && box.height >= 60, "camera thumbnail too small: " + JSON.stringify(box));
    assert.ok(box.x + box.width <= 393 && box.y >= 0, "thumbnail off screen");
    if (await p.isVisible("#pyr-help-ok")) await p.tap("#pyr-help-ok");
    await p.evaluate(() => document.getElementById("holo-guide").classList.remove("mini"));
    await p.waitForFunction(() => /tracking .* fps/.test(document.getElementById("holo-diag").textContent), null, { timeout: 10000 });
    await p.screenshot({ path: __dirname + "/shots/iphone-glass-tracking.png" });
  });

  await t("Home Screen app: manifest, icon and standalone tags are served", async () => {
    const m = await (await fetch(BASE + "/manifest.webmanifest")).json();
    assert.equal(m.display, "standalone"); assert.equal(m.start_url, "/");
    for (const i of m.icons) assert.equal((await fetch(BASE + i.src)).status, 200, i.src);
    assert.equal((await fetch(BASE + "/icon-180.png")).status, 200);
    assert.equal(await p.evaluate(() => document.querySelector('meta[name="apple-mobile-web-app-capable"]').content), "yes");
  });

  await t("iPhone Safari: no page errors", async () => { assert.deepEqual(errs, []); });
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close(); if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
