// Pinch and throw, device only: a real browser, real MediaPipe hand tracking and a fake webcam
// made from a real hand photo. Pinching grabs the floating page (it becomes a card in the hand),
// swinging and letting go throws it out into the air, where it opens full size again.
const { chromium, devices } = require("playwright");
const MOBILE = process.env.MOBILE === "1";
const assert = require("node:assert/strict");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");

const BASE = process.env.BASE_URL || "http://localhost:3102";
const SHOTS = __dirname + "/shots";
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("ok  ", name); }
  catch (e) { fail++; console.error("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    ")); }
}

(async () => {
  let server;
  if (!process.env.BASE_URL) {
    server = spawn("node", ["scripts/dev-server.js"], { env: { ...process.env, PORT: "3102" }, stdio: "ignore" });
    for (let i = 0; i < 40; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  }
  const VID = "/tmp/airpane-throw.y4m";
  if (!fs.existsSync(VID)) execSync(`python3 tests/make_throw_video.py ${VID}`);
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "<-loopback>,localhost,127.0.0.1" } : undefined;
  const b = await chromium.launch({ proxy, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${VID}`, "--disable-gpu"] });
  const ctx = await b.newContext(MOBILE ? { ...devices["Pixel 7"], permissions: ["camera"], ignoreHTTPSErrors: true } : { viewport: { width: 1280, height: 820 }, permissions: ["camera"], ignoreHTTPSErrors: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/frame|Refused|ERR_|403|429|503|net::|Failed to load resource/i.test(m.text())) errs.push(m.text()); });

  await t("Floating glass opens a page and this device's camera tracks the hand", async () => {
    await p.goto(BASE + "/", { waitUntil: "load" });
    await p.click(".mode-opt:has(input[value=glass])");
    await p.click("#landing .chip >> text=Wikipedia");
    await p.click("#pyr-help-ok");
    await p.waitForFunction(() => { const g = window.__airpane.state.glass; return g && !g.loading && g.mode === "page"; }, null, { timeout: 60000 });
    await p.waitForFunction(() => { const h = window.__airpane.state.hands; return h && h.ready && h.hand; }, null, { timeout: 90000 });
  });

  await t("the guide lists the pinch and throw", async () => {
    assert.match(await p.textContent("#holo-guide"), /Pinch, swing, let go/);
  });

  await t("pointing down keeps scrolling the page down, and never up", async () => {
    let last = await p.evaluate(() => window.__airpane.state.glass.y), moved = 0, upward = 0, line = false;
    const until = Date.now() + 60000;
    while (Date.now() < until && !(moved >= 300 && line)) {
      const st = await p.evaluate(() => ({ y: window.__airpane.state.glass.y, line: !!document.querySelector('#holo-guide li.on[data-g~="point-down"]') }));
      if (st.y > last) moved += st.y - last; else if (st.y < last - 1) upward += last - st.y;
      line ||= st.line; last = st.y;
      await p.waitForTimeout(100);
    }
    assert.ok(moved >= 300, "scrolled only " + Math.round(moved) + "px");
    assert.equal(Math.round(upward), 0, "it scrolled up while pointing down");
    assert.ok(line, "the guide should light up the pointing line");
  });

  let sawHeld = false, sawPinchLine = false;
  await t("pinching grabs the page: it becomes a card held in the hand", async () => {
    const until = Date.now() + 60000;
    while (Date.now() < until && !sawHeld) {
      const st = await p.evaluate(() => ({ air: window.__airpane.state.glass.air, line: !!document.querySelector('#holo-guide li.on[data-g="pinch"]') }));
      sawPinchLine ||= st.line;
      if (st.air === "held") {
        sawHeld = true;
        const tr = await p.evaluate(() => getComputedStyle(document.querySelector(".glass .g-doc")).transform);
        assert.notEqual(tr, "none", "the held page should be shrunk into a card");
        await p.screenshot({ path: `${SHOTS}/throw-1-held.png` });
      }
      await p.waitForTimeout(80);
    }
    assert.ok(sawHeld, "the page was never grabbed; pose: " + (await p.evaluate(() => window.__airpane.state.hands.pose)));
  });

  await t("swinging and letting go throws it out into the air, then it is full size again", async () => {
    // watch from inside the page: the fake webcam loops, so the next grab comes a few seconds later
    await p.evaluate(() => {
      window.__throwLog = [];
      const doc = document.querySelector(".glass .g-doc"), host = document.querySelector(".glass");
      let n = window.__airpane.state.glass.throws;
      setInterval(() => {
        const g = window.__airpane.state.glass;
        if (g.throws > n) {
          n = g.throws;
          const flying = host.classList.contains("thrown");
          setTimeout(() => window.__throwLog.push({ flying, after: getComputedStyle(doc).transform, cls: host.className }), 1100);
        }
      }, 50);
    });
    try { await p.waitForFunction(() => window.__throwLog.length > 0, null, { timeout: 90000 }); }
    catch { throw new Error("no throw; last hand events: " + JSON.stringify(await p.evaluate(() => window.__airpane.state.hands.recent.map((e) => [e.at, e.t, e.y && +e.y.toFixed(2)])))); }
    const r = await p.evaluate(() => window.__throwLog[0]);
    assert.ok(r.flying, "the throw animation did not run");
    assert.ok(!/held|thrown/.test(r.cls) && (r.after === "none" || /^matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -?[\d.]+, 0, 0, 0, 1\)$/.test(r.after)), "page should be back to full size: " + JSON.stringify(r));
  });

  await t("the pinch never clicked, scrolled or went back", async () => {
    const g = await p.evaluate(() => window.__airpane.state.glass);
    assert.equal(g.canBack, false, "a click or back happened: " + g.url);
  });

  await t("no console errors", async () => { assert.deepEqual(errs, []); });
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close(); if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
