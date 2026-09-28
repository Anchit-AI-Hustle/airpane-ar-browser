// GET /api/reader?url=...  ->  { title, url, site, blocks: [{ type, runs:[{text, href?}], src? }] }
// Turns a web page into clean, same-origin content so the floating view can be
// fully controlled (cursor, click, scroll) from another device. Uses Mozilla's
// Readability (the engine behind Firefox Reader View).
// linkedom's CommonJS build require()s an ESM-only css-select, which fails on Node 20.
// Its ESM build works everywhere, so load it with import().
let parseHTML = null;
const loadDom = async () => (parseHTML ||= (await import("linkedom")).parseHTML);
const { Readability } = require("@mozilla/readability");
const { send, assertPublicUrl } = require("./_lib");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MAX_BYTES = 3_000_000;
const MAX_BLOCKS = 400;

async function fetchPage(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const r = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(10000),
    });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { await r.body?.cancel(); current = new URL(loc, current).href; continue; }
    if (!r.ok) { await r.body?.cancel(); throw new Error(`The site answered ${r.status}`); }
    const type = r.headers.get("content-type") || "";
    if (!/html|xml/i.test(type)) { await r.body?.cancel(); throw new Error("Not a web page"); }
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error("Page too large");
    return { html: new TextDecoder("utf-8").decode(buf), finalUrl: current };
  }
  throw new Error("Too many redirects");
}

const clean = (s) => String(s || "").replace(/\s+/g, " ");

// Inline content of a block element -> runs of text, some of them links.
function runsOf(el, base) {
  const runs = [];
  const walk = (node, href) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        const t = clean(c.textContent);
        if (t) runs.push(href ? { text: t, href } : { text: t });
      } else if (c.nodeType === 1) {
        const tag = c.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "sup" && /cite_ref|reference/.test(c.className || "")) continue;
        let h = href;
        if (tag === "a") {
          const raw = c.getAttribute("href");
          try { if (raw && !raw.startsWith("#") && !/^javascript:/i.test(raw)) h = new URL(raw, base).href; } catch {}
        }
        if (tag === "br") runs.push({ text: " " });
        else walk(c, h);
      }
    }
  };
  walk(el, null);
  // merge neighbours with the same link
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.href === r.href) last.text += r.text; else out.push({ ...r });
  }
  if (out.length) { out[0].text = out[0].text.replace(/^\s+/, ""); out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, ""); }
  return out.filter((r) => r.text);
}

function toBlocks(root, base) {
  const blocks = [];
  const visit = (el) => {
    for (const c of el.children) {
      if (blocks.length >= MAX_BLOCKS) return;
      const tag = c.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { const runs = runsOf(c, base); if (runs.length) blocks.push({ type: tag <= "h2" ? "h2" : "h3", runs }); }
      else if (tag === "p" || tag === "blockquote" || tag === "pre") { const runs = runsOf(c, base); if (runs.length) blocks.push({ type: "p", runs }); }
      else if (tag === "li") { const runs = runsOf(c, base); if (runs.length) blocks.push({ type: "li", runs }); }
      else if (tag === "img") {
        const src = c.getAttribute("src") || c.getAttribute("data-src");
        const w = +c.getAttribute("width") || 999, h = +c.getAttribute("height") || 999;
        if (w < 60 || h < 40 || /\.(gif|svg)(\?|$)/i.test(src || "")) continue; // spacers, icons, logos
        try { if (src && !src.startsWith("data:")) blocks.push({ type: "img", src: new URL(src, base).href, runs: [{ text: clean(c.getAttribute("alt")) }] }); } catch {}
      } else visit(c);
    }
  };
  visit(root);
  return blocks;
}

// Pages that are mostly navigation (home pages, portals) have little "article";
// fall back to every heading, paragraph and link in the body.
function fallback(doc, base) {
  for (const n of doc.querySelectorAll("script,style,noscript,svg,iframe,form")) n.remove();
  const blocks = toBlocks(doc.body || doc.documentElement, base);
  if (blocks.length) return blocks;
  const links = [...doc.querySelectorAll("a[href]")].slice(0, 80).map((a) => runsOf(a.parentNode || a, base)).filter((r) => r.length);
  return links.map((runs) => ({ type: "li", runs }));
}

async function read(url) {
  const { html, finalUrl } = await fetchPage(url);
  await loadDom();
  const { document } = parseHTML(html);
  const title = clean(document.querySelector("title")?.textContent).trim();
  let blocks = [];
  try {
    const art = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
    if (art && art.content) {
      const { document: d2 } = parseHTML(`<!doctype html><html><body>${art.content}</body></html>`);
      blocks = toBlocks(d2.body, finalUrl);
    }
  } catch {}
  if (blocks.length < 3) blocks = fallback(document, finalUrl);
  // Link-heavy pages (news lists, portals) need their links to be usable.
  const linkCount = blocks.reduce((n, b) => n + b.runs.filter((r) => r.href).length, 0);
  if (linkCount < 8) {
    const seen = new Set(blocks.flatMap((b) => b.runs.map((r) => r.href)).filter(Boolean));
    const { document: d3 } = parseHTML(html);
    for (const a of d3.querySelectorAll("a[href]")) {
      if (blocks.length >= MAX_BLOCKS + 150) break;
      const text = clean(a.textContent).trim();
      const raw = a.getAttribute("href") || "";
      if (text.length < 3 || raw.startsWith("#") || /^(javascript|mailto|tel|sms|whatsapp):/i.test(raw)) continue;
      let href; try { href = new URL(raw, finalUrl).href; } catch { continue; }
      if (seen.has(href)) continue;
      seen.add(href);
      blocks.push({ type: "li", runs: [{ text, href }] });
    }
  }
  const site = new URL(finalUrl).hostname.replace(/^www\./, "");
  return { title: title || site, url: finalUrl, site, blocks: blocks.slice(0, MAX_BLOCKS + 150) };
}

module.exports = async (req, res) => {
  const target = new URL(req.url, "http://local").searchParams.get("url");
  if (!target) return send(res, 400, { error: "Missing url" });
  try {
    return send(res, 200, await read(target));
  } catch (e) {
    return send(res, 422, { error: e.message || "Could not read that page" });
  }
};
module.exports.read = read;
