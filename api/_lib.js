// Shared helpers for the API functions (underscore = not deployed as a route).
const dns = require("node:dns").promises;
const net = require("node:net");

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

// IPv4 ranges that are not the public internet: this host, private networks, carrier NAT,
// link-local (cloud metadata), test and benchmark nets, multicast and reserved.
function isPrivateV4(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}
// An IPv6 address as 8 numbers (handles "::" and a dotted IPv4 tail).
function v6words(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const [a, b, c, d] = m[1].split(".").map(Number); s = s.slice(0, -m[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16); }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [], t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(fill).fill("0"), ...t].map((x) => parseInt(x, 16) || 0);
}
const v4of = (w1, w2) => [w1 >> 8, w1 & 255, w2 >> 8, w2 & 255].join(".");
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (!net.isIPv6(ip)) return true; // not an address we understand: refuse
  const w = v6words(ip);
  const zero = (n) => w.slice(0, n).every((x) => x === 0);
  if (zero(8) || (zero(7) && w[7] === 1)) return true; // :: and ::1
  // IPv4 carried inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::/96)
  if ((zero(5) && w[5] === 0xffff) || zero(6) || (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0))) return isPrivateV4(v4of(w[6], w[7]));
  if (w[0] === 0x2002) return isPrivateV4(v4of(w[1], w[2])); // 6to4
  if (w[0] === 0x2001 && w[1] === 0) return true; // Teredo tunnels
  if (w[0] === 0x64 && w[1] === 0xff9b) return true; // NAT64 local use
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
  if (w[0] === 0x100 && w.slice(1, 4).every((x) => x === 0)) return true; // discard (100::/64)
  return (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0 || (w[0] & 0xff00) === 0xff00;
}

// Only allow public http(s) URLs so the server can't be used to reach internal networks.
async function assertPublicUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("Invalid URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs are allowed");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Port not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Host not allowed");
  return url;
}

// Sites where typing credentials into a server-run browser is too risky for the MVP.
const BLOCKED_CLOUD = [
  "paypal.", "stripe.com", "razorpay.", "paytm.", "phonepe.", "hdfcbank.", "icicibank.",
  "onlinesbi.", "sbi.co.in", "axisbank.", "kotak.", "bankofamerica.", "chase.com",
  "wellsfargo.", "citi.com", "hsbc.", "barclays.", "americanexpress.", "coinbase.", "binance.",
];
function isBlockedForCloud(url) {
  const h = new URL(url).hostname.toLowerCase();
  return BLOCKED_CLOUD.some((d) => h.includes(d)) || /(^|\.)bank|netbanking/.test(h);
}

// fetch() for addresses from users. Every connection is made to an address checked here,
// at connect time: a name that resolves to a public address when checked and to a private
// one when connecting (DNS rebinding) is refused.
const { Agent, fetch: undiciFetch } = require("undici");
const dnsCb = require("node:dns");
const publicOnly = new Agent({
  connect: {
    lookup(hostname, opts, cb) {
      dnsCb.lookup(hostname, { all: true, family: opts && opts.family }, (err, addrs) => {
        if (err) return cb(err);
        if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return cb(new Error("Host not allowed"));
        if (opts && opts.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
      });
    },
  },
});
async function safeFetch(url, opts = {}) {
  try { return await undiciFetch(url, { ...opts, dispatcher: publicOnly }); }
  catch (e) { throw /Host not allowed/.test(e.cause?.message || "") ? new Error("Host not allowed") : e; }
}

// Read a response body, stopping as soon as it passes max bytes (not after downloading it all).
async function readCapped(r, max, msg = "Too large") {
  if (+r.headers.get("content-length") > max) { await r.body?.cancel(); throw new Error(msg); }
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); throw new Error(msg); }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

// The API is for Airpane's own pages. A browser marks requests a person did not make from
// Airpane: opening an API address directly (a link someone posted), or another site's page
// calling it. Those are refused. (Tools like curl send no such marks; a rate limit covers them.)
function fromElsewhere(req) {
  const h = (req && req.headers) || {};
  const mode = h["sec-fetch-mode"], site = h["sec-fetch-site"];
  return mode === "navigate" || mode === "nested-navigate" || Boolean(site && site !== "same-origin");
}
function refuseElsewhere(req, res) {
  if (!fromElsewhere(req)) return false;
  send(res, 403, { error: "This address is only for the Airpane app." });
  return true;
}

module.exports = { send, readJson, assertPublicUrl, isPrivateIp, isBlockedForCloud, safeFetch, readCapped, fromElsewhere, refuseElsewhere };
