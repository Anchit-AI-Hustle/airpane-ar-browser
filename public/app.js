import {
  deg, clamp, quat, quatFromEulerYXZ, quatNlerp, rotate, deviceQuat,
  scale, norm, matFacing, applyMat, viewMatrix, cameraCSS, objectCSS,
} from "./math3d.js";
import { createHolo } from "./holo.js";
import { createPyramid } from "./pyramid.js";
import { createGlass } from "./glass.js";
import { host } from "./link.js";

const $ = (id) => document.getElementById(id);
const landing = $("landing"), ar = $("ar"), cam = $("cam"), stage = $("stage");
const statusEl = $("status"), modeChip = $("mode-chip"), hintEl = $("hint"), toastEl = $("toast");
const urlInput = $("url-input"), launchInput = $("launch-input"), launchBtn = $("launch-btn");

const FOV = 60;
const QUICK = [
  ["Wikipedia", "https://en.m.wikipedia.org/wiki/Augmented_reality"],
  ["YouTube video", "https://www.youtube.com/embed/aqz-KE-bpKQ"],
  ["Live map", "https://www.openstreetmap.org/export/embed.html?bbox=77.18%2C28.58%2C77.26%2C28.64&layer=mapnik"],
];

// ---------- helpers ----------
// Full web search engines refuse to be framed, so plain searches go to Google in
// Cloud mode and to Wikipedia search in Direct mode.
export function normalizeInput(raw, cloudOn = false) {
  const q = String(raw || "").trim();
  if (!q) return "";
  if (/^https?:\/\//i.test(q)) return q;
  if (!/\s/.test(q) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(q)) return "https://" + q;
  return cloudOn
    ? "https://www.google.com/search?q=" + encodeURIComponent(q)
    : "https://en.m.wikipedia.org/w/index.php?search=" + encodeURIComponent(q);
}

let toastTimer;
function toast(msg, ms = 3500) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}
function setStatus(t) { statusEl.textContent = t || ""; }
function setMode(m) {
  modeChip.textContent = m === "cloud" ? "Cloud" : "Direct";
  modeChip.classList.toggle("cloud", m === "cloud");
}
let hintTimer;
function hint(t, ms = 4500) {
  hintEl.textContent = t;
  hintEl.classList.add("show");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hintEl.classList.remove("show"), ms);
}

// ---------- 3D scene ----------
// One DOM element gets one flattened matrix3d (camera x object) under a parent
// with CSS perspective. Unlike nested preserve-3d layers, Chrome and Safari
// hit-test this correctly, so taps land on the right link inside the page.
let panelEl, frameHost, stateEl;
let camQ = quat();          // where the phone is looking
let panelPos = [0, 0, -1000]; // panel centre in the room (camera at origin)
let dist = 1000, running = false, placed = false, ready = false;
// "holo": laptop/desktop, the camera tracks your head and the page floats in front
// of the screen. "room": phone, the back camera shows the room and the page is
// pinned in it.
let view = "room", holo = null, pyr = null, glass = null, link = null, linkStarting = false;
const VIEWS = ["glass", "pyramid", "holo", "room"];
const LABEL = { glass: "Floating glass", pyramid: "Pyramid", holo: "Hologram", room: "Camera room" };
const FLOAT = (v) => v === "glass" || v === "pyramid"; // views seen as a reflection: no camera, fading controls
const viewBtn = $("view-btn"), trackEl = $("track");

export function pickView() {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const small = Math.min(screen.width, screen.height) < 900;
  return coarse && small ? "room" : "holo";
}

function render() {
  const fovPx = innerHeight / 2 / Math.tan(deg(FOV / 2));
  stage.style.perspective = fovPx + "px";
  const view = viewMatrix(camQ);
  // Hide the panel when it is behind the viewer (CSS perspective can't clip it).
  const visible = applyMat(view, panelPos)[2] < -50;
  panelEl.style.visibility = visible ? "visible" : "hidden";
  if (visible) panelEl.style.transform = `translateZ(${fovPx}px) ${cameraCSS(view)} ${objectCSS(matFacing(panelPos))}`;
}

function initScene() {
  if (ready) return;
  ready = true;
  panelEl = document.createElement("div");
  panelEl.className = "panel";
  frameHost = document.createElement("div");
  frameHost.style.cssText = "position:absolute;inset:0";
  stateEl = document.createElement("div");
  stateEl.className = "panel-state";
  panelEl.append(frameHost, stateEl);
  stage.appendChild(panelEl);
  holo = createHolo({ stage, panel: panelEl, video: cam, onStatus: onHoloStatus });
  pyr = createPyramid($("pyr"));
  glass = createGlass($("glass"), { onState: (st) => { if (view === "glass") setStatus(st.title || ""); if (link) link.broadcast({ t: "state", ...st }); } });
  wireGlassTouch();
  addEventListener("resize", onResize);
  addEventListener("orientationchange", () => setTimeout(onResize, 300));
}

function panelSize() {
  return innerWidth < innerHeight ? { w: 420, h: 740 } : { w: 1120, h: 680 };
}

function fitDistance({ w, h }) {
  const t = 2 * Math.tan(deg(FOV / 2));
  return Math.max(w / (0.9 * t * (innerWidth / innerHeight)), h / (0.74 * t));
}

// Place the panel straight ahead of where the device is pointing, upright.
function placePanel() {
  const size = panelSize();
  Object.assign(panelEl.style, { width: size.w + "px", height: size.h + "px", marginLeft: -size.w / 2 + "px", marginTop: -size.h / 2 + "px" });
  dist = fitDistance(size);
  // Use where the device is heading (gyro target), not the mid-smoothing camera pose.
  const q = gyro.active ? gyro.target : camQ;
  panelPos = scale(norm(rotate([0, 0, -1], q)), dist);
  placed = true;
}

function onResize() {
  if (!ready) return;
  const s = panelSize();
  if (parseInt(panelEl.style.width) !== s.w) placePanel();
}

function zoom(f) {
  if (view === "glass") return glassSize(f < 1 ? 1.1 : 0.9);
  if (view === "pyramid") return pyr.setSize(pyr.state.size * (f < 1 ? 1.05 : 0.95));
  if (view === "holo") return holo.zoom(f);
  dist = clamp(dist * f, 350, 5000);
  panelPos = scale(norm(panelPos), dist);
}

function loop() {
  if (!running) return;
  if (FLOAT(view)) { requestAnimationFrame(loop); return; }
  if (view === "holo") { holo.frame(performance.now(), panelSize()); requestAnimationFrame(loop); return; }
  camQ = gyro.active ? quatNlerp(camQ, gyro.target, 0.5) : quatFromEulerYXZ(look.pitch, look.yaw, 0);
  render();
  requestAnimationFrame(loop);
}

// ---------- device orientation (3DoF) ----------
const gyro = { active: false, target: quat() };
function onOrientation(e) {
  if (e.alpha == null || e.beta == null) return;
  const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  gyro.target = deviceQuat(e.alpha, e.beta, e.gamma || 0, angle);
  if (view !== "room") return;
  if (!gyro.active) {
    gyro.active = true;
    camQ = gyro.target;
    placePanel();
    hint("Move your phone. The page stays where it is.");
  }
}
function requestOrientation() {
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === "function") {
    return D.requestPermission().then((s) => s === "granted").catch(() => false);
  }
  return Promise.resolve(Boolean(D));
}

// Drag-to-look fallback (desktop, or phones without motion sensors).
const look = { yaw: 0, pitch: 0, drag: null };
stage.addEventListener("pointerdown", (e) => {
  if (view !== "room" || gyro.active || e.target.closest(".panel")) return;
  look.drag = { x: e.clientX, y: e.clientY, yaw: look.yaw, pitch: look.pitch };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", (e) => {
  if (!look.drag) return;
  look.yaw = look.drag.yaw + (e.clientX - look.drag.x) * 0.004;
  look.pitch = clamp(look.drag.pitch + (e.clientY - look.drag.y) * 0.004, -1.3, 1.3);
});
stage.addEventListener("pointerup", () => (look.drag = null));
stage.addEventListener("pointercancel", () => (look.drag = null));

// ---------- camera feed ----------
let stream = null;
async function startCamera(facing = "environment") {
  try {
    const small = facing === "user";
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: small ? 640 : 1280 }, height: { ideal: small ? 480 : 720 } },
      audio: false,
    });
    cam.srcObject = stream;
    await cam.play().catch(() => {});
    ar.classList.remove("no-cam");
    return true;
  } catch {
    ar.classList.add("no-cam");
    return false;
  }
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  cam.srcObject = null;
}

// ---------- browsing engines ----------
let cloud = { enabled: null, hb: null, busy: false };
let current = "";
let iframe = null;

async function cloudEnabled() {
  if (cloud.enabled !== null) return cloud.enabled;
  try {
    const r = await fetch("/api/session");
    cloud.enabled = r.ok && (await r.json()).enabled === true;
  } catch { cloud.enabled = false; }
  return cloud.enabled;
}

function showState(html) {
  stateEl.innerHTML = html;
  stateEl.hidden = !html;
}
function loadingState(text) {
  showState(`<div><div class="spinner"></div><p>${text}</p></div>`);
}

function destroyCloud() {
  if (cloud.hb) { try { cloud.hb.destroy(); } catch {} }
  cloud.hb = null;
}

function showDirect(url) {
  destroyCloud();
  setMode("direct");
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.setAttribute("allow", "autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write");
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.title = "Page";
  }
  frameHost.replaceChildren(iframe);
  loadingState("Loading page");
  const done = () => { showState(""); setStatus(new URL(url).host); };
  iframe.onload = done;
  setTimeout(() => { if (current === url && !stateEl.hidden) done(); }, 12000);
  iframe.src = url;
}

async function showCloud(url) {
  const size = panelSize();
  setMode("cloud");
  if (cloud.hb) {
    try {
      const tabs = await cloud.hb.tabs.query({ active: true });
      await cloud.hb.tabs.update(tabs[0].id, { url });
      setStatus(new URL(url).host);
      return;
    } catch { destroyCloud(); }
  }
  loadingState("Starting cloud browser");
  const r = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, w: size.w, h: size.h }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return showBlocked(url, data.error || "Cloud mode unavailable");
  const host = document.createElement("div");
  host.className = "hb-host";
  frameHost.replaceChildren(host);
  const { default: Hyperbeam } = await import("https://cdn.jsdelivr.net/npm/@hyperbeam/web@0.0.38/dist/index.js");
  cloud.hb = await Hyperbeam(host, data.embed_url, {
    adminToken: data.admin_token,
    onDisconnect: () => { cloud.hb = null; showBlocked(url, "The cloud session ended. Load the page again to restart it."); },
  });
  showState("");
  setStatus(new URL(url).host);
}

function showBlocked(url, reason) {
  destroyCloud();
  frameHost.replaceChildren();
  let host = url;
  try { host = new URL(url).host; } catch {}
  const links = QUICK.map(([n, u]) => `<button class="chip" data-url="${u}">${n}</button>`).join("");
  showState(`<div>
    <h2>${host} can't open here yet</h2>
    <p>This site doesn't allow other apps to display it. Cloud mode will open any site once it's switched on.</p>
    <div class="row">${links}</div>
  </div>`);
  setStatus(/frame|ancestors/i.test(reason || "") ? host + " blocks embedding" : reason || "");
}

async function loadURL(raw, { push = true } = {}) {
  const url = normalizeInput(raw, await cloudEnabled());
  if (!url) return;
  current = url;
  urlInput.value = url;
  urlInput.blur();
  if (push) history.pushState({ ar: 1, url }, "");
  if (view === "glass") { setMode("direct"); glass.load(url); return; }
  loadingState("Opening");
  setStatus("Checking " + url.replace(/^https?:\/\//, "").slice(0, 60));

  let check = { frameable: true, finalUrl: url };
  try {
    const r = await fetch("/api/check?url=" + encodeURIComponent(url));
    check = await r.json();
  } catch {}
  if (current !== url) return; // a newer load started

  if (view === "pyramid") {
    showState("");
    if (check.frameable || check.unknown) { pyr.show(url); setStatus(new URL(url).host); }
    else {
      pyr.clear();
      setStatus(new URL(url).host + " can't be shown");
      toast("This site blocks being shown inside other apps, so it can't float in the pyramid. Try Wikipedia or a YouTube embed.", 6000);
    }
    return;
  }
  if (check.frameable || check.unknown) return showDirect(url);
  if (await cloudEnabled()) {
    try { return await showCloud(url); }
    catch { return showBlocked(url, "Cloud mode failed to start"); }
  }
  showBlocked(url, check.reason);
}

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".panel-state .chip");
  if (chip) loadURL(chip.dataset.url);
});

// ---------- enter / exit ----------
async function enterAR(raw) {
  if (running) return loadURL(raw);
  launchBtn.disabled = true;
  const mode = (document.querySelector('input[name="mode"]:checked') || {}).value;
  view = mode === "pyramid" || mode === "glass" ? mode : pickView();
  if (FLOAT(view)) goFullscreen(); // must happen inside the tap
  const orientP = view === "room" ? requestOrientation() : Promise.resolve(false); // first call inside the tap on iPhone
  const camP = FLOAT(view) ? Promise.resolve(false) : startCamera(view === "holo" ? "user" : "environment");
  const [, camOk] = await Promise.all([orientP, camP]);
  launchBtn.disabled = false;

  landing.hidden = true;
  ar.hidden = false;
  initScene();
  onResize();
  gyro.active = false;
  look.yaw = 0; look.pitch = 0;
  camQ = quat();
  running = true;
  applyView(camOk);
  addEventListener("deviceorientation", onOrientation);
  requestAnimationFrame(loop);
  history.replaceState({ ar: 0 }, "");
  loadURL(raw);
}

function applyView(camOk) {
  ar.classList.toggle("holo", view === "holo");
  ar.classList.toggle("pyr", view === "pyramid");
  ar.classList.toggle("glassv", view === "glass");
  ar.classList.remove("ui-hidden");
  viewBtn.textContent = LABEL[view];
  viewBtn.setAttribute("aria-label", "3D view: " + viewBtn.textContent + ". Switch view");
  trackEl.hidden = true;
  stage.style.perspectiveOrigin = "";
  placePanel();
  if (FLOAT(view)) {
    holo.stop();
    ar.classList.remove("no-cam");
    keepAwake(true);
    if (view === "pyramid") { glass.stop(); pairEl.hidden = true; pyr.start(); if (current) pyr.show(current); }
    else { pyr.stop(); glass.start(); startLink(); }
    let seen = false;
    try { seen = localStorage.getItem("airpane-help-" + view) === "1"; } catch {}
    if (!seen) showHelp(); else hint(HELP[view].hint, 5000);
    pokeUI();
    return;
  }
  pyr.stop();
  glass.stop();
  pairEl.hidden = true;
  keepAwake(false);
  if (view === "holo") {
    holo.start();
    hint(camOk ? "Move your head. The page floats in front of your screen." : "Move the mouse to look around the page in 3D.", 6000);
    if (!camOk) toast("Camera is off, so head tracking is off. Using the mouse instead.");
  } else {
    holo.stop();
    if (!camOk) toast("Camera is off. Showing a virtual room instead.");
    setTimeout(() => { if (view === "room" && !gyro.active) hint("Drag the background to look around."); }, 1200);
  }
}

function onHoloStatus(st) {
  if (view !== "holo") return;
  trackEl.hidden = st !== "tracking";
  if (st === "tracking") hint("Head tracking on. Lean left and right.", 3500);
}

async function switchView() {
  view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
  stopCamera();
  gyro.active = false; look.yaw = 0; look.pitch = 0; camQ = quat();
  if (FLOAT(view)) { applyView(false); if (current) loadURL(current, { push: false }); return; }
  if (view === "room") await requestOrientation();
  const ok = await startCamera(view === "holo" ? "user" : "environment");
  applyView(ok);
  if (current) loadURL(current, { push: false });
}

// ---------- pyramid helpers ----------
const helpEl = $("pyr-help"), darkBtn = $("dark-btn"), pairEl = $("glass-pair"), pairBtn = $("pair-btn");
const HELP = {
  pyramid: {
    hint: "Stand the pyramid on the + mark. Tap the screen for controls.",
    steps: `<li>Cut 4 trapezoids from clear plastic: <b>6 cm</b> wide at the bottom, <b>1 cm</b> at the top, <b>3.5 cm</b> tall. <a href="/pyramid-template.html" target="_blank" rel="noopener">Printable template</a></li>
      <li>Tape the long edges together into a pyramid.</li>
      <li>Lay the phone flat, screen up, brightness high.</li>
      <li>Stand the pyramid upside down, small end on the <b>+</b> mark.</li>
      <li>Dim the room and look from the side, level with the phone. The page floats inside.</li>`,
  },
  glass: {
    hint: "Lean the clear sheet over the screen. Pair your laptop to control it by hand.",
    steps: `<li>Lay this phone or iPad flat, screen up, brightness high, with the bottom edge of the screen towards you. Lock screen rotation first.</li>
      <li>Lean a clear acrylic sheet (or a glass photo frame without its back) over it at about <b>45°</b>: bottom edge on the far side of the screen, top edge rising towards you.</li>
      <li>Dim the room and sit so your eyes are level with the sheet. The page stands in the air behind it.</li>
      <li>On your laptop open <b>airpane.anchit-tandon.com/control</b> and type the code shown here. Point at the webcam to move the cursor, pinch to click, pinch and move up or down to scroll.</li>`,
  },
};
function showHelp() {
  $("help-steps").innerHTML = (HELP[view] || HELP.pyramid).steps;
  helpEl.hidden = false; $("pyr-help-ok").focus();
}
function hideHelp() {
  helpEl.hidden = true;
  try { localStorage.setItem("airpane-help-" + view, "1"); } catch {}
  hint((HELP[view] || HELP.pyramid).hint, 5000);
  pokeUI();
}

// ---------- glass: pairing with the laptop controller ----------
let glassScale = 1;
function glassSize(f) {
  glassScale = Math.max(0.6, Math.min(2.2, glassScale * f));
  glass.el.content.style.setProperty("--gs", glassScale.toFixed(3));
}
async function startLink() {
  if (link || linkStarting) { pairEl.hidden = Boolean(link && link.peers); return; }
  linkStarting = true;
  $("glass-code").textContent = "....";
  pairEl.hidden = false;
  try {
    link = await host({
      onCode: (c) => { $("glass-code").textContent = c; },
      onPeers: (n) => {
        link.peers = n;
        pairEl.hidden = n > 0 || view !== "glass";
        pairBtn.hidden = n > 0;
        if (n > 0) { hint("Laptop connected. Point to move, pinch to click.", 4000); link.broadcast({ t: "state", ...glass.state }); }
        else glass.hideCursor();
      },
      onMessage: (m, reply) => onRemote(m, reply),
    });
    link.peers = 0;
  } catch (e) {
    $("glass-code").textContent = "----";
    $("glass-pair-note").textContent = "Pairing is unavailable right now. You can still tap links on this screen.";
  }
  linkStarting = false;
}
function onRemote(m, reply) {
  if (!m || typeof m !== "object" || view !== "glass") return;
  if (m.t === "cur") glass.cursor(+m.x, +m.y);
  else if (m.t === "lost") glass.hideCursor();
  else if (m.t === "click") glass.click(+m.x, +m.y);
  else if (m.t === "scroll") glass.scroll(Math.max(-2, Math.min(2, +m.dy || 0)));
  else if (m.t === "back") glass.back();
  else if (m.t === "load" && typeof m.url === "string") loadURL(m.url);
  else if (m.t === "size") glassSize(m.up ? 1.1 : 0.9);
  else if (m.t === "hello") reply({ t: "state", ...glass.state });
}
// Direct touch on the display still works: tap a link, drag to scroll.
function wireGlassTouch() {
  const el = $("glass");
  let down = null;
  el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, last: e.clientY, moved: false }; });
  el.addEventListener("pointermove", (e) => {
    if (!down) return;
    if (Math.abs(e.clientY - down.y) > 8) down.moved = true;
    if (down.moved) { glass.dragBy(e.clientY - down.last); down.last = e.clientY; }
  });
  el.addEventListener("pointerup", (e) => { if (down && !down.moved) glass.tapAt(e.clientX, e.clientY); down = null; });
  el.addEventListener("pointercancel", () => { down = null; });
}
// Controls reflect into the pyramid too, so they fade away when not in use.
let uiTimer;
function pokeUI() {
  ar.classList.remove("ui-hidden");
  clearTimeout(uiTimer);
  if (!FLOAT(view)) return;
  uiTimer = setTimeout(() => {
    if (FLOAT(view) && helpEl.hidden && !ar.contains(document.activeElement)) ar.classList.add("ui-hidden");
  }, 5000);
}
function goFullscreen() {
  const el = document.documentElement;
  try { const p = el.requestFullscreen && el.requestFullscreen({ navigationUI: "hide" }); if (p && p.catch) p.catch(() => {}); } catch {}
}
let wake = null;
async function keepAwake(on) {
  try {
    if (on && !wake && navigator.wakeLock) wake = await navigator.wakeLock.request("screen");
    if (!on && wake) { await wake.release(); wake = null; }
  } catch { wake = null; }
}

function exitAR() {
  running = false;
  if (holo) holo.stop();
  if (pyr) pyr.stop();
  if (glass) { glass.stop(); glass.hideCursor(); }
  if (link) { link.close(); link = null; }
  pairEl.hidden = true;
  keepAwake(false);
  clearTimeout(uiTimer);
  helpEl.hidden = true;
  try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); } catch {}
  ar.classList.remove("holo", "pyr", "glassv", "ui-hidden");
  removeEventListener("deviceorientation", onOrientation);
  stopCamera();
  destroyCloud();
  if (iframe) iframe.src = "about:blank";
  current = "";
  ar.hidden = true;
  landing.hidden = false;
}

addEventListener("popstate", (e) => {
  const s = e.state;
  if (!running) return;
  if (!s || !s.ar) return exitAR();
  if (s.url && s.url !== current) loadURL(s.url, { push: false });
});

// ---------- wiring ----------
$("launch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  enterAR(launchInput.value || "https://en.m.wikipedia.org/wiki/Augmented_reality");
});
document.querySelectorAll("#landing .chip").forEach((b) =>
  b.addEventListener("click", () => { launchInput.value = b.dataset.url; enterAR(b.dataset.url); })
);
$("url-form").addEventListener("submit", (e) => { e.preventDefault(); loadURL(urlInput.value); });
$("exit-btn").addEventListener("click", () => { exitAR(); history.replaceState(null, ""); });
$("back-btn").addEventListener("click", () => history.back());
$("zoom-in").addEventListener("click", () => zoom(0.85));
$("zoom-out").addEventListener("click", () => zoom(1.18));
viewBtn.addEventListener("click", switchView);
$("help-btn").addEventListener("click", showHelp);
pairBtn.addEventListener("click", () => { pairEl.hidden = false; pokeUI(); });
$("pyr-help-ok").addEventListener("click", hideHelp);
darkBtn.addEventListener("click", () => {
  const on = !pyr.state.dark;
  pyr.setDark(on);
  darkBtn.textContent = on ? "Glow: on" : "Glow: off";
  darkBtn.setAttribute("aria-pressed", String(on));
});
ar.addEventListener("pointerdown", pokeUI);
ar.addEventListener("focusin", pokeUI);
addEventListener("keydown", (e) => { if (e.key === "Escape" && !helpEl.hidden) hideHelp(); });
$("recenter-btn").addEventListener("click", () => { if (view === "holo") return holo.recenter(); if (!gyro.active) { look.yaw = 0; look.pitch = 0; camQ = quat(); } placePanel(); });

// Test hook (no effect for users).
window.__airpane = { normalizeInput, get state() { return { running, placed, dist, gyro: gyro.active, current, mode: modeChip.textContent, view, holo: holo && holo.state, pyr: pyr && pyr.state, glass: glass && glass.state, code: link ? link.code : null, peers: link ? link.peers : 0, uiHidden: ar.classList.contains("ui-hidden") }; } };
