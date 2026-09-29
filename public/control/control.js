// Laptop controller: webcam hand tracking (MediaPipe) or the trackpad drives the
// cursor on the floating page, over a direct link to the display device.
import { createGestures } from "/gestures.js";
import { POSES } from "/poses.js";
import { join, cleanCode } from "/link.js";
import { renderBlocks } from "/glass.js";

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), ctx = overlay.getContext("2d");

let link = null, handsOn = true, landmarker = null, stream = null, lastSent = 0, lastCur = null;
const gestures = createGestures();
const S = { hand: false, pinched: false, events: { cur: 0, click: 0, scroll: 0 } };
window.__ctl = { get state() { return { connected: Boolean(link), handsOn, mirror: { url: M.url, loaded: M.loaded, y: M.y, view: M.view }, detector: Boolean(landmarker), camera: Boolean(stream), ...S, gesture: gestures.state }; } };

function send(m) { if (link) link.send(m); }

// ---------- pairing ----------
const codeIn = $("code");
codeIn.value = cleanCode(new URLSearchParams(location.search).get("code") || "");
codeIn.addEventListener("input", () => { codeIn.value = cleanCode(codeIn.value); });
$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = cleanCode(codeIn.value);
  const err = $("pair-err");
  if (code.length !== 4) { err.textContent = "The code has 4 letters."; err.hidden = false; return; }
  err.hidden = true;
  $("connect").disabled = true; $("connect").textContent = "Connecting";
  try {
    link = await join(code, { onMessage: onState, onClose: onClosed });
    send({ t: "hello" });
    $("pair").hidden = true; $("panel").hidden = false;
    const q = new URLSearchParams(location.search); q.set("code", code);
    history.replaceState(null, "", "?" + q.toString());
    startCamera();
  } catch (x) {
    err.textContent = x.message || "Could not connect."; err.hidden = false;
  }
  $("connect").disabled = false; $("connect").textContent = "Connect";
});

function onState(m) {
  if (!m || m.t !== "state") return;
  $("now-title").textContent = m.loading ? "Opening..." : m.error ? "Could not open: " + m.error : (m.title || "Connected");
  $("now-hover").textContent = m.hover ? "Make a fist to open: " + m.hover : "Move the cursor onto a link on the floating page";
  mirror(m);
}

// ---------- live view: an exact copy of the floating page, the right way up ----------
// Laid out at the display's own size and text size, then scaled to fit the pad, so
// scroll position and cursor position match the floating page exactly.
const mBox = document.querySelector("#mirror .m-box"), mContent = document.querySelector("#mirror .g-content");
const M = { url: "", loaded: "", pending: "", view: null, y: 0, hover: "" };
let mirrorReq = 0;
function mirror(m) {
  const empty = $("pad-empty");
  if (m.view && m.view.w > 0 && m.view.h > 0) {
    M.view = m.view;
    pad.style.setProperty("--ar", `${m.view.w} / ${m.view.h}`);
    mBox.style.width = m.view.w + "px"; mBox.style.height = m.view.h + "px";
    mContent.style.fontSize = m.view.fs + "px"; mContent.style.padding = m.view.pad;
    mContent.style.setProperty("--img-h", Math.round(Math.min(m.view.w, m.view.h) * 0.3) + "px");
    fitMirror();
  }
  M.y = +m.y || 0; M.hover = m.hover || "";
  if (m.loading) { empty.textContent = "Opening the page"; empty.hidden = false; mContent.innerHTML = ""; M.loaded = ""; M.pending = ""; mirrorReq++; }
  else if (m.error) { empty.textContent = "Could not open this page: " + m.error; empty.hidden = false; mContent.innerHTML = ""; M.loaded = ""; }
  else if (m.url && m.url !== M.loaded && m.url !== M.pending) loadMirror(m.url);
  else if (!m.url) { empty.textContent = "Open a site above to start"; empty.hidden = false; }
  M.url = m.url || "";
  paintMirror();
}
async function loadMirror(url) {
  const id = ++mirrorReq;
  M.pending = url;
  try {
    const r = await fetch("/api/reader?url=" + encodeURIComponent(url));
    const data = await r.json();
    if (id !== mirrorReq) return;
    if (!r.ok) throw new Error(data.error || "Could not open");
    mContent.innerHTML = renderBlocks(data);
    M.loaded = url; M.pending = ""; $("pad-empty").hidden = true;
  } catch (e) {
    if (id !== mirrorReq) return;
    $("pad-empty").textContent = "Live view unavailable for this page. It still floats in the glass."; $("pad-empty").hidden = false;
    M.loaded = url; M.pending = "";
  }
  paintMirror();
}
function paintMirror() {
  mContent.style.transform = `translateY(${-M.y}px)`;
  for (const a of mContent.querySelectorAll(".g-link.hover")) a.classList.remove("hover");
  if (M.hover) for (const a of mContent.querySelectorAll(".g-link")) if (a.textContent === M.hover) { a.classList.add("hover"); break; }
}
function fitMirror() {
  if (!M.view) return;
  const k = pad.clientWidth / M.view.w;
  mBox.style.transform = `scale(${k})`;
}
new ResizeObserver(fitMirror).observe(document.getElementById("pad"));
function onClosed() {
  link = null;
  $("now-title").textContent = "Disconnected. Reload the display and connect again.";
  document.querySelector(".dot").classList.add("off");
}

// ---------- page controls ----------
$("go-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("go-url").value.trim();
  if (!v) return;
  const url = /^https?:\/\//i.test(v) ? v : /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v) && !/\s/.test(v) ? "https://" + v : "https://en.m.wikipedia.org/w/index.php?search=" + encodeURIComponent(v);
  send({ t: "load", url });
  $("go-url").blur();
});
$("back").addEventListener("click", () => send({ t: "back" }));
$("forward").addEventListener("click", () => send({ t: "forward" }));
$("smaller").addEventListener("click", () => send({ t: "size", up: false }));
$("bigger").addEventListener("click", () => send({ t: "size", up: true }));
$("hands").addEventListener("click", () => {
  handsOn = !handsOn;
  $("hands").textContent = "Hand control: " + (handsOn ? "on" : "off");
  $("hands").classList.toggle("on", handsOn);
  $("hands").setAttribute("aria-pressed", String(handsOn));
  if (!handsOn) { gestures.reset(); send({ t: "lost" }); $("gesture").textContent = "Hand control is off"; }
});
addEventListener("keydown", (e) => {
  if (!link || e.target.tagName === "INPUT") return;
  if (e.key === "ArrowDown" || e.key === "PageDown") { send({ t: "scroll", dy: e.key === "PageDown" ? 0.8 : 0.15 }); e.preventDefault(); }
  if (e.key === "ArrowUp" || e.key === "PageUp") { send({ t: "scroll", dy: e.key === "PageUp" ? -0.8 : -0.15 }); e.preventDefault(); }
  if (e.key === "Backspace" || e.key === "ArrowLeft") { send({ t: "back" }); e.preventDefault(); }
  if (e.key === "ArrowRight") { send({ t: "forward" }); e.preventDefault(); }
});

// Trackpad area: the pad maps 1:1 onto the floating page.
const pad = $("pad"), padCur = $("pad-cursor");
const padXY = (e) => { const r = pad.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
pad.addEventListener("pointermove", (e) => { const p = padXY(e); showPad(p); sendCur(p); });
pad.addEventListener("pointerleave", () => { padCur.hidden = true; send({ t: "lost" }); lastCur = null; });
pad.addEventListener("click", (e) => { const p = padXY(e); send({ t: "click", x: p.x, y: p.y }); S.events.click++; });
pad.addEventListener("wheel", (e) => { e.preventDefault(); send({ t: "scroll", dy: e.deltaY / 900 }); S.events.scroll++; }, { passive: false });
function showPad(p) { padCur.hidden = false; padCur.style.left = p.x * 100 + "%"; padCur.style.top = p.y * 100 + "%"; }

// ~30 updates a second; the last position is always sent, so the cursor settles exactly.
let trailing = null;
function sendCur(p) {
  const now = performance.now();
  if (lastCur && Math.abs(p.x - lastCur.x) < 0.002 && Math.abs(p.y - lastCur.y) < 0.002) return;
  clearTimeout(trailing);
  if (now - lastSent < 30) { trailing = setTimeout(() => sendCur(p), 35); return; }
  lastSent = now; lastCur = p;
  send({ t: "cur", x: +p.x.toFixed(4), y: +p.y.toFixed(4) });
  S.events.cur++;
}

// ---------- webcam hand tracking ----------
async function startCamera() {
  const msg = $("cam-msg");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    video.srcObject = stream;
    await video.play().catch(() => {});
    msg.textContent = "Loading hand tracking";
  } catch {
    msg.textContent = "Camera is off. Use the trackpad area instead.";
    return;
  }
  try {
    const { FilesetResolver, HandLandmarker } = await import(MP + "/vision_bundle.mjs");
    const files = await FilesetResolver.forVisionTasks(MP + "/wasm");
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: HAND_MODEL, delegate }, runningMode: "VIDEO", numHands: 1, minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    try { landmarker = await HandLandmarker.createFromOptions(files, opts("GPU")); }
    catch { landmarker = await HandLandmarker.createFromOptions(files, opts("CPU")); }
    msg.hidden = true;
    requestAnimationFrame(tick);
  } catch {
    msg.textContent = "Hand tracking could not load. Use the trackpad area instead.";
  }
}

let lastVideoTime = -1, lastLm = null;
window.__ctl.lastLandmarks = () => lastLm && lastLm.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4)]);
function tick(now) {
  requestAnimationFrame(tick);
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let lm = null;
  try { const r = landmarker.detectForVideo(video, now); lm = r.landmarks && r.landmarks[0]; } catch { return; }
  draw(lm);
  S.hand = Boolean(lm); lastLm = lm;
  if (!handsOn) return;
  for (const ev of gestures.update(lm || null, now)) {
    if (ev.t === "cur") { sendCur(ev); showPad(ev); }
    else if (ev.t === "click") { send(ev); S.events.click++; flash("Click"); }
    else if (ev.t === "scroll") { send(ev); S.events.scroll++; }
    else if (ev.t === "lost") { send(ev); lastCur = null; padCur.hidden = true; }
    else if (ev.t === "back") { send({ t: "back" }); S.events.back = (S.events.back || 0) + 1; flash("Back"); }
    else if (ev.t === "forward") { send({ t: "forward" }); S.events.forward = (S.events.forward || 0) + 1; flash("Forward"); }
    else if (ev.t === "size") { send({ t: "size", up: ev.up }); flash(ev.up ? "Text bigger" : "Text smaller"); }
  }
  const g = gestures.state;
  S.pinched = g.pinched; S.pose = g.pose; S.paused = g.paused;
  $("gesture").textContent = !lm ? "No hand in view" : (POSES[g.pose] || "Hand seen");
}

let flashT = null;
function flash(text) {
  const el = $("gesture-flash"); el.textContent = text; el.hidden = false;
  clearTimeout(flashT); flashT = setTimeout(() => { el.hidden = true; }, 1200);
}

function draw(lm) {
  const w = (overlay.width = overlay.clientWidth * devicePixelRatio), h = (overlay.height = overlay.clientHeight * devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  // match object-fit: cover of a 4:3 video
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const sc = Math.max(w / vw, h / vh), ox = (w - vw * sc) / 2, oy = (h - vh * sc) / 2;
  const P = (p) => [ox + p.x * vw * sc, oy + p.y * vh * sc];
  ctx.fillStyle = "rgba(124,245,211,0.9)";
  for (const p of lm) { const [x, y] = P(p); ctx.beginPath(); ctx.arc(x, y, 3 * devicePixelRatio, 0, 7); ctx.fill(); }
  const [tx, ty] = P(lm[8]);
  ctx.strokeStyle = gestures.state.pinched ? "#ffd166" : "#7cf5d3"; ctx.lineWidth = 3 * devicePixelRatio;
  ctx.beginPath(); ctx.arc(tx, ty, 12 * devicePixelRatio, 0, 7); ctx.stroke();
}
