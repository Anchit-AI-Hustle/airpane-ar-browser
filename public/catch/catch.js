// The screen pages are thrown at: a TV, laptop or tablet opens /catch and waits under a
// short code. A phone connects with that code (or the QR code) and throws pages here; they
// land with an animation and fill the screen. The phone can then scroll, click and go back
// on this screen, or pull the page back.
//
// Opened by the Presentation API (Chrome casting to a Chromecast or a second display), the
// page talks to the computer that opened it instead, and needs no code.
import { host, cleanCode } from "/link.js";
import { createGlass } from "/glass.js";
import { cleanMsg, videoEmbed, deviceName } from "/cast.js";

const $ = (id) => document.getElementById(id);
const waitEl = $("wait"), showEl = $("show"), videoEl = $("video"), badge = $("badge"), statusEl = $("wait-status");
const ME = deviceName(navigator.userAgent);
const PRESENT = Boolean(navigator.presentation && navigator.presentation.receiver);
const S = { code: "", senders: 0, caught: 0, mode: "", url: "", from: "", ready: false, error: "" };
let link = null, lastCast = 0;
const presentConns = new Set();

$("site").textContent = location.host;

// ---------- the page, full screen, the right way up ----------
const glass = createGlass($("glass"), { onState: (st) => { if (S.mode === "page") tell({ t: "state", url: st.url, title: st.title, pos: st.pos, loading: st.loading, error: st.error, video: false }); } });
glass.setFlip(false);

function tell(m) {
  if (link) link.broadcast(m);
  for (const c of presentConns) if (c.state === "connected") c.send(JSON.stringify(m));
}
let badgeT = 0;
function say(text, ms = 3500) {
  badge.textContent = text; badge.classList.add("show");
  clearTimeout(badgeT); badgeT = setTimeout(() => badge.classList.remove("show"), ms);
}

async function caught(m) {
  // one page at a time: a burst of throws (or a misbehaving sender) can't flood the screen
  const now = performance.now();
  if (now - lastCast < 400) return;
  lastCast = now;
  S.caught++; S.from = m.from || "your phone";
  waitEl.hidden = true; showEl.hidden = false;
  const video = videoEmbed(m.url);
  say("Caught from " + S.from + (m.title ? ": " + m.title : ""));
  if (video) {
    S.mode = "video"; S.url = m.url;
    glass.stop(); glass.hideCursor();
    videoEl.hidden = false; videoEl.src = video;
    videoEl.classList.remove("landing"); void videoEl.offsetWidth; videoEl.classList.add("landing");
    tell({ t: "state", url: m.url, title: m.title || "Video", pos: 0, loading: false, error: "", video: true });
    return;
  }
  S.mode = "page"; S.url = m.url;
  videoEl.hidden = true; videoEl.removeAttribute("src");
  glass.start();
  glass.land(m.vx, m.vy);
  await glass.load(m.url);
  if (S.url === m.url && m.pos) glass.scrollToPos(m.pos);
}

function onMessage(raw, reply) {
  const m = cleanMsg(typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw);
  if (!m) return;
  if (m.t === "hello") {
    reply({ t: "screen", name: ME + (S.code ? " " + S.code : "") });
    if (S.mode) reply(S.mode === "page" ? { t: "state", ...pick(glass.state) } : { t: "state", url: S.url, title: "Video", pos: 0, video: true });
    say((m.from || "A phone") + " connected. Throw a page at this screen.");
    return;
  }
  if (m.t === "cast") return caught(m);
  if (m.t === "recall") {
    if (S.mode === "page") reply({ t: "page", url: glass.state.url, pos: glass.state.pos });
    else if (S.mode === "video") reply({ t: "page", url: S.url, pos: 0 });
    return;
  }
  if (S.mode !== "page") return;
  if (m.t === "cur") glass.cursor(m.x, m.y);
  else if (m.t === "lost") glass.hideCursor();
  else if (m.t === "click") glass.click(m.x, m.y);
  else if (m.t === "scroll") glass.scroll(m.dy);
  else if (m.t === "back") glass.back();
  else if (m.t === "forward") glass.forward();
}
const pick = (st) => ({ url: st.url, title: st.title, pos: st.pos, loading: st.loading, error: st.error, video: false });

// ---------- connecting ----------
function waiting(text, ok = false) {
  statusEl.innerHTML = `<span class="spin" aria-hidden="true"></span>`;
  statusEl.append(text);
  statusEl.classList.toggle("ok", ok);
}

function drawQR(url) {
  const box = $("qr");
  box.dataset.url = url;
  const draw = () => {
    if (!window.qrcode) return setTimeout(draw, 100);
    const qr = window.qrcode(0, "M"); qr.addData(url); qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  };
  draw();
}

async function startPeer() {
  let saved = "";
  try { saved = cleanCode(localStorage.getItem("airpane-catch-code") || ""); } catch {}
  try {
    link = await host({
      kind: "screen",
      code: saved,
      onCode: (c) => {
        S.code = c;
        $("code").textContent = c;
        try { localStorage.setItem("airpane-catch-code", c); } catch {} // the same code next time
        const q = new URLSearchParams({ cast: c }), peer = new URLSearchParams(location.search).get("peer");
        if (peer) q.set("peer", peer);
        drawQR(location.origin + "/?" + q.toString());
      },
      onPeers: (n) => {
        S.senders = n;
        waiting(n ? (n === 1 ? "A phone is connected. Throw a page at this screen." : n + " devices are connected.") : "Waiting for a phone", n > 0);
      },
      onMessage,
    });
    S.ready = true;
    waiting("Waiting for a phone");
  } catch (e) {
    S.error = "no-link";
    $("code").textContent = "----";
    waiting("Can't get a code right now. Check the internet connection and reload this page.");
  }
}

function startPresentation() {
  // Opened by Chrome's Cast / second-screen picker: the computer that opened it is the sender.
  $("wait-lede").textContent = "Connected. Throw a page from your computer and it lands here.";
  $("wait-steps").hidden = true; $("qr").hidden = true;
  document.querySelector(".wait-code").hidden = true; $("full").hidden = true;
  const add = (c) => {
    presentConns.add(c); S.senders = presentConns.size;
    const reply = (m) => { if (c.state === "connected") c.send(JSON.stringify(m)); };
    c.addEventListener("message", (e) => onMessage(e.data, reply));
    c.addEventListener("close", () => { presentConns.delete(c); S.senders = presentConns.size; });
    c.addEventListener("terminate", () => { presentConns.delete(c); S.senders = presentConns.size; });
    waiting("Connected", true);
  };
  navigator.presentation.receiver.connectionList.then((list) => {
    list.connections.forEach(add);
    list.addEventListener("connectionavailable", (e) => add(e.connection));
    S.ready = true;
  });
}

if (PRESENT) startPresentation(); else startPeer();

// ---------- on the screen itself: mouse, touch, keys, TV remote arrows ----------
const g = $("glass");
let down = null;
g.addEventListener("pointerdown", (e) => { down = { y: e.clientY, last: e.clientY, moved: false }; });
g.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse" && !down) { const p = glass.viewXY(e.clientX, e.clientY); glass.cursor(p.x, p.y); }
  if (!down) return;
  if (Math.abs(e.clientY - down.y) > 8) down.moved = true;
  if (down.moved) { glass.dragBy(e.clientY - down.last); down.last = e.clientY; }
});
g.addEventListener("pointerup", (e) => { if (down && !down.moved) glass.tapAt(e.clientX, e.clientY); down = null; });
g.addEventListener("pointercancel", () => { down = null; });
g.addEventListener("pointerleave", () => glass.hideCursor());
g.addEventListener("wheel", (e) => { e.preventDefault(); glass.scroll(e.deltaY / 900); }, { passive: false });
addEventListener("keydown", (e) => {
  if (S.mode !== "page") return;
  const k = e.key;
  if (k === "ArrowDown" || k === "PageDown" || k === " ") { glass.scroll(k === "ArrowDown" ? 0.15 : 0.8); e.preventDefault(); }
  else if (k === "ArrowUp" || k === "PageUp") { glass.scroll(k === "ArrowUp" ? -0.15 : -0.8); e.preventDefault(); }
  else if (k === "Backspace" || k === "BrowserBack") { if (glass.state.canBack) { glass.back(); e.preventDefault(); } }
});

$("full").addEventListener("click", () => { const r = document.documentElement; if (r.requestFullscreen && !document.fullscreenElement) r.requestFullscreen().catch(() => {}); });

// A TV left on this page shouldn't go to sleep while it waits.
let wake = null;
async function keepAwake() { try { if (!wake && navigator.wakeLock) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } } catch {} }
keepAwake();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });

// Test hook (no effect for users).
window.__catch = { get state() { return { ...S, present: PRESENT, glass: glass.state, video: videoEl.hidden ? "" : videoEl.src }; }, message: (m) => onMessage(m, () => {}) };
