// Throw the page onto another screen. Pinch the page (or press and hold it), swing, let go,
// and it flies off this device and lands on a TV, laptop or tablet.
//
// Two ways to reach the other screen:
//   "peer"    any device with a browser opens /catch, which shows a code and a QR code. This
//             device connects to it over a direct WebRTC link (the same PeerJS link the
//             laptop controller uses). Works on iPhone, Android, smart TV browsers, laptops.
//   "present" Chrome and Edge on a computer can present /catch on a Chromecast or a second
//             display with the Presentation API: no code, the browser's own device picker.
//
// The page is sent as an address, not as video: the screen opens it itself, so text stays
// sharp at any size and a video plays on the TV, not through the phone.
import { join, cleanCode } from "./link.js";

const MAX_URL = 2048;
const num = (v, lo, hi, d = 0) => { const n = +v; return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
export const httpUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && u.length <= MAX_URL ? x.href : ""; } catch { return ""; } };

// Every message between the two devices, checked before it is used: a screen accepts pages
// from anyone who has its code, so nothing in a message is trusted.
export function cleanMsg(m) {
  if (!m || typeof m !== "object" || typeof m.t !== "string") return null;
  switch (m.t) {
    case "hello": return { t: "hello", from: str(m.from, 40) };
    case "cast": { const url = httpUrl(m.url); return url ? { t: "cast", url, pos: num(m.pos, 0, 1), title: str(m.title, 200), from: str(m.from, 40), vx: num(m.vx, -9, 9), vy: num(m.vy, -9, 9, -1) } : null; }
    case "cur": case "click": return { t: m.t, x: num(m.x, 0, 1, 0.5), y: num(m.y, 0, 1, 0.5) };
    case "scroll": return { t: "scroll", dy: num(m.dy, -2, 2) };
    case "back": case "forward": case "lost": case "recall": case "bye": return { t: m.t };
    case "screen": return { t: "screen", name: str(m.name, 40) };
    case "state": return { t: "state", url: httpUrl(m.url), title: str(m.title, 200), pos: num(m.pos, 0, 1), loading: Boolean(m.loading), error: str(m.error, 200), video: Boolean(m.video) };
    case "page": { const url = httpUrl(m.url); return url ? { t: "page", url, pos: num(m.pos, 0, 1) } : null; }
    default: return null;
  }
}

// A video page plays in the real player on the screen (scripts and all), not as the
// script-free copy Airpane shows for other pages.
export function videoEmbed(raw) {
  let u;
  try { u = new URL(raw); } catch { return ""; }
  const h = u.hostname.replace(/^(www\.|m\.)/, "");
  const id = (s) => (/^[\w-]{6,20}$/.test(s || "") ? s : "");
  let v = "";
  if (h === "youtube.com" || h === "youtube-nocookie.com") {
    if (u.pathname === "/watch") v = id(u.searchParams.get("v"));
    else { const m = u.pathname.match(/^\/(embed|shorts|live)\/([\w-]+)/); if (m) v = id(m[2]); }
  } else if (h === "youtu.be") v = id(u.pathname.slice(1));
  if (v) return `https://www.youtube.com/embed/${v}?autoplay=1&playsinline=1`;
  if (h === "vimeo.com" || h === "player.vimeo.com") {
    const m = u.pathname.match(/^\/(?:video\/)?(\d{5,12})/);
    if (m) return `https://player.vimeo.com/video/${m[1]}?autoplay=1`;
  }
  return "";
}

// A short name for a device, so each side can say who it is talking to.
export function deviceName(ua = "") {
  if (/SmartTV|SMART-TV|Tizen|Web0S|webOS|BRAVIA|AFT\w|CrKey|GoogleTV|Android TV|HbbTV|Roku|Xbox|PlayStation/i.test(ua)) return "TV";
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "PC";
  if (/CrOS/.test(ua)) return "Chromebook";
  return "Computer";
}

// The screen page's address (tests point both sides at a local PeerJS server with ?peer=).
export function catchUrl(params = {}) {
  const q = new URLSearchParams(params), p = new URLSearchParams(location.search).get("peer");
  if (p) q.set("peer", p);
  const s = q.toString();
  return location.origin + "/catch/" + (s ? "?" + s : "");
}

// Sender side. One screen at a time; connecting another replaces it.
export function createCaster({ onChange, onMessage } = {}) {
  let conn = null, connecting = false, avail = false, request = null;
  const me = deviceName(navigator.userAgent);
  const changed = () => onChange && onChange(state());
  const state = () => ({ connected: Boolean(conn), connecting, kind: conn ? conn.kind : "", code: conn ? conn.code : "", name: conn ? conn.name : "", presentAvailable: avail });
  const got = (raw) => {
    const m = cleanMsg(typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw);
    if (!m) return;
    if (m.t === "screen" && conn) { conn.name = m.name || conn.name; changed(); }
    onMessage && onMessage(m);
  };
  const closed = (c) => { if (conn === c) { conn = null; changed(); } };
  function use(c) {
    const old = conn; conn = c;
    if (old) { try { old.send({ t: "bye" }); } catch {} old.close(); }
    c.send({ t: "hello", from: me });
    changed();
  }

  // Chrome / Edge on a computer: find out whether a Chromecast or a second display is around.
  if (typeof window !== "undefined" && window.PresentationRequest) {
    try {
      request = new PresentationRequest([catchUrl({ via: "present" })]);
      request.getAvailability().then((a) => { avail = a.value; a.onchange = () => { avail = a.value; changed(); }; changed(); }).catch(() => {});
    } catch { request = null; }
  }

  return {
    get state() { return state(); },
    get connected() { return Boolean(conn); },
    // a screen showing this code at /catch
    async connectCode(code) {
      code = cleanCode(code);
      if (code.length !== 4) throw new Error("The code has 4 letters.");
      connecting = true; changed();
      try {
        let c;
        const l = await join(code, { kind: "screen", onMessage: got, onClose: () => closed(c) });
        c = { kind: "peer", code, name: "Screen " + code, send: (m) => l.send(m), close: () => l.close() };
        use(c);
      } finally { connecting = false; changed(); }
      try { localStorage.setItem("airpane-screen", code); } catch {}
    },
    // the browser's own picker (must run inside a tap)
    async connectPresentation() {
      if (!request) throw new Error("This browser can't cast a page. Open airpane.anchit-tandon.com/catch on the screen instead.");
      connecting = true; changed();
      try {
        const pc = await request.start();
        let c;
        await new Promise((ok, bad) => {
          if (pc.state === "connected") return ok();
          pc.onconnect = () => ok();
          pc.onclose = pc.onterminate = () => bad(new Error("The screen closed before it connected."));
          setTimeout(() => bad(new Error("The screen did not answer.")), 30000);
        });
        c = { kind: "present", code: "", name: "Cast screen", send: (m) => { if (pc.state === "connected") pc.send(JSON.stringify(m)); }, close: () => { try { pc.terminate(); } catch {} } };
        pc.onmessage = (e) => got(e.data);
        pc.onclose = pc.onterminate = () => closed(c);
        use(c);
      } finally { connecting = false; changed(); }
    },
    send(m) { if (conn) conn.send(m); return Boolean(conn); },
    disconnect() { const c = conn; conn = null; if (c) { try { c.send({ t: "bye" }); } catch {} c.close(); } changed(); },
    lastCode() { try { return cleanCode(localStorage.getItem("airpane-screen") || ""); } catch { return ""; } },
  };
}
