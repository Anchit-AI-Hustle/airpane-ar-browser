// Phones and tablets: every page fits, the floating glass works by touch, and a phone
// without a clear sheet can read the page the right way up.
// Runs in Chromium (Android phone, tablet) and, when installed, WebKit (iPhone, iPad).
const pw = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const BASE = process.env.BASE_URL || "http://localhost:3107";
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("ok  ", name); }
  catch (e) { fail++; console.error("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    ")); }
}

(async () => {
  let server;
  if (!process.env.BASE_URL) {
    server = spawn("node", ["scripts/dev-server.js"], { env: { ...process.env, PORT: "3107" }, stdio: "ignore" });
    for (let i = 0; i < 40; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  }
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "<-loopback>,localhost,127.0.0.1" } : undefined;
  const runs = [["chromium", "Pixel 7"], ["chromium", "Galaxy Tab S4"]];
  let webkitOk = false;
  try { const b = await pw.webkit.launch(); await b.close(); webkitOk = true; } catch {}
  if (webkitOk) runs.push(["webkit", "iPhone 15"], ["webkit", "iPad (gen 7)"]);
  else console.log("(WebKit not installed: iPhone / iPad runs skipped)");

  for (const [engine, device] of runs) {
    const label = `${device} (${engine})`;
    const browser = await pw[engine].launch(engine === "chromium" ? { proxy } : {});
    const ctx = await browser.newContext({ ...pw.devices[device], ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    p.setDefaultTimeout(30000);
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));

    await t(`${label}: home, controller and desktop pages fit without sideways scrolling`, async () => {
      for (const path of ["/", "/control", "/desktop/"]) {
        await p.goto(BASE + path, { waitUntil: "domcontentloaded" });
        await p.waitForTimeout(400);
        const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(over <= 0, `${path} overflows by ${over}px`);
      }
    });

    await t(`${label}: the set-up card's buttons are on screen without scrolling`, async () => {
      await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await p.evaluate(() => { try { localStorage.clear(); } catch {} });
      await p.tap("#landing .chip >> text=Wikipedia");
      await p.waitForSelector("#pyr-help:not([hidden])");
      for (const id of ["#pyr-help-ok", "#help-noflip"]) {
        const box = await p.locator(id).boundingBox();
        const vh = await p.evaluate(() => innerHeight);
        assert.ok(box && box.y >= 0 && box.y + box.height <= vh, `${id} is off screen: ${JSON.stringify(box)} vh ${vh}`);
      }
    });

    await t(`${label}: "Read it on this screen" shows the page the right way up`, async () => {
      await p.tap("#help-noflip");
      await p.waitForFunction(() => { const g = window.__airpane.state.glass; return !g.loading && g.mode === "page" && /Augmented reality/i.test(g.title); });
      const txt = await p.evaluate(() => document.querySelector("#glass .g-page").contentDocument.body.innerText);
      assert.match(txt, /Augmented reality/i);
      const tf = await p.evaluate(() => getComputedStyle(document.querySelector(".g-flip")).transform);
      assert.ok(tf === "none" || tf === "matrix(1, 0, 0, 1, 0, 0)", tf);
      assert.equal(await p.evaluate(() => window.__airpane.state.glass.flip), false);
    });

    await t(`${label}: tapping a link on the screen opens it`, async () => {
      const before = await p.evaluate(() => window.__airpane.state.glass.url);
      const pt = await p.evaluate(() => {
        const here = window.__airpane.state.glass.url.split("#")[0], d = document.querySelector(".g-doc").getBoundingClientRect();
        const L = window.__airpane.glassLinks(80).find((l) => l.y > 0.2 && l.y < 0.75 && /^https?:/.test(l.href) && l.href.split("#")[0] !== here);
        return L && { x: d.left + L.x * d.width, y: d.top + L.y * d.height };
      });
      assert.ok(pt, "no link on screen");
      await p.touchscreen.tap(pt.x, pt.y);
      await p.waitForFunction((b) => window.__airpane.state.glass.url !== b && !window.__airpane.state.glass.loading, before);
    });

    await t(`${label}: dragging up scrolls down, like any phone page`, async () => {
      await p.waitForTimeout(500);
      const y0 = await p.evaluate(() => window.__airpane.state.glass.y);
      const box = await p.locator("#glass").boundingBox();
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await p.evaluate(({ cx, cy }) => {
        const el = document.getElementById("glass");
        const ev = (type, y) => el.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: y, bubbles: true, pointerType: "touch" }));
        ev("pointerdown", cy); for (let i = 1; i <= 10; i++) ev("pointermove", cy - i * 20); ev("pointerup", cy - 200);
      }, { cx, cy });
      const y1 = await p.evaluate(() => window.__airpane.state.glass.y);
      assert.ok(y1 > y0 + 100, `y ${y0} -> ${y1}`);
    });

    await t(`${label}: the "For clear sheet" switch flips the page back for the sheet, and is remembered`, async () => {
      await p.tap("#ar"); // bring the controls back
      await p.tap("#flip-btn");
      assert.equal(await p.evaluate(() => window.__airpane.state.glass.flip), true);
      assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector(".g-flip")).transform), "matrix(1, 0, 0, -1, 0, 0)");
      assert.equal(await p.textContent("#flip-btn"), "For clear sheet: on");
      await p.tap("#flip-btn");
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.tap("#landing .chip >> text=Wikipedia");
      await p.waitForFunction(() => window.__airpane && window.__airpane.state.view === "glass");
      assert.equal(await p.evaluate(() => window.__airpane.state.glass.flip), false, "choice not remembered");
    });

    await t(`${label}: no page errors`, async () => assert.deepEqual(errors, []));
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
