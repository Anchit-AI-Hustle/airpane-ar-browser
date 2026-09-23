import {
  deg, clamp, quat, quatFromEulerYXZ, quatNlerp, rotate, deviceQuat,
  scale, norm, matFacing, applyMat, viewMatrix, cameraCSS, objectCSS,
} from "./math3d.js";

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
  dist = clamp(dist * f, 350, 5000);
  panelPos = scale(norm(panelPos), dist);
}

function loop() {
  if (!running) return;
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
  if (gyro.active || e.target.closest(".panel")) return;
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
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
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
  loadingState("Opening");
  setStatus("Checking " + url.replace(/^https?:\/\//, "").slice(0, 60));

  let check = { frameable: true, finalUrl: url };
  try {
    const r = await fetch("/api/check?url=" + encodeURIComponent(url));
    check = await r.json();
  } catch {}
  if (current !== url) return; // a newer load started

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
  const orientP = requestOrientation(); // must be first call inside the tap on iPhone
  const camP = startCamera();
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
  placePanel();
  addEventListener("deviceorientation", onOrientation);
  requestAnimationFrame(loop);

  if (!camOk) toast("Camera is off. Showing a virtual room instead.");
  setTimeout(() => { if (!gyro.active) hint("Drag the background to look around."); }, 1200);
  history.replaceState({ ar: 0 }, "");
  loadURL(raw);
}

function exitAR() {
  running = false;
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
$("recenter-btn").addEventListener("click", () => { if (!gyro.active) { look.yaw = 0; look.pitch = 0; camQ = quat(); } placePanel(); });

// Test hook (no effect for users).
window.__airpane = { normalizeInput, get state() { return { running, placed, dist, gyro: gyro.active, current, mode: modeChip.textContent }; } };
