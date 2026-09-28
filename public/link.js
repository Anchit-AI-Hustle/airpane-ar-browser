// Pairs the floating display (phone/iPad under the glass) with the controller
// (laptop) using a direct WebRTC data channel. PeerJS's free broker only helps the
// two devices find each other; the page data then flows device to device.

const PEERJS = "https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js";
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, L, O: easy to read and type
export const peerId = (code) => "airpane-glass-" + code.toUpperCase();
export const newCode = () => Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
export const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);

// Tests (and self-hosting) can point at another PeerJS server with ?peer=host:port
function peerOpts() {
  const v = new URLSearchParams(location.search).get("peer");
  if (!v) return { debug: 0 };
  const [host, port] = v.split(":");
  return { debug: 0, host, port: +port || 443, path: "/", secure: (+port || 443) === 443 };
}

let loading;
function loadPeer() {
  if (window.Peer) return Promise.resolve(window.Peer);
  loading = loading || new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = PEERJS; s.async = true;
    s.onload = () => ok(window.Peer);
    s.onerror = () => bad(new Error("Could not load the pairing library"));
    document.head.appendChild(s);
  });
  return loading;
}

// Display side: listen under a short code. Calls onMessage(msg, reply) for each message.
export async function host({ onCode, onMessage, onPeers }) {
  const Peer = await loadPeer();
  let peer, code, conns = new Set();
  for (let attempt = 0; attempt < 5; attempt++) {
    code = newCode();
    try {
      peer = await new Promise((ok, bad) => {
        const p = new Peer(peerId(code), peerOpts());
        p.on("open", () => ok(p));
        p.on("error", (e) => { p.destroy(); bad(e); });
      });
      break;
    } catch (e) { if (e.type !== "unavailable-id" || attempt === 4) throw e; }
  }
  onCode && onCode(code);
  peer.on("connection", (c) => {
    c.on("open", () => { conns.add(c); onPeers && onPeers(conns.size); });
    c.on("data", (m) => onMessage && onMessage(m, (r) => c.open && c.send(r)));
    c.on("close", () => { conns.delete(c); onPeers && onPeers(conns.size); });
  });
  peer.on("disconnected", () => { try { peer.reconnect(); } catch {} });
  return {
    code,
    broadcast(m) { for (const c of conns) if (c.open) c.send(m); },
    close() { try { peer.destroy(); } catch {} },
  };
}

// Controller side: connect to a display by its code.
export async function join(code, { onMessage, onClose }) {
  const Peer = await loadPeer();
  const peer = await new Promise((ok, bad) => {
    const p = new Peer(undefined, peerOpts());
    p.on("open", () => ok(p));
    p.on("error", bad);
  });
  const conn = await new Promise((ok, bad) => {
    const c = peer.connect(peerId(code), { reliable: true });
    const t = setTimeout(() => bad(new Error("No display with that code. Check the code on the floating screen.")), 12000);
    c.on("open", () => { clearTimeout(t); ok(c); });
    peer.on("error", (e) => { clearTimeout(t); bad(e.type === "peer-unavailable" ? new Error("No display with that code. Check the code on the floating screen.") : e); });
  });
  conn.on("data", (m) => onMessage && onMessage(m));
  conn.on("close", () => onClose && onClose());
  return { send: (m) => conn.open && conn.send(m), close: () => { try { peer.destroy(); } catch {} } };
}
