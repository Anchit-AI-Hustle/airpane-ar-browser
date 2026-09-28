// Pyramid hologram (Pepper's ghost) for a phone or tablet lying flat.
//
// A small clear pyramid sits upside down on the middle of the screen. Each face
// is a 45 degree half-mirror that reflects the part of the screen in front of it,
// so the viewer sees that picture standing upright in mid-air inside the pyramid.
// No camera, no glasses: the "air" is the reflection.
//
// The screen shows the page four times, one per face. For the face towards the
// bottom edge, the picture is drawn with its top pointing outwards (a vertical
// flip only); the reflection turns it upright and readable. The other three are
// the same picture rotated 90, 180 and 270 degrees around the centre. Each copy
// is clipped to its triangle-shaped slice of the screen so they never overlap.

const IW = 560, IH = 315;           // laid out at a narrow phone width so the reflected text is big enough to read
const PAGES = 4;                    // how many screens tall each copy is (for auto-scroll)
const ANGLES = [0, 90, 180, 270];   // bottom, left, top, right faces

export function layoutFor(W, H, size = 0.96) {
  const S = Math.min(W, H) * size;
  const vw = S * 0.52;              // width of one picture
  const vh = vw * (IH / IW);        // its height (outwards from the centre)
  const g = S * 0.1;                // gap between the centre and the picture's inner edge
  return { S, vw, vh, g, cx: W / 2, cy: H / 2, scale: vw / IW };
}

export function createPyramid(root) {
  const views = ANGLES.map((a) => {
    const wrap = document.createElement("div");
    wrap.className = "pyr-view";
    const clip = document.createElement("div");
    clip.className = "pyr-clip";
    const frame = document.createElement("iframe");
    frame.setAttribute("tabindex", "-1");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.setAttribute("allow", "autoplay; encrypted-media");
    clip.appendChild(frame);
    wrap.appendChild(clip);
    root.appendChild(wrap);
    return { a, wrap, frame };
  });
  const mark = document.createElement("div");
  mark.className = "pyr-mark";
  root.appendChild(mark);

  const s = { on: false, size: 0.96, dark: true, scroll: true, y: 0, dir: 1, pause: 90, url: "", L: null, raf: 0 };

  function layout() {
    const L = (s.L = layoutFor(innerWidth, innerHeight, s.size));
    const { vw, vh, g, cx, cy, scale } = L;
    // Keep only the triangle of the screen that this face reflects: |x| <= distance from centre.
    const poly = `polygon(${vw / 2 - g}px 0px, ${vw / 2 + g}px 0px, ${vw / 2 + g + vh}px ${vh}px, ${vw / 2 - g - vh}px ${vh}px)`;
    for (const v of views) {
      Object.assign(v.wrap.style, {
        left: cx - vw / 2 + "px", top: cy + g + "px", width: vw + "px", height: vh + "px",
        transformOrigin: `${vw / 2}px ${-g}px`, transform: `rotate(${v.a}deg)`, clipPath: poly, webkitClipPath: poly,
      });
      Object.assign(v.frame.style, { width: IW + "px", height: IH * PAGES + "px" });
    }
    const m = Math.max(10, g * 0.9);
    Object.assign(mark.style, { width: m + "px", height: m + "px", left: cx - m / 2 + "px", top: cy - m / 2 + "px" });
    apply();
  }

  function apply() {
    if (!s.L) return;
    for (const v of views) {
      v.frame.style.transform = `translateY(${(-s.y * s.L.scale).toFixed(2)}px) scale(${s.L.scale.toFixed(5)})`;
      v.frame.style.filter = s.dark ? "invert(1) hue-rotate(180deg)" : "none";
    }
  }

  // Slow synced auto-scroll: every copy shows the same part of the page at the same time.
  function tick() {
    if (!s.on) return;
    if (s.scroll) {
      if (s.pause > 0) s.pause--;
      else {
        s.y += s.dir * 0.6;
        const max = IH * (PAGES - 1);
        if (s.y >= max) { s.y = max; s.dir = -1; s.pause = 120; }
        if (s.y <= 0) { s.y = 0; s.dir = 1; s.pause = 180; }
      }
      apply();
    }
    s.raf = requestAnimationFrame(tick);
  }

  function onResize() { if (s.on) layout(); }

  return {
    get state() { return { on: s.on, size: s.size, dark: s.dark, scroll: s.scroll, y: s.y, url: s.url, layout: s.L }; },
    start() {
      s.on = true;
      root.hidden = false;
      layout();
      addEventListener("resize", onResize);
      cancelAnimationFrame(s.raf);
      s.raf = requestAnimationFrame(tick);
    },
    stop() {
      s.on = false;
      root.hidden = true;
      cancelAnimationFrame(s.raf);
      removeEventListener("resize", onResize);
      for (const v of views) v.frame.src = "about:blank";
      s.url = "";
    },
    show(url) {
      s.url = url; s.y = 0; s.dir = 1; s.pause = 90;
      for (const v of views) v.frame.src = url;
      apply();
    },
    clear() { s.url = ""; for (const v of views) v.frame.src = "about:blank"; },
    setSize(x) { s.size = Math.max(0.5, Math.min(1, x)); layout(); },
    setDark(on) { s.dark = !!on; apply(); },
    setScroll(on) { s.scroll = !!on; },
    frames: () => views.map((v) => v.frame),
  };
}
