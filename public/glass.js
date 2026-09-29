// Floating glass view: a phone or iPad lies flat, a clear sheet leans over it at
// 45 degrees, and the page appears standing in the air behind the sheet.
//
// The sheet reflects the screen, which flips the picture top-to-bottom, so the page
// is drawn flipped (scaleY(-1)) and the reflection reads normally. The page is a
// clean reader version of the site (from /api/reader), rendered here in our own
// page, so a remote cursor can hover, click links and scroll it.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function renderBlocks(data) {
  const run = (r) => r.href ? `<a class="g-link" data-href="${esc(r.href)}">${esc(r.text)}</a>` : esc(r.text);
  const html = data.blocks.map((b) => {
    const inner = b.runs.map(run).join("");
    if (b.type === "img") return `<figure><img src="${esc(b.src)}" alt="${esc(b.runs[0]?.text || "")}" loading="lazy" referrerpolicy="no-referrer" />${b.runs[0]?.text ? `<figcaption>${esc(b.runs[0].text)}</figcaption>` : ""}</figure>`;
    if (b.type === "h2") return `<h2>${inner}</h2>`;
    if (b.type === "h3") return `<h3>${inner}</h3>`;
    if (b.type === "li") return `<p class="g-li">${inner}</p>`;
    return `<p>${inner}</p>`;
  }).join("");
  return `<header class="g-head"><span class="g-site">${esc(data.site)}</span><h1>${esc(data.title)}</h1></header>${html}`;
}

// Many sites switch "tabs" or views with their own scripts (a sidebar item shows one
// section and hides the others). Page scripts don't run in Airpane, so do the switch
// here: find the panel the clicked item points to and show it in place of its siblings.
const ACTIVE = ["active", "is-active", "show", "current", "selected", "open", "visible"];
const TAB_ATTRS = ["data-view", "data-tab", "data-target", "data-section", "data-page", "data-panel-target", "aria-controls"];
const clean = (v) => String(v || "").trim().replace(/^#/, "");
export function tabKey(el) {
  for (const a of TAB_ATTRS) { const v = clean(el.getAttribute && el.getAttribute(a)); if (v && /^[\w-]+$/.test(v)) return { key: v, attr: a }; }
  return null;
}
function findPanel(doc, key) {
  const ids = [key, "view-" + key, "tab-" + key, "panel-" + key, "section-" + key, "page-" + key, key + "-view", key + "-tab", key + "-panel"];
  for (const id of ids) { const el = doc.getElementById(id); if (el) return el; }
  try { return doc.querySelector(`[data-panel="${key}"], [data-view-id="${key}"], [data-tab-panel="${key}"]`); } catch { return null; }
}
const shown = (el) => el.getClientRects().length > 0;
// Show the panel for `key`. Returns true when it switched a hidden panel into view.
export function switchTab(doc, key, attr) {
  const panel = key && findPanel(doc, key);
  if (!panel || !panel.parentElement) return false;
  const sibs = [...panel.parentElement.children].filter((c) => c !== panel && c.tagName === panel.tagName && ([...c.classList].some((k) => panel.classList.contains(k) && !ACTIVE.includes(k)) || c.getAttribute("role") === "tabpanel"));
  if (shown(panel) && !sibs.some(shown)) return false; // nothing to switch
  const on = new Set(["active"]);
  for (const c of sibs) for (const k of ACTIVE) if (c.classList.contains(k)) on.add(k);
  for (const c of sibs) {
    c.classList.remove(...ACTIVE);
    if (c.getAttribute("role") === "tabpanel" || c.hasAttribute("hidden")) c.setAttribute("hidden", "");
    if (c.style.display && c.style.display !== "none") c.style.display = "";
  }
  panel.removeAttribute("hidden");
  panel.classList.add(...on);
  if (!shown(panel)) panel.style.display = "block";
  // light up the matching menu items and dim the others
  const a = attr || "data-view";
  try {
    for (const t of doc.querySelectorAll(a === "href" ? '[href^="#"]' : `[${a}]`)) {
      const me = clean(t.getAttribute(a)) === key;
      t.classList.toggle("active", me);
      if (t.hasAttribute("aria-selected")) t.setAttribute("aria-selected", String(me));
      if (me) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    }
  } catch {}
  return true;
}

// PDFs: draw every page to an image (pdf.js) and show them as one scrollable page, so a
// PDF scrolls, mirrors and flips exactly like a web page.
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38";
export async function pdfPage(url, width) {
  const r = await fetch("/api/file?url=" + encodeURIComponent(url));
  if (!r.ok) { let m = "Could not open this PDF"; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
  const data = new Uint8Array(await r.arrayBuffer());
  const lib = await import(PDFJS + "/pdf.min.mjs");
  lib.GlobalWorkerOptions.workerSrc = PDFJS + "/pdf.worker.min.mjs";
  const pdf = await lib.getDocument({ data }).promise;
  const px = Math.min(1600, Math.max(600, Math.round((width || 800) * Math.min(2, devicePixelRatio || 1))));
  const imgs = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 40); i++) {
    const page = await pdf.getPage(i);
    const v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: px / v1.width });
    const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    imgs.push(`<img alt="Page ${i}" src="${c.toDataURL("image/jpeg", 0.85)}" style="aspect-ratio:${c.width}/${c.height}">`);
  }
  const title = esc(decodeURIComponent(new URL(url).pathname.split("/").pop() || "PDF"));
  return { title, html: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;background:#3b3f46}img{display:block;width:calc(100% - 24px);max-width:1100px;height:auto;margin:12px auto;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.4)}</style></head><body>${imgs.join("")}</body></html>` };
}

export function createGlass(root, { onState } = {}) {
  root.innerHTML = `
    <div class="g-flip">
      <div class="g-doc"><div class="g-content"></div><iframe class="g-page" sandbox="allow-same-origin" title="Page" hidden></iframe></div>
      <div class="g-cursor" hidden></div>
    </div>
    <div class="g-touch"></div>`;
  const flip = root.querySelector(".g-flip"), doc = root.querySelector(".g-doc");
  const content = root.querySelector(".g-content"), cursorEl = root.querySelector(".g-cursor");
  const frame = root.querySelector(".g-page");
  // mode "page": the real site (its layout, colours, images) in a sandboxed frame with
  // its scripts removed. mode "reader": clean text, used when the real page can't be shown.
  const s = { on: false, flip: true, mode: "reader", scale: 1, url: "", title: "", y: 0, cur: null, hover: null, history: [], fwd: [], loading: false, error: "", tab: "" };
  let loadId = 0;

  const pageDoc = () => (s.mode === "page" ? frame.contentDocument : null);
  const pageWin = () => (s.mode === "page" ? frame.contentWindow : null);
  const maxY = () => {
    const d = pageDoc();
    if (d) { const se = d.scrollingElement || d.documentElement; return Math.max(0, se.scrollHeight - frame.clientHeight); }
    return Math.max(0, content.scrollHeight - doc.clientHeight);
  };
  const applyScroll = () => {
    s.y = Math.min(maxY(), Math.max(0, s.y));
    const w = pageWin();
    if (w) w.scrollTo(0, s.y); else content.style.transform = `translateY(${-s.y}px)`;
    updateHover();
  };
  // Layout the laptop needs to draw an exact mirror of this page: the page box
  // size and, for the reader view, the computed text size and padding.
  const layout = () => {
    if (s.mode === "page") return { mode: "page", w: doc.clientWidth, h: doc.clientHeight, zoom: s.scale };
    const cs = getComputedStyle(content);
    return { mode: "reader", w: doc.clientWidth, h: doc.clientHeight, fs: parseFloat(cs.fontSize) || 20, pad: cs.padding };
  };
  const hoverText = () => (s.hover ? (s.hover.textContent || s.hover.getAttribute("aria-label") || s.hover.href || "").replace(/\s+/g, " ").trim().slice(0, 90) : "");
  const state = () => ({ url: s.url, tab: s.tab, title: s.title, mode: s.mode, y: s.y, max: maxY(), hover: hoverText(), loading: s.loading, error: s.error, flip: s.flip, canBack: s.history.length > 0, canForward: s.fwd.length > 0, view: layout() });
  const emit = () => onState && onState(state());
  let resizeT = null;
  // Screen rotation, window size or text size changes: tell the laptop the new layout.
  const relayout = () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (s.on) { applyScroll(); emit(); } }, 150); };
  addEventListener("resize", relayout);
  let lastFs = 0;
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { const fs = parseFloat(getComputedStyle(content).fontSize); if (fs !== lastFs) { lastFs = fs; relayout(); } }).observe(content);

  // The link at a point of the page as the viewer sees it (x, y in 0..1, top-left 0,0).
  // Through the sheet the reflection undoes the flip, so viewer coordinates are the
  // page's own coordinates.
  function linkAtView(x, y) {
    const d = pageDoc();
    if (d) {
      const el = d.elementFromPoint(x * frame.clientWidth, y * frame.clientHeight);
      return el && el.closest ? el.closest("a[href], " + TAB_ATTRS.map((a) => `[${a}]`).join(", ")) : null;
    }
    const r = flip.getBoundingClientRect();
    const cx = r.left + x * r.width, cy = s.flip ? r.bottom - y * r.height : r.top + y * r.height;
    for (const el of document.elementsFromPoint(cx, cy)) {
      const a = el.closest && el.closest(".g-link");
      if (a) return a;
      if (el === root) break;
    }
    return null;
  }
  const linkAtCursor = () => (s.cur ? linkAtView(s.cur.x, s.cur.y) : null);
  const hrefOf = (a) => (s.mode === "page" ? a.href || "" : a.dataset.href);
  function updateHover() {
    const h = linkAtCursor();
    if (h === s.hover) return;
    const cls = s.mode === "page" ? "airpane-hover" : "hover";
    if (s.hover) s.hover.classList.remove("hover", "airpane-hover");
    s.hover = h;
    if (h) h.classList.add(cls);
    emit();
  }
  // Follow a link: same-page anchors scroll, everything else opens through Airpane.
  function showTab(key, attr, push = true) {
    const d = pageDoc();
    if (!d || !switchTab(d, key, attr)) return false;
    if (push) { s.history.push({ url: s.url, y: s.y, tab: s.tab }); s.fwd = []; }
    s.tab = key; s.y = 0; applyScroll(); emit();
    return true;
  }
  function follow(a) {
    if (s.mode === "page") {
      const t = tabKey(a);
      if (t && showTab(t.key, t.attr)) return true;
      const h = a.getAttribute("href") || "";
      // "#section" links whose section is hidden until a script shows it
      if (/^#[\w-]+$/.test(h)) { const k = h.slice(1), el = pageDoc().getElementById(k); if (!(el && shown(el)) && showTab(k, "href")) return true; }
      if (!a.href) return false;
    }
    const href = hrefOf(a);
    if (!href || !/^https?:/i.test(href)) return false;
    const u = new URL(href), cur = s.url ? new URL(s.url) : null;
    if (cur && u.hash && u.origin + u.pathname + u.search === cur.origin + cur.pathname + cur.search && pageDoc()) {
      const t = pageDoc().getElementById(decodeURIComponent(u.hash.slice(1))) || pageDoc().getElementsByName(u.hash.slice(1))[0];
      if (t) { s.y = t.getBoundingClientRect().top + s.y; applyScroll(); emit(); }
      return true;
    }
    load(href);
    return true;
  }
  const applyScale = () => {
    content.style.setProperty("--gs", s.scale.toFixed(3));
    const d = pageDoc();
    if (d && d.documentElement) d.documentElement.style.zoom = s.scale;
  };

  async function showPage(url, id) {
    const r = await fetch("/api/page?url=" + encodeURIComponent(url) + "&w=" + Math.round(doc.clientWidth || innerWidth));
    let html, finalUrl, title;
    if (r.headers.get("x-airpane-kind") === "pdf") {
      const info = await r.json().catch(() => ({}));
      if (!info.pdf) throw new Error("Could not open that page");
      finalUrl = info.url || url;
      ({ html, title } = await pdfPage(finalUrl, doc.clientWidth || innerWidth));
    } else {
      if (!r.ok) { let m = "Could not open that page"; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
      html = await r.text();
      finalUrl = decodeURIComponent(r.headers.get("x-final-url") || encodeURIComponent(url));
      title = decodeURIComponent(r.headers.get("x-page-title") || "");
    }
    if (id !== loadId) return;
    await new Promise((ok) => { frame.onload = () => ok(); frame.hidden = false; frame.srcdoc = html; setTimeout(ok, 15000); });
    if (id !== loadId) return;
    s.mode = "page"; content.innerHTML = "";
    s.url = finalUrl; s.title = title || new URL(finalUrl).hostname;
    applyScale();
  }
  async function showReader(url, id) {
    const r = await fetch("/api/reader?url=" + encodeURIComponent(url));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not open that page");
    if (id !== loadId) return;
    s.mode = "reader"; frame.hidden = true; frame.removeAttribute("srcdoc");
    s.url = data.url; s.title = data.title;
    content.innerHTML = renderBlocks(data);
  }

  async function load(url, { push = true } = {}) {
    if (!url) return;
    const id = ++loadId;
    if (push && s.url) { s.history.push({ url: s.url, y: s.y }); s.fwd = []; }
    s.loading = true; s.error = ""; s.hover = null; s.tab = ""; emit();
    s.mode = "reader"; frame.hidden = true;
    content.innerHTML = `<p class="g-wait">Opening ${esc(url.replace(/^https?:\/\//, "").slice(0, 60))}</p>`;
    s.y = 0; applyScroll();
    try {
      try { await showPage(url, id); }
      catch { if (id === loadId) await showReader(url, id); }
    } catch (e) {
      if (id !== loadId) return;
      s.error = e.message; s.url = url; s.mode = "reader"; frame.hidden = true;
      content.innerHTML = `<p class="g-wait">Could not open this page: ${esc(e.message)}</p>`;
    }
    if (id !== loadId) return;
    s.loading = false;
    // an address with #section: open that tab, or scroll to that part of the page
    const hash = (() => { try { return decodeURIComponent(new URL(s.url).hash.slice(1)); } catch { return ""; } })();
    if (hash && s.mode === "page" && /^[\w-]+$/.test(hash)) {
      const el = pageDoc().getElementById(hash);
      if (el && shown(el)) s.y = el.getBoundingClientRect().top;
      else if (switchTab(pageDoc(), hash, "href")) { s.tab = hash; s.y = 0; }
    }
    applyScroll(); emit();
  }

  // Back / forward: another tab of the same page switches in place; anything else reloads.
  async function go(h) {
    if (h.url === s.url && s.mode === "page" && h.tab) { showTab(h.tab, null, false); s.y = h.y; applyScroll(); emit(); return; }
    await load(h.url, { push: false });
    if (h.tab) showTab(h.tab, null, false);
    s.y = h.y; applyScroll(); emit();
  }

  return {
    get state() { return state(); },
    start() { s.on = true; root.hidden = false; },
    stop() { s.on = false; root.hidden = true; },
    load,
    back() { const h = s.history.pop(); if (!h) return; if (s.url) s.fwd.push({ url: s.url, y: s.y, tab: s.tab }); return go(h); },
    forward() { const f = s.fwd.pop(); if (!f) return; if (s.url) s.history.push({ url: s.url, y: s.y, tab: s.tab }); return go(f); },
    // x, y in 0..1 of the page as the viewer sees it (top-left = 0,0).
    cursor(x, y) {
      s.cur = { x, y };
      cursorEl.hidden = false;
      cursorEl.style.left = x * 100 + "%";
      cursorEl.style.top = y * 100 + "%";
      updateHover();
    },
    hideCursor() { s.cur = null; cursorEl.hidden = true; updateHover(); },
    click(x, y) {
      if (x != null) this.cursor(x, y);
      const a = linkAtCursor();
      cursorEl.classList.remove("pulse"); void cursorEl.offsetWidth; cursorEl.classList.add("pulse");
      return a ? follow(a) : false;
    },
    scroll(dy) { s.y += dy * doc.clientHeight; applyScroll(); emit(); },
    // Touch directly on the display (no controller): tap a link, drag to scroll.
    tapAt(clientX, clientY) {
      const r = flip.getBoundingClientRect();
      const x = (clientX - r.left) / r.width, y = s.flip ? (r.bottom - clientY) / r.height : (clientY - r.top) / r.height;
      const a = linkAtView(x, y);
      return a ? follow(a) : false;
    },
    // Flipped for the sheet: dragging down shows later content. Unflipped: normal touch scrolling.
    dragBy(screenDy) { s.y += s.flip ? screenDy : -screenDy; applyScroll(); emit(); },
    // true: drawn upside down for the clear sheet's reflection; false: read directly on this screen.
    setFlip(on) { s.flip = Boolean(on); root.classList.toggle("noflip", !s.flip); updateHover(); },
    get flipped() { return s.flip; },
    // Text / page size (1 = normal).
    setScale(k) { s.scale = k; applyScale(); relayout(); },
    // Test hook: where a link is, as a 0..1 point on the page the viewer sees.
    linkPoints(max = 40) {
      const out = [], d = pageDoc();
      const list = d ? d.querySelectorAll("a[href]") : content.querySelectorAll(".g-link");
      const W = d ? frame.clientWidth : flip.getBoundingClientRect().width, H = d ? frame.clientHeight : flip.getBoundingClientRect().height;
      const fr = flip.getBoundingClientRect();
      for (const a of list) {
        const q = a.getClientRects()[0]; if (!q || q.width < 20 || q.height < 8) continue;
        let x, y;
        if (d) { x = (q.left + Math.min(q.width / 2, 40)) / W; y = (q.top + q.height / 2) / H; }
        else { x = (q.left + Math.min(q.width / 2, 40) - fr.left) / W; y = s.flip ? (fr.bottom - (q.top + q.height / 2)) / H : (q.top + q.height / 2 - fr.top) / H; }
        if (x > 0.02 && x < 0.95 && y > 0.1 && y < 0.9 && linkAtView(x, y) === a) out.push({ x, y, href: hrefOf(a), text: (a.textContent || "").trim().slice(0, 60) });
        if (out.length >= max) break;
      }
      return out;
    },
    refresh() { applyScroll(); emit(); },
    el: { flip, doc, content, frame, cursor: cursorEl },
  };
}
