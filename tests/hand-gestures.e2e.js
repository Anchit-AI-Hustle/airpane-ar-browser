// Real browser + real MediaPipe hand tracking + a fake webcam of real hand photos:
// an open hand must scroll the floating page, and never click. (Swipes need a faster
// machine than this sandbox; they are covered with real recorded hands in gestures.test.mjs.)
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");

const BASE = process.env.BASE_URL || "http://localhost:3101";
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("ok  ", name); }
  catch (e) { fail++; console.error("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    ")); }
}

(async () => {
  let server;
  if (!process.env.BASE_URL) {
    server = spawn("node", ["scripts/dev-server.js"], { env: { ...process.env, PORT: "3101" }, stdio: "ignore" });
    for (let i = 0; i < 40; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  }
  const VID = "/tmp/airpane-hand-gestures.y4m";
  if (!fs.existsSync(VID)) execSync(`python3 tests/make_hand_video.py ${VID}`);
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "<-loopback>,localhost,127.0.0.1" } : undefined;
  const { PeerServer } = require("peer");
  const peerSrv = await new Promise((ok) => { const s = PeerServer({ port: 9124, host: "127.0.0.1", path: "/" }, () => ok(s)); });
  const PQ = "?peer=127.0.0.1:9124";

  const dispB = await chromium.launch({ proxy });
  const ctlB = await chromium.launch({ proxy, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${VID}`, "--disable-gpu"] });
  const disp = await (await dispB.newContext({ viewport: { width: 1180, height: 820 }, ignoreHTTPSErrors: true })).newPage();
  const ctl = await (await ctlB.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["camera"], ignoreHTTPSErrors: true })).newPage();
  const errs = [];
  for (const pg of [disp, ctl]) {
    pg.on("pageerror", (e) => errs.push(e.message));
    pg.on("console", (m) => { if (m.type() === "error" && !/frame|Refused|ERR_|403|429|503|net::|Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  }

  await t("display opens a page and the controller pairs", async () => {
    await disp.goto(BASE + "/" + PQ, { waitUntil: "load" });
    await disp.click("#landing .chip >> text=Wikipedia");
    await disp.click("#pyr-help-ok");
    await disp.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById("glass-code").textContent), null, { timeout: 30000 });
    await disp.waitForFunction(() => /Augmented reality/i.test(document.querySelector(".g-content h1")?.textContent || ""), null, { timeout: 30000 });
    const code = await disp.textContent("#glass-code");
    await ctl.goto(BASE + "/control" + PQ, { waitUntil: "load" });
    await ctl.fill("#code", code);
    await ctl.click("#connect");
    await ctl.waitForSelector("#panel:not([hidden])", { timeout: 30000 });
    await ctl.mouse.move(2, 2);
  });

  await t("the hand is tracked", async () => {
    await ctl.waitForFunction(() => window.__ctl.state.detector && window.__ctl.state.hand, null, { timeout: 60000 });
    if (process.env.DEBUG_POSES) {
      const log = [];
      for (let i = 0; i < 60; i++) { log.push(await ctl.evaluate(async () => { const { classify } = await import("/poses.js"); const lm = window.__ctl.lastLandmarks(); return [window.__ctl.state.pose, lm && classify(lm.map(([x, y]) => [1 - x, y])), lm && JSON.stringify(lm)].join("|"); })); await ctl.waitForTimeout(120); }
      console.log(log.join("\n"));
    }
  });

  const seen = new Set();
  let y0 = 0;
  await t("pushing an open hand up scrolls the floating page down", async () => {
    y0 = (await disp.evaluate(() => window.__airpane.state.glass)).y || 0;
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      const s = await ctl.evaluate(() => ({ pose: window.__ctl.state.pose, ev: window.__ctl.state.events }));
      if (s.pose) seen.add(s.pose);
      const y = (await disp.evaluate(() => window.__airpane.state.glass)).y || 0;
      if (y - y0 > 150) break;
      await ctl.waitForTimeout(100);
    }
    const y = (await disp.evaluate(() => window.__airpane.state.glass)).y || 0;
    assert.ok(y - y0 > 150, `page only moved ${Math.round(y - y0)}px; poses seen: ${[...seen]}`);
  });

  await t("the open hand never clicks", async () => {
    const ev = await ctl.evaluate(() => window.__ctl.state.events);
    assert.equal(ev.click, 0, JSON.stringify(ev));
  });

  await t("the controller shows the easy gesture guide", async () => {
    const txt = await ctl.textContent(".howto");
    assert.match(txt, /Open hand, move up or down/);
    assert.doesNotMatch(txt, /V sign/);
  });

  await t("no console errors", async () => { assert.deepEqual(errs, []); });

  console.log(`\n${pass} passed, ${fail} failed`);
  await dispB.close(); await ctlB.close(); peerSrv.close?.(); if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
