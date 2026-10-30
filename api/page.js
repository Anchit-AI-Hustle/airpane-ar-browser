// GET /api/page?url=...  ->  the real page (its own layout, colours and images) as HTML
// that the floating glass shows in a sandboxed, same-origin frame. The page's own
// scripts are removed (the frame also forbids scripts), so the laptop controller can
// hover, click and scroll it safely. Links, images and styles keep pointing at the
// original site through a <base> tag.
let parseHTML = null;
const loadDom = async () => (parseHTML ||= (await import("linkedom")).parseHTML);
const { assertPublicUrl, refuseElsewhere } = require("./_lib");
const { fetchPage } = require("./reader");

// Pages written for JavaScript often start hidden and fade in from a script. Without
// scripts that never happens, so show such content straight away.
const NO_JS_FIXES = `
  html, body { scroll-behavior: auto !important; }
  /* faded-in content (but not things deliberately hidden, like closed menus and pop-ups) */
  :is([style*="opacity:0;"], [style*="opacity: 0;"], [style$="opacity:0"], [style$="opacity: 0"]):not([style*="visibility"]):not([style*="pointer-events"]):not([style*="position:fixed"]):not([style*="position: fixed"]) { opacity: 1 !important; }
  .reveal, .fade-in, .fade-up, [data-aos], [data-animate], [data-scroll] { opacity: 1 !important; transform: none !important; visibility: visible !important; }
  .airpane-hover { outline: 4px solid #7cf5d3 !important; outline-offset: 2px; background: rgba(124, 245, 211, 0.28) !important; border-radius: 4px; }
`;

// Wikipedia now sends its desktop layout to everyone, and without its scripts that
// layout falls apart on a phone. On narrow screens ask for its mobile layout instead.
function forWidth(url, w) {
  try {
    const u = new URL(url);
    if (w && w < 800 && /(^|\.)wikipedia\.org$/.test(u.hostname) && !u.searchParams.has("useskin")) {
      u.hostname = u.hostname.replace(/\.m\.wikipedia\.org$/, ".wikipedia.org");
      u.searchParams.set("useskin", "minerva");
      return u.toString();
    }
  } catch {}
  return url;
}

async function buildPage(url, w) {
  const { html, finalUrl } = await fetchPage(forWidth(url, w));
  return { ...(await cleanPage(html, finalUrl)), finalUrl };
}

// Someone else's HTML, made safe to show: nothing in it can run.
async function cleanPage(html, finalUrl) {
  await loadDom();
  const { document } = parseHTML(html);
  const head = document.head || document.documentElement;
  // <noscript> content is what the page shows without scripts: unwrap it.
  for (const ns of document.querySelectorAll("noscript")) {
    const { document: frag } = parseHTML(`<div>${ns.textContent || ns.innerHTML}</div>`);
    const div = frag.querySelector("div");
    for (const bad of div.querySelectorAll("script, iframe, object, embed")) bad.remove();
    ns.insertAdjacentHTML("beforebegin", div.innerHTML);
    ns.remove();
  }
  // Nothing from the page may run. (<template> can hold a shadow root the browser builds from
  // markup, which the cleaning below can't see inside; SVG <animate>/<set> can rewrite links.)
  for (const n of document.querySelectorAll("script, iframe, object, embed, frame, frameset, portal, template, animate, set, animatetransform, animatemotion")) n.remove();
  for (const n of document.querySelectorAll("meta[http-equiv]")) {
    if (/refresh|content-security-policy|set-cookie/i.test(n.getAttribute("http-equiv"))) n.remove();
  }
  for (const n of document.querySelectorAll("base, link[rel=preload][as=script], link[rel=modulepreload]")) n.remove();
  for (const el of document.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    for (const attr of ["href", "src", "action", "formaction", "xlink:href", "data", "poster", "background"]) {
      const v = el.getAttribute(attr);
      // browsers ignore tabs, newlines and control characters inside a URL scheme ("java\tscript:")
      if (v && /^(javascript|vbscript|data:text\/html)/i.test(v.replace(/[\u0000-\u0020\u007f-\u00a0]/g, ""))) el.removeAttribute(attr);
    }
    el.removeAttribute("shadowrootmode"); el.removeAttribute("srcdoc");
  }
  // Lazy images that wait for a script: use their real source.
  for (const img of document.querySelectorAll("img")) {
    const ds = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original");
    const src = img.getAttribute("src") || "";
    if (ds && (!src || src.startsWith("data:"))) img.setAttribute("src", ds);
    const dss = img.getAttribute("data-srcset");
    if (dss && !img.getAttribute("srcset")) img.setAttribute("srcset", dss);
  }
  const extra = `<base href="${finalUrl.replace(/"/g, "&quot;")}"><meta name="referrer" content="no-referrer"><style id="airpane-fixes">${NO_JS_FIXES}</style>`;
  head.insertAdjacentHTML("afterbegin", extra);
  const title = (document.querySelector("title")?.textContent || "").trim();
  let out = document.toString();
  // Belt and braces: the frame forbids scripts anyway, but strip any that survived parsing.
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*>/gi, "");
  if (!/^<!doctype/i.test(out)) out = "<!DOCTYPE html>" + out;
  return { html: out, title };
}

module.exports = async (req, res) => {
  if (refuseElsewhere(req, res)) return;
  const params = new URL(req.url, "http://local").searchParams;
  const target = params.get("url"), width = parseInt(params.get("w"), 10) || 0;
  res.setHeader("Cache-Control", "no-store");
  if (!target) { res.statusCode = 400; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ error: "Missing url" })); }
  try {
    await assertPublicUrl(target);
    const { html, finalUrl, title } = await buildPage(target, width);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // The app reads this with fetch() and shows it in its own sandboxed frame. Opened any other
    // way it is someone else's page: no scripts, forms, plugins or framing on Airpane's address.
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src * data:; style-src * 'unsafe-inline'; font-src * data:");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Final-Url", encodeURIComponent(finalUrl));
    res.setHeader("X-Page-Title", encodeURIComponent(title));
    return res.end(html);
  } catch (e) {
    // A PDF (a resume, a menu...): the display draws it itself from /api/file.
    if (/pdf/i.test(e.contentType || "")) {
      res.statusCode = 200;
      res.setHeader("X-Airpane-Kind", "pdf");
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "PDF", pdf: true, url: e.finalUrl || target }));
    }
    res.statusCode = 422;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: e.message || "Could not open that page" }));
  }
};
module.exports.buildPage = buildPage;
module.exports.cleanPage = cleanPage;
