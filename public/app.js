import {
  deg, clamp, quat, quatFromEulerYXZ, quatNlerp, rotate, deviceQuat,
  scale, norm, matFacing, applyMat, viewMatrix, cameraCSS, objectCSS,
} from "./math3d.js";
import { createHolo } from "./holo.js";
import { createPyramid } from "./pyramid.js";
import { createGlass } from "./glass.js";
import { createHandTracker } from "./handtrack.js";
import { gestureKind } from "./gestures.js";
import { host, cleanCode } from "./link.js";
import { createCaster, deviceName } from "./cast.js";

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
// Pairing with another device is only for links that ask for it (?pair=CODE from the
// laptop's QR code, or ?peer=host for tests). Otherwise PeerJS is never loaded: it is not
// needed on a single device, and its Safari shim interfered with the camera.
const PAIRING = (() => { const q = new URLSearchParams(location.search); return q.has("pair") || q.has("peer"); })();
let view = "room", holo = null, pyr = null, glass = null, link = null, linkStarting = false;
// Hologram on a laptop with no phone: the real page floats in the 3D room and the same
// webcam reads both the head (depth) and the hand (cursor, click, scroll, back, forward).
let handMode = false, holoGlass = null, holoHost = null, hands = null;
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
// The browser's own getUserMedia, kept before anything else can wrap it: PeerJS brings
// webrtc-adapter, which on Safari replaces getUserMedia with a shim that rewrites the
// camera constraints and can make Safari refuse them ("OverconstrainedError").
const nativeGUM = navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null;
async function startCamera(facing = "environment") {
  try {
    const small = facing === "user";
    if (!nativeGUM) throw new Error("no camera API");
    stream = await nativeGUM({
      video: { facingMode: { ideal: facing }, width: { ideal: small ? 640 : 1280 }, height: { ideal: small ? 480 : 720 } },
      audio: false,
    });
    cam.srcObject = stream;
    await playCam();
    ar.classList.remove("no-cam");
    return true;
  } catch {
    ar.classList.add("no-cam");
    return false;
  }
}
// Safari (Low Power Mode especially) can refuse to start the camera video without a tap:
// then the next tap anywhere starts it.
async function playCam() {
  try { await cam.play(); return true; }
  catch {
    toast("Tap the screen once to start the camera.", 6000);
    const go = () => { cam.play().then(() => removeEventListener("pointerdown", go, true)).catch(() => {}); };
    addEventListener("pointerdown", go, true);
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
  if (view === "holo" && holoGlass) { setMode("direct"); showState(""); holoGlass.load(url); return; }
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
  handMode = mode === "hologram";
  view = mode === "pyramid" || mode === "glass" ? mode : handMode ? "holo" : pickView();
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
  viewBtn.dataset.short = { glass: "Glass", pyramid: "Pyramid", holo: "Hologram", room: "Room" }[view] || LABEL[view];
  viewBtn.setAttribute("aria-label", "3D view: " + viewBtn.textContent + ". Switch view");
  trackEl.hidden = true;
  stage.style.perspectiveOrigin = "";
  placePanel();
  if (view !== "holo") unmountHoloGlass();
  if (view !== "glass") stopSelfGlass();
  if (FLOAT(view)) {
    holo.stop();
    ar.classList.remove("no-cam");
    keepAwake(true);
    if (view === "pyramid") { glass.stop(); pairEl.hidden = true; pyr.start(); if (current) pyr.show(current); }
    else {
      pyr.stop(); glass.start(); if (PAIRING) startLink();
      startSelfGlass(); // hand control from this device's own camera
      let flip = "1";
      try { flip = localStorage.getItem("airpane-flip") ?? "1"; } catch {}
      setFlip(flip !== "0");
    }
    let seen = false;
    try { seen = localStorage.getItem("airpane-help-" + view) === "1"; } catch {}
    if (!seen) showHelp(); else hint((HELP[helpKey()] || HELP[view]).hint, 5000);
    pokeUI();
    return;
  }
  pyr.stop();
  glass.stop();
  pairEl.hidden = true;
  keepAwake(false);
  if (view === "holo") {
    holo.start();
    if (handMode) mountHoloGlass(camOk); else unmountHoloGlass();
    hint(handMode ? (camOk ? "Move your head to see the depth. Hold up an open hand to move the cursor, make a fist to click." : "Camera is off: use the mouse on the floating page.")
      : camOk ? "Move your head. The page floats in front of your screen." : "Move the mouse to look around the page in 3D.", 6000);
    if (!camOk) toast("Camera is off, so head tracking is off. Using the mouse instead.");
  } else {
    holo.stop();
    if (!camOk) toast("Camera is off. Showing a virtual room instead.");
    setTimeout(() => { if (view === "room" && !gyro.active) hint("Drag the background to look around."); }, 1200);
  }
}

function mountHoloGlass(camOk) {
  if (!holoGlass) {
    holoHost = document.createElement("div");
    holoHost.className = "glass holo-glass";
    panelEl.append(holoHost);
    holoGlass = createGlass(holoHost, { onState: (st) => { if (view === "holo" && st.title) setStatus(st.title); } });
    holoGlass.setFlip(false);
    // Mouse / trackpad on the floating page: offsetX / offsetY are measured on the page
    // itself, so they stay right however the 3D view turns it.
    const pt = (e) => ({ x: Math.min(1, Math.max(0, e.offsetX / e.target.clientWidth)), y: Math.min(1, Math.max(0, e.offsetY / e.target.clientHeight)) });
    holoHost.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" && e.target.classList.contains("g-touch")) { const p = pt(e); holoGlass.cursor(p.x, p.y); } });
    holoHost.addEventListener("pointerleave", () => holoGlass && holoGlass.hideCursor());
    const fling = wireFling(holoHost, () => holoGlass);
    holoHost.addEventListener("click", (e) => { if (e.target.classList.contains("g-touch") && !fling.recent()) { const p = pt(e); holoGlass.click(p.x, p.y); } });
    holoHost.addEventListener("wheel", (e) => { e.preventDefault(); holoGlass.scroll(e.deltaY / 900); }, { passive: false });
  }
  frameHost.hidden = true;
  holoGlass.start();
  $("holo-guide").hidden = false;
  $("holo-hand").textContent = camOk ? "Show your hand to the camera" : "Camera is off: use the mouse on the page";
  if (camOk) startHands();
}
function unmountHoloGlass() {
  if (hands) hands.stop();
  $("holo-guide").hidden = true;
  clearInterval(guideTimer);
  if (!holoGlass) { if (frameHost) frameHost.hidden = false; return; }
  holoGlass.stop(); holoHost.remove(); holoGlass = null; holoHost = null;
  frameHost.hidden = false;
}
let handHinted = false, guideTimer = 0, selfGlass = false;
// What this device's own hand tracking controls: the Hologram's page, or (laptop with a
// clear sheet) the Floating glass page.
// (A paired controller takes over the Floating glass, so the two never fight.)
const handTarget = () => (view === "holo" && holoGlass ? holoGlass : view === "glass" && selfGlass && !(link && link.peers) ? glass : null);
// Floating glass: this device's own camera gives hand control (laptop webcam or phone front camera).
$("holo-guide").addEventListener("click", (e) => { e.stopPropagation(); $("holo-guide").classList.toggle("mini"); });
async function startSelfGlass() {
  selfGlass = true;
  // on a small screen the guide folds away after a few seconds; tap it to bring it back
  $("holo-guide").classList.remove("mini");
  if (innerWidth < 700) setTimeout(() => { if (selfGlass) $("holo-guide").classList.add("mini"); }, 8000);
  pairEl.hidden = true; pairBtn.hidden = true;
  $("holo-guide").hidden = false;
  $("holo-hand").textContent = "Starting the camera";
  // a camera that is briefly busy (or slow to answer) gets one more try before giving up
  let ok = await startCamera("user");
  if (!ok && view === "glass" && selfGlass) { await new Promise((r) => setTimeout(r, 1200)); ok = await startCamera("user"); }
  if (view !== "glass" || !selfGlass) { stopCamera(); return; }
  if (!ok) {
    // still no camera: the next tap asks again (Safari may need the tap to show its prompt)
    $("holo-hand").textContent = "Camera is off: tap the screen to try again, or tap links directly";
    const retry = async () => { removeEventListener("pointerdown", retry, true); if (view === "glass" && selfGlass && !cam.srcObject && (await startCamera("user"))) startHands(); };
    addEventListener("pointerdown", retry, true);
    return;
  }
  startHands();
}
function stopSelfGlass() {
  if (!selfGlass) return;
  selfGlass = false;
  if (hands) hands.stop();
  clearInterval(guideTimer);
  $("holo-guide").hidden = true;
}
function onHandEvent(ev) {
  const g = handTarget();
  if (!g) return;
  if (!handHinted) { handHinted = true; hint("Hand seen. Open hand moves, a fist clicks, point up or down to scroll, point left or right for back or forward, pinch and swing to throw.", 5000); }
  // the page is on the other screen: the hand drives it there
  if (remote && cast && cast.connected && /^(cur|click|scroll|back|forward|lost)$/.test(ev.t)) {
    cast.send(ev.t === "cur" || ev.t === "click" ? { t: ev.t, x: ev.x, y: ev.y } : ev.t === "scroll" ? { t: "scroll", dy: ev.dy } : { t: ev.t });
    if (ev.t === "click") hint("Click on the screen", 900);
    else if (ev.t === "back" || ev.t === "forward") hint((ev.t === "back" ? "Back" : "Forward") + " on the screen", 900);
    if (ev.t === "cur") g.hideCursor();
    return;
  }
  if (ev.t === "cur") g.cursor(ev.x, ev.y);
  else if (ev.t === "click") { g.click(ev.x, ev.y); hint("Click", 900); }
  else if (ev.t === "scroll") g.scroll(ev.dy);
  else if (ev.t === "back") { g.back(); hint("Back", 900); }
  else if (ev.t === "forward") { g.forward(); hint("Forward", 900); }
  else if (ev.t === "lost") g.hideCursor();
  // pinch and throw
  else if (ev.t === "grab") { g.grab(ev.x, ev.y); hint("Got it. Swing your hand and let go to throw it.", 2500); }
  else if (ev.t === "hold") g.hold(ev.x, ev.y);
  else if (ev.t === "throw") throwPage(g, ev.vx, ev.vy);
  else if (ev.t === "drop") g.drop();
}
async function startHands() {
  hands = hands || createHandTracker(cam, onHandEvent);
  $("holo-hand").textContent = "Starting hand tracking";
  const ok = await hands.start();
  if (!ok) { toast("Hand tracking could not load. Use the mouse on the floating page."); $("holo-hand").textContent = "Hand tracking unavailable: use the mouse"; return; }
  // keep the guide live: light up the line for the shape the camera sees now
  let last = null;
  clearInterval(guideTimer);
  let diagAt = 0, diagFrames = 0;
  guideTimer = setInterval(() => {
    if (!hands || !handTarget()) return;
    const st = hands.state, k = st.hand ? gestureKind(st.pose, st.dir) : "";
    // a small live readout, so a phone that can't track says why
    const now = performance.now();
    if (now - diagAt >= 1000) {
      const fps = diagAt ? Math.round(((st.frames - diagFrames) * 1000) / (now - diagAt)) : 0;
      diagAt = now; diagFrames = st.frames;
      $("holo-diag").textContent = !cam.srcObject ? "Camera off" : cam.paused || !cam.videoWidth ? "Camera starting (tap the screen if it stays like this)"
        : `Camera ${cam.videoWidth}x${cam.videoHeight} · ${st.ready ? "tracking " + st.delegate + " · " + fps + " fps" : "loading hand tracking"} · ${st.hand ? "hand seen" : "no hand"}`;
    }
    if (st.error) { if (last !== "error") { last = "error"; $("holo-hand").textContent = st.error + ". Tap the page instead."; } return; }
    if (k === last) return;
    last = k;
    for (const li of document.querySelectorAll("#holo-guide li[data-g]")) li.classList.toggle("on", Boolean(k) && li.dataset.g.split(" ").includes(k));
    $("holo-hand").textContent = !st.hand ? "Show your hand to the camera" : st.dir === "up" || st.dir === "down" ? "Pointing " + st.dir + ": scrolling" : st.dir ? "Pointing " + st.dir + ": " + (st.dir === "left" ? "back" : "forward") : "Hand seen";
  }, 150);
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
const helpEl = $("pyr-help"), darkBtn = $("dark-btn"), pairEl = $("glass-pair"), pairBtn = $("pair-btn"), flipBtn = $("flip-btn");
// Floating glass draws the page upside down so the sheet's reflection reads right.
// Without a sheet (reading straight off a phone) it can be shown the right way up.
function setFlip(on) {
  glass.setFlip(on);
  ar.classList.toggle("sheet", on); // the gesture guide is drawn to read right in the sheet too
  flipBtn.textContent = "For clear sheet: " + (on ? "on" : "off");
  flipBtn.dataset.short = "Sheet: " + (on ? "on" : "off");
  flipBtn.setAttribute("aria-pressed", String(on));
  try { localStorage.setItem("airpane-flip", on ? "1" : "0"); } catch {}
  if (link) link.broadcast({ t: "state", ...glass.state });
}
const HELP = {
  pyramid: {
    hint: "Stand the pyramid on the + mark. Tap the screen for controls.",
    steps: `<li>Cut 4 trapezoids from clear plastic: <b>6 cm</b> wide at the bottom, <b>1 cm</b> at the top, <b>3.5 cm</b> tall. <a href="/pyramid-template.html" target="_blank" rel="noopener">Printable template</a></li>
      <li>Tape the long edges together into a pyramid.</li>
      <li>Lay the phone flat, screen up, brightness high.</li>
      <li>Stand the pyramid upside down, small end on the <b>+</b> mark.</li>
      <li>Dim the room and look from the side, level with the phone. The page floats inside.</li>`,
  },
  glassLaptop: {
    hint: "Hold the clear sheet over the screen. Your hand controls it through this laptop's camera.",
    steps: `<li>Tilt this laptop's screen back as far as it goes (flat is best), brightness up, and set the laptop at about chest height.</li>
      <li>Hold a clear sheet (clear plastic folder, CD case lid, photo-frame glass) over the screen: its lower edge just above the top of the screen, rising toward you.</li>
      <li>Angle of the sheet from flat: screen folded flat <b>45°</b>, opened to 150° about <b>30°</b>, opened to 135° (most MacBooks) about <b>22°</b>. If the screen can't fold flat, the sheet needs to be about twice the screen's height.</li>
      <li>Dim the room and look through the sheet with your eyes level with it. The page stands in the air behind the sheet.</li>
      <li>Control it by hand with this laptop's camera: open hand moves the cursor, a fist clicks, point your index finger up or down to scroll (it keeps scrolling while you point), point it left or right to go back or forward. Pinch the page (thumb and index finger touching), swing your hand and let go to throw it out into the air.</li>`,
  },
  glass: {
    hint: "Lean the clear sheet over the screen. Show your hand to the camera to control it.",
    steps: `<li>Lay this phone or iPad flat, screen up, brightness high, bottom edge towards you. Lock screen rotation first.</li>
      <li>Hold or lean something clear over it at about <b>45°</b>: bottom edge on the far side of the screen, top edge rising towards you. A clear plastic folder, a CD case lid or a photo-frame glass all work.</li>
      <li>Dim the room and look through the sheet with your eyes level with it. The page stands in the air behind the sheet.</li>
      <li>Control it by hand with this device's front camera: hold your hand where the camera can see it. Open hand moves the cursor, a fist clicks, point your index finger up or down to scroll (it keeps scrolling while you point), point it left or right to go back or forward. Pinch the page (thumb and index finger touching), swing your hand and let go to throw it out into the air. You can also just tap the page.</li>`,
  },
};
const helpKey = () => (view === "glass" && isLaptop() ? "glassLaptop" : view);
function showHelp() {
  $("help-steps").innerHTML = (HELP[helpKey()] || HELP.pyramid).steps;
  $("help-noflip").hidden = view !== "glass";
  $("help-art").hidden = !(view === "glass" && !isLaptop());
  $("help-art-laptop").hidden = !(view === "glass" && isLaptop());
  helpEl.hidden = false; $("pyr-help-ok").focus();
}
function hideHelp() {
  helpEl.hidden = true;
  try { localStorage.setItem("airpane-help-" + view, "1"); } catch {}
  hint((HELP[helpKey()] || HELP.pyramid).hint, 5000);
  pokeUI();
}

// ---------- glass: pairing with the laptop controller ----------
let glassScale = 1;
function glassSize(f) {
  glassScale = Math.max(0.6, Math.min(2.2, glassScale * f));
  glass.setScale(glassScale);
}
async function startLink() {
  if (link || linkStarting) { pairEl.hidden = Boolean(link && link.peers); return; }
  linkStarting = true;
  $("glass-code").textContent = "....";
  try {
    link = await host({
      code: pairCode,
      onCode: (c) => {
        $("glass-code").textContent = c;
        // Opened from the laptop's QR code: the laptop is already waiting for this code.
        if (pairCode && c === pairCode) $("glass-pair-note").textContent = "Connecting to your laptop...";
        pairCode = "";
        const q = new URLSearchParams(location.search);
        if (q.has("pair")) { q.delete("pair"); const qs = q.toString(); history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "")); }
      },
      onPeers: (n) => {
        link.peers = n;
        pairEl.hidden = true; pairBtn.hidden = true;
        // a paired controller takes over: pause this laptop's own hand tracking meanwhile
        if (selfGlass && hands) { if (n > 0) hands.stop(); else startHands(); }
        if (selfGlass) $("holo-hand").textContent = n > 0 ? "Controlled from another laptop" : "Show your hand to the camera";
        if (n > 0) { hint("Laptop connected. Open hand to move, fist to click.", 4000); link.broadcast({ t: "state", ...glass.state }); }
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
  else if (m.t === "forward") glass.forward();
  else if (m.t === "grab") glass.grab(+m.x || 0.5, +m.y || 0.5);
  else if (m.t === "hold") glass.hold(+m.x || 0.5, +m.y || 0.5);
  else if (m.t === "throw") throwPage(glass, Math.max(-9, Math.min(9, +m.vx || 0)), Math.max(-9, Math.min(9, +m.vy || -1)));
  else if (m.t === "drop") glass.drop();
  else if (m.t === "load" && typeof m.url === "string") loadURL(m.url);
  else if (m.t === "size") glassSize(m.up ? 1.1 : 0.9);
  else if (m.t === "hello") reply({ t: "state", ...glass.state });
}
// Direct touch on the display still works: tap a link, drag to scroll, press and hold to
// pick the page up and flick it to throw it.
function wireGlassTouch() {
  const el = $("glass");
  const fling = wireFling(el, () => (view === "glass" ? glass : null));
  let down = null;
  el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, last: e.clientY, moved: false }; });
  el.addEventListener("pointermove", (e) => {
    if (!down || fling.held) return;
    if (Math.abs(e.clientY - down.y) > 8) down.moved = true;
    if (down.moved) { glass.dragBy(e.clientY - down.last); down.last = e.clientY; }
  });
  el.addEventListener("pointerup", (e) => { if (down && !down.moved && !fling.recent()) glass.tapAt(e.clientX, e.clientY); down = null; });
  el.addEventListener("pointercancel", () => { down = null; });
}
// Controls reflect into the pyramid too, so they fade away when not in use.
let uiTimer;
function pokeUI() {
  ar.classList.remove("ui-hidden");
  clearTimeout(uiTimer);
  if (!FLOAT(view)) return;
  uiTimer = setTimeout(() => {
    if (FLOAT(view) && helpEl.hidden && castSheet.hidden && !ar.contains(document.activeElement)) ar.classList.add("ui-hidden");
  }, 5000);
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
  unmountHoloGlass();
  stopSelfGlass();
  if (pyr) pyr.stop();
  if (glass) { glass.stop(); glass.hideCursor(); }
  if (link) { link.close(); link = null; }
  pairEl.hidden = true;
  castSheet.hidden = true; setRemote(false);
  keepAwake(false);
  clearTimeout(uiTimer);
  helpEl.hidden = true;
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

// ---------- throw the page onto another screen ----------
// A TV, laptop or tablet opens /catch and shows a code. Once this device is connected to it,
// throwing the page (pinch, swing, let go; or press, hold and flick) sends it there: it flies
// off this screen and lands on that one. The hand, or the bar above the dock, then scrolls and
// clicks on the screen; "Bring back" pulls the page back here.
const ME = deviceName(navigator.userAgent);
const castSheet = $("cast-sheet"), castBtn = $("cast-btn"), castBar = $("cast-bar"), castCode = $("cast-code"), castErr = $("cast-err");
let cast = null, remote = false, castTitle = "", castTipShown = false, recallAt = -1e9, wasAllowed = false;
$("cast-site").textContent = location.host + "/catch";
function caster() {
  cast = cast || createCaster({ onChange: renderCast, onMessage: onScreen });
  return cast;
}
function renderCast(st = cast ? cast.state : {}) {
  // a screen that never let this phone in (someone pressed Don't allow, or nobody answered)
  if (!st.connected && cast && cast.askedOnce && !wasAllowed) toast("The screen did not let this phone in.", 5000);
  if (cast) cast.askedOnce = st.connected && !st.allowed ? true : st.connected ? cast.askedOnce : false;
  wasAllowed = Boolean(st.connected && st.allowed);
  $("cast-off").hidden = Boolean(st.connected);
  $("cast-on").hidden = !st.connected;
  $("cast-name").textContent = st.name || "the screen";
  $("cast-wait").hidden = !st.connected || Boolean(st.allowed);
  $("cast-how").hidden = $("cast-send").hidden = !st.allowed;
  $("cast-present").hidden = !st.presentAvailable || Boolean(st.connected);
  $("cast-go").disabled = Boolean(st.connecting);
  $("cast-go").textContent = st.connecting ? "Connecting" : "Connect";
  castBtn.classList.toggle("on", Boolean(st.connected));
  castBtn.setAttribute("aria-label", st.connected ? "Connected to " + (st.name || "a screen") + ". Throw to another screen" : "Throw to another screen");
  $("pinch-what").textContent = st.connected ? "throw the page to the screen" : "throw the page into the air";
  if (!st.connected) setRemote(false);
}
function onScreen(m) {
  if (m.t === "state") {
    castTitle = m.title || (m.url ? new URL(m.url).host : "");
    $("cast-bar-title").textContent = "On the screen: " + (m.loading ? "opening..." : castTitle || "a page");
    // a video plays by itself on the screen: no scrolling there, just sound
    castBar.classList.toggle("video", m.video);
  }
  else if (m.t === "screen" && m.allowed && remote === false && $("cast-banner").dataset.waiting) { $("cast-banner").dataset.waiting = ""; bannerConnected(); }
  // only when this phone asked for it: a screen can't push pages onto the phone
  else if (m.t === "page" && performance.now() - recallAt < 10000) { recallAt = -1e9; bringBack(m); }
}
function setRemote(on) {
  remote = Boolean(on);
  castBar.hidden = !remote;
  ar.classList.toggle("casting", remote);
  document.body.classList.toggle("casting", remote);
  if (remote) pokeUI();
}
// The page this device's gestures and touches act on (the Floating glass or the Hologram's page).
const pageTarget = () => (view === "glass" ? glass : view === "holo" && holoGlass ? holoGlass : null);
function pageNow() {
  const g = pageTarget();
  if (g) { const st = g.state; return st.url && !st.error ? { url: st.url, title: st.title, pos: st.pos } : null; }
  return current ? { url: current, title: statusEl.textContent || "", pos: 0 } : null;
}
// Send the page to the connected screen. g: the page to animate flying off (if any).
function castPage(g, vx = 0, vy = -2) {
  const p = pageNow();
  if (!p) { if (g) g.drop(); toast("Open a page first, then throw it."); return false; }
  if (!cast.state.allowed) { if (g) g.drop(); toast("Press Allow on the screen first, then throw again.", 4500); return false; }
  if (!cast.send({ t: "cast", url: p.url, title: p.title, pos: p.pos, from: ME, vx, vy })) {
    if (g) g.drop(); setRemote(false);
    toast("The screen is not answering. Tap Cast to connect again.", 5000);
    return false;
  }
  if (g) g.throw(vx, vy, { away: true });
  castTitle = p.title;
  $("cast-bar-title").textContent = "On the screen: " + (p.title || "a page");
  setRemote(true);
  hint("Thrown to " + (cast.state.name || "the screen") + (hands && hands.state.ready ? ". Your hand now scrolls and clicks there." : ". Scroll it from the bar below."), 3500);
  return true;
}
// Every throw: to the connected screen, or (no screen) into the air on this device.
function throwPage(g, vx, vy) {
  if (cast && cast.connected) return castPage(g, vx, vy);
  g.throw(vx, vy);
  hint("Thrown into the air", 1200);
  if (!castTipShown) { castTipShown = true; setTimeout(() => toast("Tip: connect a TV or laptop with the Cast button and the page lands there when you throw it.", 5000), 1300); }
}
async function bringBack(m) {
  setRemote(false);
  const g = pageTarget();
  current = m.url; urlInput.value = m.url;
  if (!g) { loadURL(m.url); hint("Back from the screen", 1800); return; }
  g.land(0, 2);
  hint("Back from the screen", 1800);
  await g.load(m.url);
  g.scrollToPos(m.pos);
}
// Press and hold the page to pick it up, then flick it and let go to throw it.
function wireFling(el, getG) {
  let f = null, flungAt = 0;
  const stop = () => { if (f) clearTimeout(f.timer); };
  el.addEventListener("pointerdown", (e) => {
    const g = getG();
    if (!g || (e.pointerType === "mouse" && e.button !== 0) || !e.isPrimary) return;
    stop();
    f = { x: e.clientX, y: e.clientY, held: false, trail: [], g, id: e.pointerId };
    // a mouse holds a little longer, so an ordinary slow click stays a click
    f.timer = setTimeout(() => {
      if (!f) return;
      f.held = true;
      try { el.setPointerCapture(f.id); } catch {}
      const p = g.viewXY(f.x, f.y);
      g.grab(p.x, p.y);
      f.start = p;
      f.trail.push({ ...p, t: performance.now() });
      try { navigator.vibrate && navigator.vibrate(12); } catch {}
      hint(cast && cast.connected ? "Flick it towards the screen and let go" : "Flick it and let go to throw it into the air", 1800);
    }, e.pointerType === "mouse" ? 550 : 380);
  });
  el.addEventListener("pointermove", (e) => {
    if (!f || e.pointerId !== f.id) return;
    // moving before the hold completes is a scroll (the same 8px the drag uses), not a pick-up
    if (!f.held) { if (Math.hypot(e.clientX - f.x, e.clientY - f.y) > 8) { stop(); f = null; } return; }
    const p = f.g.viewXY(e.clientX, e.clientY), t = performance.now();
    f.g.hold(p.x, p.y);
    f.trail.push({ ...p, t });
    while (f.trail.length > 2 && t - f.trail[0].t > 140) f.trail.shift();
  });
  const up = (e, cancelled) => {
    if (!f || e.pointerId !== f.id) return;
    stop();
    const fl = f; f = null;
    if (!fl.held) return;
    flungAt = performance.now();
    const a = fl.trail[0], b = fl.trail[fl.trail.length - 1], dt = a && b ? (b.t - a.t) / 1000 : 0;
    let vx = dt > 0.01 ? (b.x - a.x) / dt : 0, vy = dt > 0.01 ? (b.y - a.y) / dt : 0;
    // a quick flick throws; so does a slow drag that carries the card a long way
    const dx = b.x - fl.start.x, dy = b.y - fl.start.y, far = Math.hypot(dx, dy);
    if (Math.hypot(vx, vy) <= 1.2 && far >= 0.25) { vx = (dx / far) * 2; vy = (dy / far) * 2; }
    if (!cancelled && Math.hypot(vx, vy) > 1.2) throwPage(fl.g, vx, vy); else fl.g.drop();
  };
  el.addEventListener("pointerup", (e) => up(e, false));
  el.addEventListener("pointercancel", (e) => up(e, true));
  return { get held() { return Boolean(f && f.held); }, recent: () => performance.now() - flungAt < 450 };
}
function openCast() {
  caster();
  // a phone scans the screen's QR code; a laptop types the code
  $("cast-step2").textContent = isLaptop() ? "Type the code it shows:" : "Scan the QR code it shows with this " + (/phone/i.test(ME) ? "phone" : "device") + "'s camera, or type its code here:";
  renderCast();
  castErr.hidden = true;
  if (!cast.connected && !castCode.value) castCode.value = cast.lastCode();
  castSheet.hidden = false;
  (cast.connected ? $("cast-send") : castCode).focus();
}
function closeCast() { castSheet.hidden = true; pokeUI(); }
async function connectScreen(code, key = "") {
  castErr.hidden = true;
  try { await caster().connectCode(code, key); return true; }
  catch (e) { castErr.textContent = e.message || "Could not connect to the screen."; castErr.hidden = false; return false; }
}
castBtn.addEventListener("click", openCast);
$("cast-close").addEventListener("click", closeCast);
castSheet.addEventListener("click", (e) => { if (e.target === castSheet) closeCast(); });
castCode.addEventListener("input", () => { castCode.value = cleanCode(castCode.value); });
$("cast-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await connectScreen(castCode.value)) hint("Connected. Throw the page at the screen.", 3500);
});
$("cast-present").addEventListener("click", async () => {
  castErr.hidden = true;
  try { await caster().connectPresentation(); hint("Connected. Throw the page at the screen.", 3500); }
  catch (e) { if (e && e.name !== "AbortError" && e.name !== "NotAllowedError") { castErr.textContent = e.message || "Could not start casting."; castErr.hidden = false; } }
});
$("cast-send").addEventListener("click", () => {
  closeCast();
  const g = pageTarget();
  // the same flight as a thrown page: picked up in the middle, sent up and away
  if (g) { g.grab(0.5, 0.55); setTimeout(() => castPage(g, 0, -3), 160); }
  else castPage(null);
});
$("cast-stop").addEventListener("click", () => { cast.askedOnce = false; cast.disconnect(); closeCast(); });
$("cast-up").addEventListener("click", () => cast && cast.send({ t: "scroll", dy: -0.6 }));
$("cast-down").addEventListener("click", () => cast && cast.send({ t: "scroll", dy: 0.6 }));
$("cast-back").addEventListener("click", () => cast && cast.send({ t: "back" }));
$("cast-recall").addEventListener("click", () => { if (cast && cast.send({ t: "recall" })) recallAt = performance.now(); });
$("cast-sound").addEventListener("click", () => cast && cast.send({ t: "play" }));
$("cast-done").addEventListener("click", () => setRemote(false));

// Opened from the QR code on a screen (/?cast=CODE&k=SECRET): connect to it straight away.
// The banner names the screen and can disconnect, in case the link came from someone else.
function bannerConnected() {
  const banner = $("cast-banner"), st = cast.state;
  banner.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = st.allowed ? "Connected to " + (st.name || "the screen") + ". Open a site, then pinch it and swing it towards the screen, or press, hold and flick it." : "Connected. Press Allow on the screen to let this phone in.";
  const stop = document.createElement("button");
  stop.type = "button"; stop.className = "chip"; stop.textContent = "Not my screen: disconnect";
  stop.addEventListener("click", () => { cast.askedOnce = false; cast.disconnect(); banner.hidden = true; });
  banner.append(text, stop);
}
{
  const q = new URLSearchParams(location.search), code = cleanCode(q.get("cast") || ""), key = (q.get("k") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  if (code.length === 4) {
    const banner = $("cast-banner");
    banner.textContent = "Connecting to the screen...";
    banner.hidden = false;
    connectScreen(code, key).then((ok) => {
      if (ok) {
        banner.dataset.waiting = cast.state.allowed ? "" : "1";
        bannerConnected();
        q.delete("cast"); q.delete("k");
        const qs = q.toString(); history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : ""));
      } else banner.textContent = "Could not reach the screen " + code + ". Check that it still shows that code, then open a site and tap the Cast button to try again.";
    });
  }
}

// ---------- opened by scanning the laptop's QR code ----------
// airpane.anchit-tandon.com/?pair=ABCD: go straight to the floating glass and pair
// under ABCD, which the laptop is already waiting for. Nothing to type on either side.
let pairCode = cleanCode(new URLSearchParams(location.search).get("pair") || "");
if (pairCode.length === 4) {
  const r = document.querySelector('input[name="mode"][value="glass"]');
  if (r) r.checked = true;
  enterAR(new URLSearchParams(location.search).get("open") || "https://en.m.wikipedia.org/wiki/Augmented_reality");
} else pairCode = "";

// ---------- modes ----------
// Everything runs on the device the site is opened on, with its own camera for hand control.
const modeRadios = [...document.querySelectorAll('input[name="mode"]')];
const isLaptop = () => matchMedia("(pointer: fine)").matches && innerWidth >= 900;
if (!pairCode) {
  let saved = null;
  try { saved = localStorage.getItem("airpane-mode"); } catch {}
  if (saved === "control" || (saved === "hologram" && !isLaptop())) saved = null;
  const r = modeRadios.find((x) => x.value === (saved || "glass"));
  if (r) r.checked = true;
}
// On a laptop, offer the Hologram too; phones keep the camera room.
if (isLaptop()) {
  document.querySelectorAll(".laptop-only").forEach((el) => { el.hidden = false; });
  $("screen-desc").textContent = "The site itself in a 3D room, with mouse control.";
}
modeRadios.forEach((r) => r.addEventListener("change", () => { try { localStorage.setItem("airpane-mode", r.value); } catch {} }));

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
// The pairing card can be tapped away; "Pair laptop" brings it back.
pairEl.addEventListener("click", () => { pairEl.hidden = true; pairBtn.hidden = Boolean(link && link.peers); });
$("pyr-help-ok").addEventListener("click", () => { if (view === "glass") setFlip(true); hideHelp(); });
$("help-noflip").addEventListener("click", () => { setFlip(false); hideHelp(); });
flipBtn.addEventListener("click", () => setFlip(!glass.flipped));
darkBtn.addEventListener("click", () => {
  const on = !pyr.state.dark;
  pyr.setDark(on);
  darkBtn.textContent = on ? "Glow: on" : "Glow: off";
  darkBtn.dataset.short = on ? "Glow" : "No glow";
  darkBtn.setAttribute("aria-pressed", String(on));
});
ar.addEventListener("pointerdown", pokeUI);
ar.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" && ar.classList.contains("ui-hidden")) pokeUI(); });
ar.addEventListener("focusin", pokeUI);
addEventListener("keydown", (e) => { if (e.key === "Escape" && !helpEl.hidden) hideHelp(); if (e.key === "Escape" && !castSheet.hidden) closeCast(); });
$("recenter-btn").addEventListener("click", () => { if (view === "holo") return holo.recenter(); if (!gyro.active) { look.yaw = 0; look.pitch = 0; camQ = quat(); } placePanel(); });

// Test hook (no effect for users).
window.__airpane = { normalizeInput, handEvent: onHandEvent, remoteMessage: (m) => onRemote(m, () => {}), glassLinks: (n) => (glass ? glass.linkPoints(n) : []), get state() { return { running, placed, dist, gyro: gyro.active, current, mode: modeChip.textContent, view, holo: holo && holo.state, pyr: pyr && pyr.state, glass: glass && glass.state, holoGlass: holoGlass && holoGlass.state, hands: hands && hands.state, handMode, cast: cast ? cast.state : null, remote, code: link ? link.code : null, peers: link ? link.peers : 0, uiHidden: ar.classList.contains("ui-hidden") }; } };
