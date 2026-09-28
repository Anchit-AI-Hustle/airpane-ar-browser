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
      <div class="g-doc"><div class="g-content"></div></div>
      <div class="g-cursor" hidden></div>
    </div>`;
  const flip = root.querySelector(".g-flip"), doc = root.querySelector(".g-doc");
  const content = root.querySelector(".g-content"), cursorEl = root.querySelector(".g-cursor");
  const s = { on: false, url: "", title: "", y: 0, cur: null, hover: null, history: [], loading: false, error: "" };

  const maxY = () => Math.max(0, content.scrollHeight - doc.clientHeight);
  const applyScroll = () => { s.y = Math.min(maxY(), Math.max(0, s.y)); content.style.transform = `translateY(${-s.y}px)`; updateHover(); };
  // Layout the laptop needs to draw an exact mirror of this page: the page box
  // size and the computed text size and padding (these depend on this screen).
  const layout = () => { const cs = getComputedStyle(content); return { w: doc.clientWidth, h: doc.clientHeight, fs: parseFloat(cs.fontSize) || 20, pad: cs.padding }; };
  const state = () => ({ url: s.url, title: s.title, y: s.y, max: maxY(), hover: s.hover ? s.hover.textContent : "", loading: s.loading, error: s.error, canBack: s.history.length > 0, view: layout() });
  const emit = () => onState && onState(state());
  let resizeT = null;
  // Screen rotation, window size or text size changes: tell the laptop the new layout.
  const relayout = () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (s.on) { applyScroll(); emit(); } }, 150); };
  addEventListener("resize", relayout);
  let lastFs = 0;
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { const fs = parseFloat(getComputedStyle(content).fontSize); if (fs !== lastFs) { lastFs = fs; relayout(); } }).observe(content);

  // The link under the cursor, found by real hit-testing through the flip.
  // Where the cursor really is on screen (the page is flipped, so viewer y counts
  // from the bottom). Computed, not read from the cursor dot, which may be mid-animation.
  function linkAt(clientX, clientY) {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const a = el.closest && el.closest(".g-link");
      if (a) return a;
      if (el === root) break;
    }
    return null;
  }
  function linkAtCursor() {
    if (!s.cur) return null;
    const r = flip.getBoundingClientRect();
    return linkAt(r.left + s.cur.x * r.width, r.bottom - s.cur.y * r.height);
  }
  function updateHover() {
    const h = linkAtCursor();
    if (h === s.hover) return;
    if (s.hover) s.hover.classList.remove("hover");
    s.hover = h;
    if (h) h.classList.add("hover");
    emit();
  }

  async function load(url, { push = true } = {}) {
    if (!url) return;
    if (push && s.url) s.history.push({ url: s.url, y: s.y });
    s.loading = true; s.error = ""; emit();
    content.innerHTML = `<p class="g-wait">Opening ${esc(url.replace(/^https?:\/\//, "").slice(0, 60))}</p>`;
    s.y = 0; applyScroll();
    try {
      const r = await fetch("/api/reader?url=" + encodeURIComponent(url));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Could not open that page");
      s.url = data.url; s.title = data.title;
      content.innerHTML = renderBlocks(data);
    } catch (e) {
      s.error = e.message; s.url = url;
      content.innerHTML = `<p class="g-wait">Could not open this page: ${esc(e.message)}</p>`;
    }
    s.loading = false;
    applyScroll(); emit();
  }

  return {
    get state() { return state(); },
    start() { s.on = true; root.hidden = false; },
    stop() { s.on = false; root.hidden = true; },
    load,
    back() { const h = s.history.pop(); if (h) load(h.url, { push: false }).then(() => { s.y = h.y; applyScroll(); }); },
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
      if (a) load(a.dataset.href);
      return Boolean(a);
    },
    scroll(dy) { s.y += dy * doc.clientHeight; applyScroll(); emit(); },
    // Touch directly on the display (no controller): tap a link, drag to scroll.
    tapAt(clientX, clientY) {
      const a = linkAt(clientX, clientY);
      if (a) load(a.dataset.href);
      return Boolean(a);
    },
    dragBy(screenDy) { s.y += screenDy; applyScroll(); emit(); }, // the page is flipped, so dragging down shows later content
    refresh() { applyScroll(); emit(); },
    el: { flip, doc, content, cursor: cursorEl },
  };
}
