// End-to-end: real Chromium with a fake camera, phone + desktop viewports.
const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3100";
const SHOTS = path.join(__dirname, "shots");
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("ok  ", name); }
  catch (e) { fail++; console.error("FAIL", name, "\n   ", e.message.split("\n")[0]); }
}

(async () => {
  let server;
  if (!process.env.BASE_URL) {
    server = spawn("node", ["scripts/dev-server.js"], { env: { ...process.env, PORT: "3100" }, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 800));
  }
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "<-loopback>,localhost,127.0.0.1" } : undefined;
  const browser = await chromium.launch({
    proxy,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });

  for (const [label, ctxOpts] of [
    ["phone", { ...devices["Pixel 7"], permissions: ["camera"] }],
    ["desktop", { viewport: { width: 1440, height: 900 }, permissions: ["camera"] }],
  ]) {
    const ctx = await browser.newContext({ ...ctxOpts, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/frame|Refused|ERR_|403|429|503|net::/i.test(m.text())) errors.push(m.text()); });

    await t(`${label}: landing renders, no horizontal scroll`, async () => {
      await page.goto(BASE, { waitUntil: "load" });
      await page.screenshot({ path: `${SHOTS}/${label}-1-landing.png` });
      assert.match(await page.textContent("h1"), /Open any website/);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, `overflow ${over}px`);
      // every text block and the form keep at least the 16px side gutter
      const bad = await page.evaluate(() => [...document.querySelectorAll(".copy > *, .how .step, .foot")]
        .map((e) => { const r = e.getBoundingClientRect(); return { c: e.className || e.tagName, l: r.left, r: innerWidth - r.right }; })
        .filter((x) => x.l < 15 || x.r < 15));
      assert.deepEqual(bad, []);
    });

    await t(`${label}: launch opens AR view with live camera`, async () => {
      await page.click("#landing .chip >> text=Wikipedia");
      await page.waitForSelector("#ar:not([hidden])");
      await page.waitForFunction(() => document.getElementById("cam").videoWidth > 0, null, { timeout: 8000 });
      assert.equal(await page.isHidden("#landing"), true);
    });

    await t(`${label}: panel is in front of the user and in view`, async () => {
      const r = await page.locator(".panel").boundingBox();
      const vp = page.viewportSize();
      assert.ok(r && r.width > vp.width * 0.5, "panel too small " + JSON.stringify(r));
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      assert.ok(Math.abs(cx - vp.width / 2) < 40 && Math.abs(cy - vp.height / 2) < 60, `panel off-centre ${cx},${cy}`);
      assert.ok(r.x >= -2 && r.x + r.width <= vp.width + 2, "panel wider than view");
    });

    await t(`${label}: Direct mode loads the real site inside the panel`, async () => {
      await page.waitForFunction(() => document.querySelector(".panel-state")?.hidden === true, null, { timeout: 30000 });
      assert.equal((await page.textContent("#mode-chip")).trim(), "Direct");
      const frame = page.frameLocator(".panel iframe");
      await frame.locator("h1, #firstHeading").first().waitFor({ timeout: 30000 });
      assert.match(await frame.locator("h1, #firstHeading").first().textContent(), /Augmented reality/i);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SHOTS}/${label}-2-ar-wikipedia.png` });
    });

    await t(`${label}: page inside the panel is interactive (tap a link)`, async () => {
      const frame = page.frames().find((f) => /wikipedia/.test(f.url()));
      const before = frame.url();
      const link = page.frameLocator(".panel iframe").locator('p a[href$="/wiki/Virtual_reality"]').first();
      await link.click({ timeout: 15000 });
      await page.waitForFunction((b) => [...document.querySelectorAll(".panel iframe")].some(() => true) && b, before);
      await page.waitForTimeout(3000);
      const after = page.frames().find((f) => /wikipedia/.test(f.url())).url();
      assert.notEqual(after, before, "link click did not navigate");
    });

    await t(`${label}: blocked site shows the clear Cloud-mode message`, async () => {
      await page.fill("#url-input", "google.com");
      await page.press("#url-input", "Enter");
      await page.waitForFunction(() => /can't open here yet/.test(document.querySelector(".panel-state")?.textContent || ""), null, { timeout: 30000 });
      assert.match(await page.textContent(".panel-state h2"), /google\.com/);
      await page.screenshot({ path: `${SHOTS}/${label}-3-blocked.png` });
    });

    await t(`${label}: quick link on the blocked card recovers`, async () => {
      await page.click(".panel-state .chip >> text=Live map");
      await page.waitForFunction(() => document.querySelector(".panel-state")?.hidden === true, null, { timeout: 30000 });
      assert.match(await page.getAttribute(".panel iframe", "src"), /openstreetmap/);
    });

    await t(`${label}: plain search goes to Wikipedia search in Direct mode`, async () => {
      await page.fill("#url-input", "augmented reality glasses");
      await page.press("#url-input", "Enter");
      await page.waitForFunction(() => /wikipedia\.org\/w\/index\.php\?search=/.test(document.querySelector(".panel iframe")?.src || ""), null, { timeout: 30000 });
    });

    if (label === "phone") {
      await t("phone: gyro turns the view and the panel stays anchored in the room", async () => {
        const fire = (a, b, g) => page.evaluate(([a, b, g]) => {
          const e = new Event("deviceorientation"); Object.assign(e, { alpha: a, beta: b, gamma: g }); dispatchEvent(e);
        }, [a, b, g]);
        await fire(0, 90, 0); // phone upright, facing forward
        await page.waitForTimeout(300);
        await page.click("#recenter-btn");
        await page.waitForTimeout(300);
        const r0 = await page.locator(".panel").boundingBox();
        assert.ok(await page.evaluate(() => window.__airpane.state.gyro), "gyro not active");
        for (let a = 0; a <= 30; a += 5) { await fire(a, 90, 0); await page.waitForTimeout(40); } // turn left 30 deg
        await page.waitForTimeout(400);
        const r1 = await page.locator(".panel").boundingBox();
        assert.ok(r1.x - r0.x > 100, `panel should move right on screen when phone turns left (dx=${r1.x - r0.x})`);
        await page.screenshot({ path: `${SHOTS}/phone-4-turned.png` });
        await page.click("#recenter-btn");
        await page.waitForTimeout(400);
        const r2 = await page.locator(".panel").boundingBox();
        const vp = page.viewportSize();
        assert.ok(Math.abs(r2.x + r2.width / 2 - vp.width / 2) < 40, "recenter did not bring panel back");
      });
      await t("phone: taps still land correctly when the panel is seen at an angle", async () => {
        const fire = (a) => page.evaluate((a) => { const e = new Event("deviceorientation"); Object.assign(e, { alpha: a, beta: 90, gamma: 0 }); dispatchEvent(e); }, a);
        await page.fill("#url-input", "google.com");
        await page.press("#url-input", "Enter");
        await page.waitForSelector(".panel-state .chip", { timeout: 30000 });
        for (let a = 0; a <= 12; a += 3) { await fire(a); await page.waitForTimeout(40); }
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${SHOTS}/phone-4b-angled.png` });
        await page.click(".panel-state .chip >> text=Live map");
        await page.waitForFunction(() => /openstreetmap/.test(document.querySelector(".panel iframe")?.src || ""), null, { timeout: 30000 });
        await fire(0); await page.waitForTimeout(300); await page.click("#recenter-btn");
      });
    } else {
      await t("desktop: drag background to look around", async () => {
        const r0 = await page.locator(".panel").boundingBox();
        await page.mouse.move(40, 450); await page.mouse.down(); await page.mouse.move(200, 450, { steps: 8 }); await page.mouse.up();
        await page.waitForTimeout(300);
        const r1 = await page.locator(".panel").boundingBox();
        assert.ok(Math.abs(r1.x - r0.x) > 50, "drag did not rotate view");
        await page.click("#recenter-btn");
      });
    }

    await t(`${label}: zoom brings the screen closer`, async () => {
      await page.waitForTimeout(150);
      const s0 = await page.evaluate(() => JSON.stringify(window.__airpane.state));
      const b0 = await page.locator(".panel").boundingBox();
      await page.click("#zoom-in"); await page.waitForTimeout(300);
      const s1 = await page.evaluate(() => JSON.stringify(window.__airpane.state));
      const b1 = await page.locator(".panel").boundingBox();
      assert.ok(b1.width > b0.width * 1.1, `${JSON.stringify(b0)} ${s0} -> ${JSON.stringify(b1)} ${s1}`);
      await page.click("#zoom-out");
    });

    await t(`${label}: exit returns to landing and turns camera off`, async () => {
      await page.click("#exit-btn");
      await page.waitForSelector("#landing:not([hidden])");
      assert.equal(await page.evaluate(() => document.getElementById("cam").srcObject), null);
      assert.equal(await page.isHidden("#ar"), true);
    });

    await t(`${label}: camera denied falls back to virtual room`, async () => {
      const c2 = await browser.newContext({ ...ctxOpts, permissions: [], ignoreHTTPSErrors: true });
      const p2 = await c2.newPage();
      await p2.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError")); });
      await p2.goto(BASE);
      await p2.click("#landing .chip >> text=Live map");
      await p2.waitForSelector("#ar.no-cam");
      assert.match(await p2.textContent("#toast"), /Camera is off/);
      await p2.screenshot({ path: `${SHOTS}/${label}-5-no-camera.png` });
      await c2.close();
    });

    await t(`${label}: zero console errors`, async () => assert.deepEqual(errors, []));
    await ctx.close();
  }

  await browser.close();
  if (server) server.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
