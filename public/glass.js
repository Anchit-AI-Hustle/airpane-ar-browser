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
  const s = { on: false, flip: true, mode: "reader", scale: 1, url: "", title: "", y: 0, cur: null, hover: null, history: [], fwd: [], loading: false, error: "" };
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
  const state = () => ({ url: s.url, title: s.title, mode: s.mode, y: s.y, max: maxY(), hover: hoverText(), loading: s.loading, error: s.error, flip: s.flip, canBack: s.history.length > 0, canForward: s.fwd.length > 0, view: layout() });
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
      return el && el.closest ? el.closest("a[href]") : null;
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
  const hrefOf = (a) => (s.mode === "page" ? a.href : a.dataset.href);
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
  function follow(a) {
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
    if (!r.ok) { let m = "Could not open that page"; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
    const html = await r.text();
    if (id !== loadId) return;
    const finalUrl = decodeURIComponent(r.headers.get("x-final-url") || encodeURIComponent(url));
    const title = decodeURIComponent(r.headers.get("x-page-title") || "");
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
    s.loading = true; s.error = ""; s.hover = null; emit();
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
    applyScroll(); emit();
  }

  return {
    get state() { return state(); },
    start() { s.on = true; root.hidden = false; },
    stop() { s.on = false; root.hidden = true; },
    load,
    back() { const h = s.history.pop(); if (!h) return; if (s.url) s.fwd.push({ url: s.url, y: s.y }); return load(h.url, { push: false }).then(() => { s.y = h.y; applyScroll(); emit(); }); },
    forward() { const f = s.fwd.pop(); if (!f) return; if (s.url) s.history.push({ url: s.url, y: s.y }); return load(f.url, { push: false }).then(() => { s.y = f.y; applyScroll(); emit(); }); },
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
