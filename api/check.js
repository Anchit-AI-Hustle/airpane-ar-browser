// GET /api/check?url=...  ->  { frameable, reason, finalUrl }
// Reads the site's own framing rules (X-Frame-Options / CSP frame-ancestors).
// It never proxies or strips them: blocked sites go to Cloud mode instead.
const { send, assertPublicUrl } = require("./_lib");

const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";

function analyse(headers) {
  const xfo = (headers.get("x-frame-options") || "").toLowerCase();
  if (/deny|sameorigin/.test(xfo)) return { frameable: false, reason: `x-frame-options: ${xfo.trim()}` };

  const csp = headers.get("content-security-policy") || "";
  const directives = csp
    .split(/[;,]/)
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.startsWith("frame-ancestors"));
  for (const d of directives) {
    const sources = d.split(/\s+/).slice(1);
    const open = sources.includes("*") || sources.includes("https:");
    if (!open) return { frameable: false, reason: d };
  }
  return { frameable: true, reason: "no framing restrictions" };
}

module.exports = async (req, res) => {
  const target = new URL(req.url, "http://local").searchParams.get("url");
  if (!target) return send(res, 400, { error: "Missing url" });

  let current = target;
  try {
    for (let hop = 0; hop < 5; hop++) {
      await assertPublicUrl(current);
      const r = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": UA, accept: "text/html,*/*" },
        signal: AbortSignal.timeout(9000),
      });
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) {
        await r.body?.cancel();
        current = new URL(loc, current).href;
        continue;
      }
      await r.body?.cancel();
      return send(res, 200, { ...analyse(r.headers), finalUrl: current, status: r.status });
    }
    return send(res, 200, { frameable: false, reason: "too many redirects", finalUrl: current });
  } catch (e) {
    // Refused URLs (bad scheme, private host) are final. Network errors are "unknown":
    // the client then just tries the page directly and lets the browser decide.
    const refused = /Invalid URL|Only http|Port not allowed|Host not allowed/.test(e.message || "");
    return send(res, 422, { frameable: false, unknown: !refused, reason: e.message || "unreachable", finalUrl: current });
  }
};

module.exports.analyse = analyse;
