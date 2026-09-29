// GET /api/file?url=...  ->  the PDF itself, so the floating glass can draw its pages.
// Only PDFs, only public hosts, at most 4 MB (the hosting limit for one response).
const { assertPublicUrl } = require("./_lib");
const MAX = 4_000_000;

module.exports = async (req, res) => {
  const target = new URL(req.url, "http://local").searchParams.get("url");
  const fail = (code, msg) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: msg })); };
  if (!target) return fail(400, "Missing url");
  try {
    let current = target, r;
    for (let hop = 0; ; hop++) {
      if (hop > 4) return fail(422, "Too many redirects");
      await assertPublicUrl(current);
      r = await fetch(current, { redirect: "manual", headers: { accept: "application/pdf,*/*" }, signal: AbortSignal.timeout(10000) });
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) { await r.body?.cancel(); current = new URL(loc, current).href; continue; }
      break;
    }
    if (!r.ok) { await r.body?.cancel(); return fail(422, `The site answered ${r.status}`); }
    if (!/pdf/i.test(r.headers.get("content-type") || "")) { await r.body?.cancel(); return fail(415, "Not a PDF"); }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength > MAX) return fail(413, "This PDF is too large to show here");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(buf);
  } catch (e) {
    return fail(422, e.message || "Could not open that file");
  }
};
