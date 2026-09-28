// End-to-end: real Chromium with a fake camera, phone + desktop viewports.
const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3100";
const SHOTS = path.join(__dirname, "shots");
const innerWidthOf = (page) => page.viewportSize().width;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("ok  ", name); }
  catch (e) { fail++; console.error("FAIL", name, "\n   ", e.message.split("\n")[0]); }
}

(async () => {
  let server;
  if (!process.env.BASE_URL) {
    server = spawn("node", ["scripts/dev-server.js"], { env: { ...process.env, PORT: "3100" }, stdio: "ignore" });
    for (let i = 0; i < 40; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  }
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "<-loopback>,localhost,127.0.0.1" } : undefined;
  // Fake webcam: a real portrait that slides left and right, so head tracking has a face to follow.
  const FACE = "/tmp/airpane-face-moving.y4m";
  if (!require("node:fs").existsSync(FACE)) {
    const img = "/tmp/airpane-face.jpg";
    require("node:child_process").execSync(`curl -s -o ${img} https://storage.googleapis.com/mediapipe-assets/portrait.jpg && ffmpeg -loglevel error -y -loop 1 -i ${img} -vf "scale=1300:-1,crop=640:480:'330+220*sin(2*PI*t/4)':60,format=yuv420p" -t 8 -r 15 ${FACE}`);
  }
  const browser = await chromium.launch({
    proxy,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${FACE}`, "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader"],
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
      await page.click(".mode-opt:has(input[value=screen])");
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
      // Project the link's real position through the panel's 3D transform the same way
      // the browser renders it, then do a real mouse click at that screen point. If the
      // page navigates, taps land exactly where the user sees the link.
      const frame = page.frames().find((f) => /wikipedia/.test(f.url()));
      const before = frame.url();
      const c = await frame.evaluate(() => {
        const a = document.querySelector('p a[href$="/wiki/Virtual_reality"]');
        a.scrollIntoView({ block: "center" });
        const r = a.getBoundingClientRect();
        return { x: r.left + Math.min(12, r.width / 2), y: r.top + r.height / 2 };
      });
      await page.waitForTimeout(300);
      const pt = await page.evaluate(({ x, y }) => {
        const stage = document.getElementById("stage"), panel = document.querySelector(".panel");
        const cs = getComputedStyle(stage), ps = getComputedStyle(panel);
        const d = parseFloat(cs.perspective);
        const [ox, oy] = cs.perspectiveOrigin.split(" ").map(parseFloat);
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const m = new DOMMatrix()
          .translate(ox, oy).multiply(new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / d, 0, 0, 0, 1])).translate(-ox, -oy)
          .translate(panel.offsetLeft + w / 2, panel.offsetTop + h / 2).multiply(new DOMMatrix(ps.transform)).translate(-w / 2, -h / 2);
        const q = m.transformPoint(new DOMPoint(x, y, 0, 1));
        return { x: q.x / q.w, y: q.y / q.w };
      }, c);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(3000);
      const after = page.frames().find((f) => /wikipedia/.test(f.url())).url();
      assert.notEqual(after, before, `link click at ${pt.x.toFixed(0)},${pt.y.toFixed(0)} did not navigate`);
      assert.match(after, /Virtual_reality/);
    });

    await t(`${label}: blocked site shows the clear Cloud-mode message`, async () => {
      await page.fill("#url-input", "google.com");
      await page.press("#url-input", "Enter");
      await page.waitForFunction(() => /can't open here yet/.test(document.querySelector(".panel-state")?.textContent || ""), null, { timeout: 30000 });
      assert.match(await page.textContent(".panel-state h2"), /google\.com/);
      await page.screenshot({ path: `${SHOTS}/${label}-3-blocked.png` });
    });

    await t(`${label}: quick link on the blocked card recovers`, async () => {
      // force: the floating page never stops moving, so skip the "stable" wait.
      // It is still a real mouse click at the button's on-screen position.
      await page.click(".panel-state .chip >> text=Live map", { force: true });
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
      await t("desktop: opens in Hologram view with a 3D room behind the screen", async () => {
        const st = await page.evaluate(() => window.__airpane.state);
        assert.equal(st.view, "holo");
        assert.equal(await page.locator(".holo-plane").count(), 5);
        assert.match(await page.textContent("#view-btn"), /Hologram/);
        const z = await page.evaluate(() => /translate3d\([^,]+,[^,]+,\s*(-?[\d.]+)px\)/.exec(document.querySelector(".panel").style.transform)[1]);
        assert.ok(Number(z) > 0, "page should float in front of the screen, z=" + z);
      });
      await t("desktop: webcam head tracking finds the face and moves the viewpoint", async () => {
        await page.waitForFunction(() => window.__airpane.state.holo.tracking, null, { timeout: 40000 });
        assert.equal(await page.isVisible("#track"), true);
        const xs = [], boxes = [];
        for (let i = 0; i < 16; i++) {
          xs.push(await page.evaluate(() => window.__airpane.state.holo.eye.x));
          boxes.push((await page.locator(".panel").boundingBox()).x);
          if (i === 4) await page.screenshot({ path: `${SHOTS}/desktop-4-holo-a.png` });
          if (i === 12) await page.screenshot({ path: `${SHOTS}/desktop-4-holo-b.png` });
          await page.waitForTimeout(250);
        }
        const range = Math.max(...xs) - Math.min(...xs);
        assert.ok(range > 150, "eye barely moved: " + range.toFixed(0));
        const backShift = await page.evaluate(() => document.getElementById("stage").style.perspectiveOrigin);
        assert.match(backShift, /px/);
        // The page sits in front of the glass, so it moves the opposite way to the room behind.
        assert.ok(Math.max(...boxes) - Math.min(...boxes) > 3, "page did not respond to head movement");
      });
      await t("desktop: view switch cycles camera room, pyramid, hologram", async () => {
        await page.click("#view-btn");
        await page.waitForFunction(() => document.getElementById("view-btn").textContent === "Camera room");
        assert.equal(await page.locator(".holo-plane").count(), 0);
        await page.waitForTimeout(500);
        const r = await page.locator(".panel").boundingBox();
        assert.ok(r && r.width > 300, "panel missing in room view");
        // Cycle: Camera room -> Pyramid -> Hologram
        await page.click("#view-btn");
        await page.waitForFunction(() => document.getElementById("view-btn").textContent === "Pyramid");
        assert.equal(await page.evaluate(() => document.getElementById("cam").srcObject), null, "camera left on in pyramid");
        if (await page.isVisible("#pyr-help")) await page.click("#pyr-help-ok");
        await page.click("#view-btn");
        await page.waitForFunction(() => document.getElementById("view-btn").textContent === "Hologram");
        await page.waitForTimeout(600);
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
      await p2.click(".mode-opt:has(input[value=screen])");
      await p2.click("#landing .chip >> text=Live map");
      await p2.waitForSelector("#ar.no-cam");
      assert.match(await p2.textContent("#toast"), /Camera is off/);
      await p2.screenshot({ path: `${SHOTS}/${label}-5-no-camera.png` });
      await c2.close();
    });

    await t(`${label}: zero console errors`, async () => assert.deepEqual(errors, []));
    await ctx.close();
  }

  // ---------- Pyramid hologram (phone lying flat, no camera) ----------
  {
    const ctx = await browser.newContext({ ...devices["Pixel 7"], permissions: ["camera"], ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    let camAsked = 0;
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/frame|Refused|ERR_|403|429|503|net::/i.test(m.text())) errors.push(m.text()); });
    await page.exposeFunction("__camAsked", () => camAsked++);
    await page.addInitScript(() => {
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) => { window.__camAsked(); return real(c); };
    });

    await t("pyramid: is the default mode and opens without the camera", async () => {
      await page.goto(BASE, { waitUntil: "load" });
      assert.equal(await page.isChecked("input[value=pyramid]"), true);
      await page.click("#landing .chip >> text=Wikipedia");
      await page.waitForSelector("#ar.pyr");
      assert.equal(camAsked, 0, "camera was requested");
      assert.equal(await page.evaluate(() => document.getElementById("cam").srcObject), null);
      assert.equal(await page.isVisible("#pyr-help"), true, "first-run setup steps not shown");
    });

    await t("pyramid: four copies of the page load, one per face", async () => {
      await page.waitForFunction(() => [...document.querySelectorAll(".pyr-view iframe")].every((f) => /wikipedia/.test(f.src)), null, { timeout: 30000 });
      assert.equal(await page.locator(".pyr-view").count(), 4);
      for (const f of page.frames().filter((f) => /wikipedia/.test(f.url()))) await f.waitForLoadState("load").catch(() => {});
      await page.click("#pyr-help-ok");
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${SHOTS}/pyramid-1-layout.png` });
      assert.equal(page.frames().filter((f) => /wikipedia/.test(f.url())).length, 4);
    });

    await t("pyramid: faces are rotated 0/90/180/270, mirrored for the reflection, and inside the screen", async () => {
      const info = await page.evaluate(() => [...document.querySelectorAll(".pyr-view")].map((v) => ({
        t: v.style.transform, clip: v.style.clipPath, flip: getComputedStyle(v.firstElementChild).transform, r: v.getBoundingClientRect().toJSON(),
      })));
      assert.deepEqual(info.map((i) => i.t), ["rotate(0deg)", "rotate(90deg)", "rotate(180deg)", "rotate(270deg)"]);
      for (const i of info) {
        assert.match(i.clip, /polygon/);
        assert.equal(i.flip, "matrix(1, 0, 0, -1, 0, 0)", "picture must be flipped top-to-bottom");
        assert.ok(i.r.left >= -1 && i.r.top >= -1 && i.r.right <= innerWidthOf(page) + 1, JSON.stringify(i.r));
      }
      // The four slices must not overlap: sample the screen and check each point is covered at most once.
      const overlaps = await page.evaluate(() => {
        const L = window.__airpane.state.pyr.layout; let bad = 0;
        const inside = (px, py, a) => { // point in face a's trapezoid, in screen coords
          const r = (-a * Math.PI) / 180, dx = px - L.cx, dy = py - L.cy;
          const x = dx * Math.cos(r) - dy * Math.sin(r), y = dx * Math.sin(r) + dy * Math.cos(r); // un-rotate
          return y >= L.g && y <= L.g + L.vh && Math.abs(x) <= L.vw / 2 && Math.abs(x) <= y;
        };
        for (let px = 0; px < innerWidth; px += 4) for (let py = 0; py < innerHeight; py += 4) {
          if ([0, 90, 180, 270].filter((a) => inside(px, py, a)).length > 1) bad++;
        }
        return bad;
      });
      assert.equal(overlaps, 0, "slices overlap");
    });

    await t("pyramid: controls fade away on their own and come back on tap", async () => {
      await page.waitForFunction(() => window.__airpane.state.uiHidden === true, null, { timeout: 9000 });
      await page.screenshot({ path: `${SHOTS}/pyramid-2-clean.png` });
      const vp = page.viewportSize();
      await page.mouse.click(vp.width / 2, vp.height / 2);
      await page.waitForFunction(() => window.__airpane.state.uiHidden === false);
      assert.equal(await page.isVisible("#dark-btn"), true);
    });

    await t("pyramid: size buttons change the picture size", async () => {
      const s0 = await page.evaluate(() => window.__airpane.state.pyr.layout.S);
      await page.click("#zoom-out");
      const s1 = await page.evaluate(() => window.__airpane.state.pyr.layout.S);
      assert.ok(s1 < s0 * 0.97, `${s0} -> ${s1}`);
      await page.click("#zoom-in");
    });

    await t("pyramid: Glow toggles the dark filter", async () => {
      assert.match(await page.evaluate(() => document.querySelector(".pyr-view iframe").style.filter), /invert/);
      await page.click("#dark-btn");
      assert.equal(await page.evaluate(() => document.querySelector(".pyr-view iframe").style.filter), "none");
      assert.match(await page.textContent("#dark-btn"), /off/);
      await page.click("#dark-btn");
    });

    await t("pyramid: copies scroll together", async () => {
      const y0 = await page.evaluate(() => window.__airpane.state.pyr.y);
      await page.waitForTimeout(4000);
      const ts = await page.evaluate(() => [...document.querySelectorAll(".pyr-view iframe")].map((f) => f.style.transform));
      assert.ok((await page.evaluate(() => window.__airpane.state.pyr.y)) > y0, "no scroll");
      assert.equal(new Set(ts).size, 1, "copies out of sync");
    });

    await t("pyramid: a site that blocks embedding explains itself", async () => {
      await page.mouse.click(10, 300);
      await page.fill("#url-input", "google.com");
      await page.press("#url-input", "Enter");
      await page.waitForFunction(() => /can't float/.test(document.getElementById("toast").textContent), null, { timeout: 30000 });
      assert.equal(await page.evaluate(() => document.querySelector(".pyr-view iframe").src), "about:blank");
    });

    await t("pyramid: switching view leaves the pyramid and starts the camera", async () => {
      await page.mouse.click(10, 300);
      await page.fill("#url-input", "https://en.m.wikipedia.org/wiki/Hologram");
      await page.press("#url-input", "Enter");
      await page.waitForFunction(() => /Hologram/.test(document.querySelector(".pyr-view iframe").src), null, { timeout: 30000 });
      await page.click("#view-btn");
      await page.waitForFunction(() => window.__airpane.state.view !== "pyramid" && document.getElementById("cam").videoWidth > 0, null, { timeout: 15000 });
      assert.equal(await page.isHidden("#pyr"), true);
      assert.ok(camAsked >= 1);
      await page.waitForFunction(() => document.querySelector(".panel-state")?.hidden === true, null, { timeout: 30000 });
      assert.match(await page.getAttribute(".panel iframe", "src"), /Hologram/);
    });

    await t("pyramid: exit leaves nothing running", async () => {
      await page.click("#exit-btn");
      await page.waitForSelector("#landing:not([hidden])");
      assert.equal(await page.evaluate(() => document.getElementById("cam").srcObject), null);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll(".pyr-view iframe")].every((f) => f.src === "about:blank")), true);
    });

    await t("pyramid: template page renders", async () => {
      await page.goto(BASE + "/pyramid-template.html");
      assert.match(await page.textContent("h1"), /Pyramid template/);
      assert.equal(await page.locator("svg polygon").count(), 2);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, "template overflows on phone: " + over);
    });

    await t("pyramid: zero console errors", async () => assert.deepEqual(errors, []));
    await ctx.close();
  }

  await browser.close();
  if (server) server.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
