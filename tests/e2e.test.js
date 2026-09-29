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
  catch (e) { fail++; console.error("FAIL", name, "\n   ", e.message.split("\n").slice(0, 8).join("\n    ")); }
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
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
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
      let after = page.frames().find((f) => /wikipedia/.test(f.url())).url();
      // With head tracking the panel keeps moving a little between measuring and clicking; re-measure and retry.
      for (let i = 0; i < 2 && after === before; i++) {
        const p2 = await page.evaluate(({ x, y }) => {
          const stage = document.getElementById("stage"), panel = document.querySelector(".panel");
          const cs = getComputedStyle(stage), ps = getComputedStyle(panel);
          const d = parseFloat(cs.perspective); const [ox, oy] = cs.perspectiveOrigin.split(" ").map(parseFloat);
          const w = panel.offsetWidth, h = panel.offsetHeight;
          const m = new DOMMatrix().translate(ox, oy).multiply(new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / d, 0, 0, 0, 1])).translate(-ox, -oy)
            .translate(panel.offsetLeft + w / 2, panel.offsetTop + h / 2).multiply(new DOMMatrix(ps.transform)).translate(-w / 2, -h / 2);
          const q = m.transformPoint(new DOMPoint(x, y, 0, 1)); return { x: q.x / q.w, y: q.y / q.w };
        }, c);
        await page.mouse.click(p2.x, p2.y);
        await page.waitForTimeout(3000);
        after = page.frames().find((f) => /wikipedia/.test(f.url())).url();
      }
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
      await t("desktop: view switch cycles camera room, glass, pyramid, hologram", async () => {
        await page.click("#view-btn");
        await page.waitForFunction(() => document.getElementById("view-btn").textContent === "Camera room");
        assert.equal(await page.locator(".holo-plane").count(), 0);
        await page.waitForTimeout(500);
        const r = await page.locator(".panel").boundingBox();
        assert.ok(r && r.width > 300, "panel missing in room view");
        // Cycle: Camera room -> Floating glass -> Pyramid -> Hologram
        await page.click("#view-btn");
        await page.waitForFunction(() => document.getElementById("view-btn").textContent === "Floating glass");
        assert.equal(await page.evaluate(() => document.getElementById("cam").srcObject), null, "camera left on in glass");
        if (await page.isVisible("#pyr-help")) await page.click("#pyr-help-ok");
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

    await t("pyramid: opens without the camera", async () => {
      await page.goto(BASE, { waitUntil: "load" });
      await page.click(".mode-opt:has(input[value=pyramid])");
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

    await t("pyramid: zero console errors", async () => assert.deepEqual(errors, [], JSON.stringify(errors)));
    await ctx.close();
  }


  // ---------- Floating glass + laptop controller (hand tracking over a direct link) ----------
  {
    // Local PeerJS broker: the sandbox proxy blocks WebSocket upgrades to the public one.
    const { PeerServer } = require("peer");
    const peerSrv = await new Promise((ok) => { const srv = PeerServer({ port: 9123, host: "127.0.0.1", path: "/" }, () => ok(srv)); });
    const PQ = "?peer=127.0.0.1:9123";
    const HAND = "/tmp/airpane-open-hand.y4m"; // a still open hand: it drives the cursor
    if (!require("node:fs").existsSync(HAND)) {
      require("node:child_process").execSync(`ffmpeg -loglevel error -y -loop 1 -i ${require("node:path").join(__dirname, "../desktop/tests/fixtures/open_palm.jpg")} -vf "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -t 6 -r 15 ${HAND}`);
    }
    const ctlBrowser = await chromium.launch({
      proxy,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${HAND}`, "--enable-unsafe-swiftshader"],
    });
    const dctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: false, ignoreHTTPSErrors: true });
    const disp = await dctx.newPage();
    const cctx = await ctlBrowser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["camera"], ignoreHTTPSErrors: true });
    const ctl = await cctx.newPage();
    for (const [pg, list] of [[disp, []], [ctl, []]]) {
      pg.__errors = list;
      pg.on("pageerror", (e) => list.push("pageerror: " + e.message));
      pg.on("console", (m) => { if (m.type() === "error" && !/frame|Refused|ERR_|403|429|503|net::|Failed to load resource/i.test(m.text())) list.push(m.text()); });
    }
    disp.setDefaultTimeout(30000); ctl.setDefaultTimeout(30000);
    const G = () => disp.evaluate(() => window.__airpane.state.glass);
    // centre of the first visible link, as a 0..1 point on the page the viewer sees
    // A link on the floating page, as a 0..1 point of the page the viewer sees, plus where it
    // is on the display's own screen (the page is flipped top-to-bottom for the sheet).
    const linkPoint = () => disp.evaluate(() => {
      const here = window.__airpane.state.glass.url.split("#")[0];
      const L = window.__airpane.glassLinks(80).find((l) => l.y > 0.1 && l.y < 0.9 && /^https?:/.test(l.href) && new URL(l.href).pathname !== new URL(here).pathname && l.text.length > 1);
      if (!L) return null;
      const d = document.querySelector(".g-doc").getBoundingClientRect(), flip = window.__airpane.state.glass.flip;
      return { ...L, sx: d.left + L.x * d.width, sy: flip ? d.bottom - L.y * d.height : d.top + L.y * d.height };
    });
    // The real page inside the floating glass
    const pageText = (pg, sel) => pg.evaluate((sel) => { const d = document.querySelector(sel)?.contentDocument; return d && d.body ? d.body.innerText : ""; }, sel);
    const hovered = (pg, sel) => pg.evaluate((sel) => document.querySelector(sel)?.contentDocument?.querySelector("a.airpane-hover")?.textContent || "", sel);

    await t("glass: is the default, opens without the camera and shows a pairing code", async () => {
      await disp.goto(BASE + "/" + PQ, { waitUntil: "load" });
      // on a laptop the page starts as the hand controller; this screen is the floating display
      assert.equal(await disp.isChecked("input[value=control]"), true, "a laptop should start as the hand controller");
      await disp.click(".mode-opt:has(input[value=glass])");
      await disp.click("#landing .chip >> text=Wikipedia");
      await disp.waitForSelector("#ar.glassv");
      assert.equal(await disp.evaluate(() => document.getElementById("cam").srcObject), null);
      await disp.click("#pyr-help-ok");
      await disp.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById("glass-code").textContent), null, { timeout: 30000 });
    });

    await t("glass: the real page is shown with its own colours and layout, flipped for the reflection", async () => {
      await disp.waitForFunction(() => { const g = window.__airpane.state.glass; return g.mode === "page" && !g.loading && /Augmented reality/i.test(g.title); }, null, { timeout: 30000 });
      assert.match(await pageText(disp, "#glass .g-page"), /Augmented reality/i);
      assert.equal(await disp.evaluate(() => getComputedStyle(document.querySelector(".g-flip")).transform), "matrix(1, 0, 0, -1, 0, 0)");
      const st = await disp.evaluate(() => { const d = document.querySelector("#glass .g-page").contentDocument; return { links: d.querySelectorAll("a[href]").length, sheets: d.styleSheets.length, scripts: d.querySelectorAll("script").length }; });
      assert.ok(st.links > 50, "links missing " + JSON.stringify(st));
      assert.ok(st.sheets > 0, "the site's own styles are missing");
      assert.equal(st.scripts, 0);
      await disp.waitForTimeout(600);
      await disp.screenshot({ path: `${SHOTS}/glass-1-display.png` });
    });

    await t("glass: tapping a link directly on the display opens it", async () => {
      const L = await linkPoint();
      assert.ok(L, "no visible link");
      const before = (await G()).url;
      await disp.mouse.click(L.sx, L.sy);
      await disp.waitForFunction((b) => window.__airpane.state.glass.url !== b && !window.__airpane.state.glass.loading, before, { timeout: 30000 });
      await disp.evaluate(() => document.getElementById("back-btn")); // no-op, keeps timing stable
      await disp.evaluate(() => window.__airpane && null);
      await disp.evaluate(() => { /* go back to the article for the controller tests */ });
      await disp.fill("#url-input", "https://en.m.wikipedia.org/wiki/Augmented_reality");
      await disp.press("#url-input", "Enter");
      await disp.waitForFunction(() => /Augmented_reality/.test(window.__airpane.state.glass.url) && !window.__airpane.state.glass.loading, null, { timeout: 30000 });
    });

    let code;
    await t("controller: pairs with the display by code", async () => {
      code = await disp.textContent("#glass-code");
      await ctl.goto(BASE + "/control" + PQ, { waitUntil: "load" });
      await ctl.fill("#code", code.toLowerCase());
      await ctl.click("#connect");
      await ctl.waitForSelector("#panel:not([hidden])", { timeout: 30000 });
      // once connected the live page fills the window: slim bar on top, camera in a corner
      await ctl.waitForFunction(() => document.body.classList.contains("connected"));
      const lay = await ctl.evaluate(() => { const c = document.querySelector(".pad-card").getBoundingClientRect(), bar = document.querySelector(".now").getBoundingClientRect(), cam = document.querySelector(".cam").getBoundingClientRect(); return { cardW: c.width, cardH: c.height, top: c.top, bottom: innerHeight - c.bottom, bar: bar.height, camW: cam.width, W: innerWidth, H: innerHeight, overX: document.documentElement.scrollWidth - innerWidth, overY: document.documentElement.scrollHeight - innerHeight }; });
      assert.ok(Math.abs(lay.cardW - lay.W) < 2 && lay.bottom < 2 && lay.cardH > lay.H - 90, "live page does not fill the window: " + JSON.stringify(lay));
      assert.ok(lay.bar < 80 && lay.camW < 300 && lay.overX <= 0 && lay.overY <= 0, JSON.stringify(lay));
      await disp.waitForFunction(() => window.__airpane.state.peers === 1, null, { timeout: 15000 });
      assert.equal(await disp.isHidden("#glass-pair"), true, "pairing card should hide once connected");
      await ctl.waitForFunction(() => /Augmented reality/i.test(document.getElementById("now-title").textContent), null, { timeout: 15000 });
    });

    await t("controller: trackpad moves the cursor onto a link and the display highlights it", async () => {
      // the test webcam shows a hand, which also moves the cursor: switch hand control off for the trackpad
      await ctl.click("#hands");
      await ctl.waitForFunction(() => !window.__ctl.state.handsOn);
      const L = await linkPoint();
      await ctl.locator("#pad").scrollIntoViewIfNeeded(); const pad = await ctl.locator("#pad").boundingBox();
      await ctl.mouse.move(pad.x + L.x * pad.width, pad.y + L.y * pad.height, { steps: 4 });
      await disp.waitForFunction(() => document.querySelector("#glass .g-page").contentDocument.querySelector("a.airpane-hover"), null, { timeout: 10000 });
      assert.equal(await disp.isVisible(".g-cursor"), true);
      // the live view on the laptop highlights the same link
      await ctl.waitForFunction(() => document.querySelector("#mirror .g-page").contentDocument?.querySelector("a.airpane-hover"), null, { timeout: 10000 });
      assert.equal(await hovered(ctl, "#mirror .g-page"), await hovered(disp, "#glass .g-page"));
      await ctl.waitForFunction(() => /Make a fist to open/.test(document.getElementById("now-hover").textContent), null, { timeout: 10000 });
      await disp.screenshot({ path: `${SHOTS}/glass-2-hover.png` });
      await ctl.click("#hands"); // hand control back on
    });

    await t("controller: clicking opens the link on the floating page, Back returns, Forward goes again", async () => {
      const before = (await G()).url;
      const L = await linkPoint();
      await ctl.locator("#pad").scrollIntoViewIfNeeded(); const pad = await ctl.locator("#pad").boundingBox();
      await ctl.mouse.click(pad.x + L.x * pad.width, pad.y + L.y * pad.height);
      await disp.waitForFunction((b) => window.__airpane.state.glass.url !== b && !window.__airpane.state.glass.loading, before, { timeout: 30000 });
      const opened = (await G()).url;
      await ctl.click("#back");
      await disp.waitForFunction((b) => window.__airpane.state.glass.url === b && !window.__airpane.state.glass.loading, before, { timeout: 30000 });
      assert.equal((await G()).canForward, true, "forward should be available after going back");
      await ctl.click("#forward");
      await disp.waitForFunction((o) => window.__airpane.state.glass.url === o && !window.__airpane.state.glass.loading, opened, { timeout: 30000 });
      await ctl.click("#back");
      await disp.waitForFunction((b) => window.__airpane.state.glass.url === b && !window.__airpane.state.glass.loading, before, { timeout: 30000 });
    });

    await t("controller: scrolling moves the floating page", async () => {
      const y0 = (await G()).y;
      await ctl.locator("#pad").scrollIntoViewIfNeeded(); const pad = await ctl.locator("#pad").boundingBox();
      await ctl.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
      for (let i = 0; i < 4; i++) { await ctl.mouse.wheel(0, 400); await ctl.waitForTimeout(80); }
      await disp.waitForFunction((y) => window.__airpane.state.glass.y > y + 100, y0, { timeout: 10000 });
      await ctl.keyboard.press("PageUp"); await ctl.keyboard.press("PageUp"); await ctl.keyboard.press("PageUp");
    });

    await t("controller: live view shows the same page as the glass, same scroll and shape", async () => {
      for (let i = 0; i < 2; i++) { await ctl.keyboard.press("PageDown"); await ctl.waitForTimeout(120); }
      await ctl.waitForFunction(() => { const m = window.__ctl.state.mirror; return m.mode === "page" && m.y > 0 && Math.abs(document.querySelector("#mirror .g-page").contentWindow.scrollY - m.y) < 2; }, null, { timeout: 30000 });
      const d = await disp.evaluate(() => { const f = document.querySelector("#glass .g-page"); return { g: window.__airpane.state.glass, links: f.contentDocument.querySelectorAll("a[href]").length, bg: getComputedStyle(f.contentDocument.body).backgroundColor }; });
      const c = await ctl.evaluate(() => { const p = document.getElementById("pad").getBoundingClientRect(), f = document.querySelector("#mirror .g-page"); return { m: window.__ctl.state.mirror, links: f.contentDocument.querySelectorAll("a[href]").length, bg: getComputedStyle(f.contentDocument.body).backgroundColor, sy: f.contentWindow.scrollY, ar: p.width / p.height, empty: document.getElementById("pad-empty").hidden, box: document.querySelector("#mirror .m-box").getBoundingClientRect().width / p.width }; });
      assert.equal(c.m.url, d.g.url, "mirror shows another page");
      assert.equal(c.links, d.links);
      assert.equal(c.bg, d.bg, "colours differ");
      assert.equal(await pageText(ctl, "#mirror .g-page"), await pageText(disp, "#glass .g-page"));
      assert.ok(Math.abs(c.sy - d.g.y) < 2, `scroll out of sync ${c.sy} ${d.g.y}`);
      assert.ok(Math.abs(c.ar - d.g.view.w / d.g.view.h) < 0.02, "pad shape differs from the display: " + c.ar);
      assert.ok(Math.abs(c.box - 1) < 0.01, "mirror not fitted to the pad: " + c.box);
      assert.equal(c.empty, true, "placeholder still covers the live view");
      await ctl.locator("#pad").scrollIntoViewIfNeeded();
      await ctl.locator(".pad-card").screenshot({ path: `${SHOTS}/glass-4-live-view.png` });
      await ctl.keyboard.press("PageUp"); await ctl.keyboard.press("PageUp"); await ctl.keyboard.press("PageUp");
      const z0 = c.m.view.zoom;
      await ctl.click("#bigger");
      await ctl.waitForFunction((z) => window.__ctl.state.mirror.view.zoom > z + 0.02, z0, { timeout: 10000 });
      const zD = await disp.evaluate(() => document.querySelector("#glass .g-page").contentDocument.documentElement.style.zoom);
      await ctl.waitForFunction((z) => document.querySelector("#mirror .g-page").contentDocument.documentElement.style.zoom === z, zD, { timeout: 5000 });
      await ctl.click("#smaller");
    });

    await t("controller: Full screen makes the live view fill the laptop screen, Esc leaves", async () => {
      await ctl.click("#big");
      await ctl.waitForFunction(() => window.__ctl.state.big);
      await ctl.waitForTimeout(300);
      const r = await ctl.evaluate(() => { const p = document.getElementById("pad").getBoundingClientRect(); return { w: p.width, h: p.height, W: innerWidth, H: innerHeight, k: document.querySelector("#mirror .m-box").getBoundingClientRect().width / p.width }; });
      assert.ok(r.w > r.W * 0.97 || r.h > r.H * 0.97, "live view not full screen " + JSON.stringify(r));
      assert.ok(Math.abs(r.k - 1) < 0.01, "mirror not refitted " + r.k);
      await ctl.screenshot({ path: `${SHOTS}/glass-5-full-screen.png` });
      // the pad still drives the floating page in full screen
      const y0 = (await G()).y;
      const pad = await ctl.locator("#pad").boundingBox();
      await ctl.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
      await ctl.mouse.wheel(0, 500);
      await disp.waitForFunction((y) => window.__airpane.state.glass.y > y + 50, y0, { timeout: 10000 });
      await ctl.keyboard.press("Escape");
      await ctl.waitForFunction(() => !window.__ctl.state.big);
      await ctl.keyboard.press("PageUp"); await ctl.keyboard.press("PageUp");
    });

    await t("controller: opening a site from the laptop shows it in the air", async () => {
      await ctl.fill("#go-url", "example.com");
      await ctl.press("#go-url", "Enter");
      await disp.waitForFunction(() => { const g = window.__airpane.state.glass; return !g.loading && /Example Domain/.test(g.title); }, null, { timeout: 30000 });
      assert.match(await pageText(disp, "#glass .g-page"), /documentation examples/);
      await ctl.waitForFunction(() => /Example Domain/.test(document.getElementById("now-title").textContent), null, { timeout: 10000 });
    });

    await t("tabs that a site switches with its own scripts open on the floating page and the live view", async () => {
      await ctl.fill("#go-url", "anchit-tandon.com");
      await ctl.press("#go-url", "Enter");
      await disp.waitForFunction(() => { const g = window.__airpane.state.glass; return !g.loading && g.mode === "page" && /anchit-tandon/.test(g.url); }, null, { timeout: 40000 });
      await ctl.waitForFunction(() => window.__ctl.state.mirror.mode === "page" && /anchit-tandon/.test(window.__ctl.state.mirror.url) && !document.querySelector("#mirror .g-page").hidden, null, { timeout: 40000 });
      const shownView = (pg, sel) => pg.evaluate((sel) => [...document.querySelector(sel).contentDocument.querySelectorAll("section.view")].filter((v) => v.getClientRects().length).map((v) => v.id).join(","), sel);
      assert.equal(await shownView(disp, "#glass .g-page"), "view-home");
      for (const [label, id] of [["About", "view-about"], ["Now", "view-now"], ["Experience", "view-experience"]]) {
        const L = await disp.evaluate((id) => window.__airpane.glassLinks(300).find((l) => l.href.endsWith("#" + id.replace("view-", ""))), id);
        assert.ok(L, "no menu item for " + label);
        const pad = await ctl.locator("#pad").boundingBox();
        await ctl.mouse.click(pad.x + L.x * pad.width, pad.y + L.y * pad.height);
        await disp.waitForFunction((id) => window.__airpane.state.glass.tab === id.replace("view-", ""), id, { timeout: 20000 }).catch(async () => { throw new Error(label + " did not switch on the display: " + JSON.stringify(await disp.evaluate(() => window.__airpane.state.glass)) + " clicked " + JSON.stringify(L)); });
        assert.equal(await shownView(disp, "#glass .g-page"), id, label + " did not open on the display");
        await ctl.waitForFunction((id) => [...document.querySelector("#mirror .g-page").contentDocument.querySelectorAll("section.view")].some((v) => v.id === id && v.getClientRects().length), id, { timeout: 20000 }).catch(async () => { throw new Error(label + " did not switch in the live view: " + JSON.stringify(await ctl.evaluate(() => window.__ctl.state.mirror))); });
      }
      await ctl.click("#back");
      await disp.waitForFunction(() => window.__airpane.state.glass.tab === "now", null, { timeout: 10000 });
      assert.equal(await shownView(disp, "#glass .g-page"), "view-now");
    });

    await t("a PDF (the resume) opens as pages on the floating page and the live view", async () => {
      await ctl.fill("#go-url", "https://anchit-tandon.com/assets/resume.pdf");
      await ctl.press("#go-url", "Enter");
      await disp.waitForFunction(() => { const g = window.__airpane.state.glass; return !g.loading && /resume\.pdf/.test(g.url); }, null, { timeout: 60000 });
      const d = await disp.evaluate(() => { const g = window.__airpane.state.glass, doc = document.querySelector("#glass .g-page").contentDocument; return { mode: g.mode, err: g.error, imgs: doc.images.length, w: doc.images[0] && doc.images[0].naturalWidth, max: g.max }; });
      assert.ok(d.mode === "page" && !d.err && d.imgs >= 1 && d.w > 500 && d.max > 100, JSON.stringify(d));
      await ctl.waitForFunction(() => (document.querySelector("#mirror .g-page").contentDocument?.images.length || 0) >= 1, null, { timeout: 60000 });
      await ctl.click("#back");
      await disp.waitForFunction(() => { const g = window.__airpane.state.glass; return !g.loading && /anchit-tandon\.com\/?$/.test(g.url); }, null, { timeout: 40000 });
    });

    await t("controller: webcam hand tracking finds the hand and drives the cursor", async () => {
      await ctl.waitForFunction(() => window.__ctl.state.detector && window.__ctl.state.hand, null, { timeout: 60000 });
      const c0 = await ctl.evaluate(() => window.__ctl.state.events.cur);
      await ctl.mouse.move(5, 5); // leave the trackpad so only the hand drives the cursor
      await ctl.waitForTimeout(1500);
      const st = await ctl.evaluate(() => window.__ctl.state);
      assert.ok(st.gesture.cursor, "no cursor from the hand");
      assert.ok(st.events.cur > c0 || st.events.cur > 0, "hand cursor never sent");
      assert.equal(await disp.isVisible(".g-cursor"), true);
      await ctl.evaluate(() => scrollTo(0, 0));
      await ctl.screenshot({ path: `${SHOTS}/glass-3-controller.png`, timeout: 15000 }).catch(() => {}); // picture only, not a check
    });

    await t("controller: with the page shown the right way up (no sheet), the laptop cursor still lands on links", async () => {
      await disp.evaluate(() => document.getElementById("ar").classList.remove("ui-hidden"));
      await disp.click("#flip-btn");
      assert.equal(await disp.evaluate(() => window.__airpane.state.glass.flip), false);
      const L = await linkPoint();
      assert.ok(L, "no visible link");
      await ctl.locator("#pad").scrollIntoViewIfNeeded(); const pad = await ctl.locator("#pad").boundingBox();
      await ctl.mouse.move(pad.x + L.x * pad.width, pad.y + L.y * pad.height, { steps: 4 });
      await disp.waitForFunction((t) => (document.querySelector("#glass .g-page").contentDocument.querySelector("a.airpane-hover")?.textContent || "").trim().startsWith(t.slice(0, 20)), L.text, { timeout: 10000 });
      await disp.click("#flip-btn"); // back to the sheet view for the remaining tests
      await ctl.mouse.move(5, 5);
    });

    await t("glass + controller: zero console errors", async () => { assert.deepEqual(disp.__errors, []); assert.deepEqual(ctl.__errors, []); });
    await dctx.close(); await cctx.close();
    await t("one page: on the laptop type a site, press Launch, scan the QR code with the phone, and control it right there", async () => {
      const c2 = await ctlBrowser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["camera"], ignoreHTTPSErrors: true });
      const d2 = await browser.newContext({ ...devices["Pixel 7"], ignoreHTTPSErrors: true });
      const lap = await c2.newPage(), phone = await d2.newPage();
      const errs = [];
      for (const pg of [lap, phone]) pg.on("pageerror", (e) => errs.push(e.message));
      await lap.goto(BASE + "/" + PQ, { waitUntil: "load" });
      const home = lap.url();
      assert.equal(await lap.isChecked("input[value=control]"), true);
      await lap.fill("#launch-input", "example.com");
      await lap.click("#launch-btn");
      const f = lap.frameLocator("#ctl-frame");
      await f.locator("#qr svg").waitFor({ timeout: 20000 });
      assert.equal(lap.url(), home, "the controller must open on the same page");
      const frame = lap.frames().find((fr) => /\/control/.test(fr.url()));
      const qr = await frame.evaluate(() => window.__ctl.qr);
      assert.match(qr.url, /\/\?pair=[A-Z]{4}&open=https%3A%2F%2Fexample\.com/);
      const box = await f.locator("#qr").boundingBox();
      assert.ok(box.width >= 180, "QR code too small to scan: " + box.width);
      await lap.screenshot({ path: `${SHOTS}/pair-1-laptop-qr.png` });
      // the phone "scans" it: its camera app opens this link
      await phone.goto(qr.url, { waitUntil: "load" });
      await phone.waitForFunction(() => window.__airpane && window.__airpane.state.view === "glass" && window.__airpane.state.running, null, { timeout: 20000 });
      assert.equal(await phone.isVisible("#help-art"), true, "the animated set-up guide should show");
      await phone.screenshot({ path: `${SHOTS}/pair-2-phone-help.png` });
      await f.locator("#panel:not([hidden])").waitFor({ timeout: 40000 });
      await phone.waitForFunction(() => window.__airpane.state.peers === 1, null, { timeout: 20000 });
      assert.doesNotMatch(phone.url(), /pair=/, "pair code should be removed from the address");
      await phone.click("#pyr-help-ok");
      await phone.waitForFunction(() => { const g = window.__airpane.state.glass; return !g.loading && /example\.com/.test(g.url); }, null, { timeout: 30000 });
      // the laptop's whole window is the controller, and it really controls the phone
      const lay = await frame.evaluate(() => { const c = document.querySelector(".pad-card").getBoundingClientRect(); return [c.width, innerWidth, document.body.classList.contains("connected")]; });
      assert.ok(Math.abs(lay[0] - lay[1]) < 2 && lay[2], JSON.stringify(lay));
      const pad = await f.locator("#pad").boundingBox();
      await lap.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
      await phone.waitForFunction(() => document.querySelector(".g-cursor") && !document.querySelector(".g-cursor").hidden, null, { timeout: 10000 });
      // Exit goes back to the start of the same page
      await f.locator("#home").click();
      await lap.waitForFunction(() => !window.__airpane_ctl.open);
      assert.equal(await lap.isVisible("#landing"), true);
      assert.deepEqual(errs, []);
      await c2.close(); await d2.close();
    });

    await t("one page: a phone already showing a code can still be paired from the laptop's pairing screen", async () => {
      const c2 = await ctlBrowser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["camera"], ignoreHTTPSErrors: true });
      const d2 = await browser.newContext({ ...devices["Pixel 7"], ignoreHTTPSErrors: true });
      const lap = await c2.newPage(), phone = await d2.newPage();
      await phone.goto(BASE + "/" + PQ, { waitUntil: "load" });
      assert.equal(await phone.isChecked("input[value=glass]"), true, "a phone should start as the floating display");
      await phone.tap("#landing .chip >> text=Wikipedia");
      await phone.tap("#pyr-help-ok");
      await phone.waitForFunction(() => /^[A-Z]{4}$/.test(window.__airpane.state.code || ""), null, { timeout: 30000 });
      const code = await phone.evaluate(() => window.__airpane.state.code);
      await lap.goto(BASE + "/" + PQ, { waitUntil: "load" });
      assert.equal(await lap.locator("#launch-form input").count(), 1, "the home page has one field: the website");
      await lap.fill("#launch-input", "example.com");
      await lap.press("#launch-input", "Enter");
      const fr = lap.frameLocator("#ctl-frame");
      await fr.locator("#qr svg").waitFor({ timeout: 20000 });
      await fr.locator("#code").fill(code.toLowerCase());
      await fr.locator("#connect").click();
      await fr.locator("#panel:not([hidden])").waitFor({ timeout: 40000 });
      await phone.waitForFunction(() => { const g = window.__airpane.state.glass; return !g.loading && /example\.com/.test(g.url); }, null, { timeout: 30000 });
      // the browser's Back button closes the controller
      await lap.evaluate(() => history.back());
      await lap.waitForFunction(() => !window.__airpane_ctl.open, null, { timeout: 5000 });
      await c2.close(); await d2.close();
    });

    await t("laptop only, no phone: the Hologram shows the real page in 3D, with hand, mouse and wheel control", async () => {
      const c3 = await ctlBrowser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["camera"], ignoreHTTPSErrors: true });
      const p = await c3.newPage();
      const errs = [];
      p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(BASE + "/", { waitUntil: "load" });
      assert.equal(await p.isVisible(".mode-opt:has(input[value=hologram])"), true, "Hologram should be offered on a laptop");
      await p.click(".mode-opt:has(input[value=hologram])");
      await p.fill("#launch-input", "anchit-tandon.com");
      await p.press("#launch-input", "Enter");
      await p.waitForFunction(() => { const s = window.__airpane.state; return s.view === "holo" && s.handMode && s.holoGlass && s.holoGlass.mode === "page" && !s.holoGlass.loading; }, null, { timeout: 60000 });
      assert.equal(await p.locator(".holo-plane").count(), 5, "the 3D room is missing");
      // the webcam hand drives the cursor on the floating page
      await p.waitForFunction(() => { const h = window.__airpane.state.hands; return h && h.ready && h.events > 0; }, null, { timeout: 60000 });
      await p.waitForFunction(() => !document.querySelector(".holo-glass .g-cursor").hidden, null, { timeout: 20000 });
      // a mouse click through the 3D view lands on the right place: open the About tab
      const pt = await p.evaluate(() => {
        const host = document.querySelector(".holo-glass"), d = host.querySelector(".g-page").contentDocument;
        const a = d.querySelector('a[data-view="about"].sidebar-item'), r = a.getBoundingClientRect();
        const probe = document.createElement("div");
        probe.style.cssText = `position:absolute;left:${(r.left + r.width / 2) / host.clientWidth * 100}%;top:${(r.top + r.height / 2) / host.clientHeight * 100}%;width:2px;height:2px`;
        host.append(probe); const q = probe.getBoundingClientRect(); probe.remove();
        return { x: q.left + 1, y: q.top + 1 };
      });
      await p.mouse.click(pt.x, pt.y);
      await p.waitForFunction(() => window.__airpane.state.holoGlass.tab === "about", null, { timeout: 15000 });
      const y0 = await p.evaluate(() => window.__airpane.state.holoGlass.y);
      await p.mouse.move(720, 450); await p.mouse.wheel(0, 700);
      await p.waitForFunction((y) => window.__airpane.state.holoGlass.y > y + 100, y0, { timeout: 10000 });
      await p.screenshot({ path: `${SHOTS}/hologram-laptop-only.png` });
      await p.click("#exit-btn");
      await p.waitForFunction(() => !window.__airpane.state.running && !window.__airpane.state.holoGlass);
      assert.deepEqual(errs, []);
      await c3.close();
    });

    await ctlBrowser.close();
    try { peerSrv.close && peerSrv.close(); peerSrv._server && peerSrv._server.close(); } catch {}
  }

  // ---------- Airpane Desktop page ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await t("home: links to Airpane Desktop", async () => {
      await page.goto(BASE + "/", { waitUntil: "load" });
      await page.click(".promo");
      await page.waitForURL(/\/desktop\/$/);
    });
    await t("desktop page: install command, copy button and screenshot", async () => {
      assert.equal(await page.textContent("#cmd"), "curl -fsSL https://airpane.anchit-tandon.com/desktop/install.sh | bash");
      await page.bringToFront();
      await page.click("#copy");
      await page.waitForFunction(() => document.getElementById("copy").textContent !== "Copy", null, { timeout: 3000 });
      const label = await page.textContent("#copy");
      const CMD = "curl -fsSL https://airpane.anchit-tandon.com/desktop/install.sh | bash";
      // If the browser blocks the clipboard, the command is selected for Cmd+C instead.
      if (label === "Copied") assert.equal(await page.evaluate(() => navigator.clipboard.readText()), CMD, "clipboard");
      else assert.equal([label, await page.evaluate(() => String(getSelection()))].join("|"), "Press Cmd+C|" + CMD, "fallback selects the command");
      await page.waitForFunction(() => document.querySelector(".shot img").complete);
      assert.equal(await page.evaluate(() => document.querySelector(".shot img").naturalWidth), 800, "screenshot image");
      await page.screenshot({ path: `${SHOTS}/desktop-page.png`, fullPage: true });
    });
    await t("desktop page: installer and app download are served", async () => {
      const sh = await (await fetch(BASE + "/desktop/install.sh")).text();
      assert.ok(sh.startsWith("#!/usr/bin/env bash"));
      // every app file the installer lists is served, byte for byte
      const list = sh.split("FILES='")[1].split("'")[0].trim().split("\n").map((l) => l.split(" "));
      assert.ok(list.length >= 13, "file list");
      for (const [sum, f] of list) {
        const r = await fetch(BASE + "/desktop/app/" + f);
        assert.equal(r.status, 200, f);
        const got = require("node:crypto").createHash("sha1").update(Buffer.from(await r.arrayBuffer())).digest("hex");
        assert.equal(got, sum, f + " differs from the installer's list");
      }
    });
    await t("desktop page: fits a phone", async () => {
      const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await m.goto(BASE + "/desktop/", { waitUntil: "load" });
      assert.ok((await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
      await m.screenshot({ path: `${SHOTS}/desktop-page-phone.png`, fullPage: true });
      await m.close();
    });
    await t("desktop page: zero console errors", async () => assert.deepEqual(errors, []));
    await ctx.close();
  }

  await browser.close();
  if (server) server.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
