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

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
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

module.exports = { send, readJson, assertPublicUrl, isPrivateIp, isBlockedForCloud };
