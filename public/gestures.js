// Hand gestures from MediaPipe hand landmarks (21 points, image coordinates 0..1).
//   point  -> the index fingertip moves the cursor
//   pinch  -> thumb and index tips together: a short pinch clicks
//   pinch and move up/down -> scrolls
// Pure logic, no DOM, so it can be tested with synthetic hands.

const TIP_THUMB = 4, TIP_INDEX = 8, WRIST = 0, MIDDLE_BASE = 9;
const PINCH_IN = 0.32, PINCH_OUT = 0.48;   // thumb-index gap / hand size, with hysteresis
const DRAG_START = 0.035;                  // cursor movement that turns a pinch into a scroll
const CLICK_MAX_MS = 900;
const BOX = { x0: 0.18, x1: 0.82, y0: 0.12, y1: 0.72 }; // comfortable reach area in the camera image

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function cursorFrom(lm) {
  // The camera image is not mirrored; mirror it so moving your hand right moves the cursor right.
  const p = lm[TIP_INDEX];
  return { x: clamp01((1 - p.x - BOX.x0) / (BOX.x1 - BOX.x0)), y: clamp01((p.y - BOX.y0) / (BOX.y1 - BOX.y0)) };
}

export function pinchRatio(lm) {
  const size = dist(lm[WRIST], lm[MIDDLE_BASE]) || 1e-6;
  return dist(lm[TIP_THUMB], lm[TIP_INDEX]) / size;
}

export function createGestures({ smooth = 0.45, scrollGain = 1.6 } = {}) {
  let cur = null, pinched = false, start = null, dragging = false, lastY = 0;
  const history = [];

  return {
    get state() { return { cursor: cur, pinched, dragging }; },
    reset() { cur = null; pinched = false; start = null; dragging = false; history.length = 0; },
    // Returns the events for this frame: {t:"cur",x,y} | {t:"click",x,y} | {t:"scroll",dy} | {t:"lost"}
    update(lm, now) {
      const ev = [];
      if (!lm) {
        if (cur) ev.push({ t: "lost" });
        pinched = false; start = null; dragging = false; history.length = 0;
        return ev;
      }
      const raw = cursorFrom(lm);
      cur = cur ? { x: cur.x + (raw.x - cur.x) * smooth, y: cur.y + (raw.y - cur.y) * smooth } : raw;
      history.push({ ...cur, t: now });
      while (history.length > 8) history.shift();

      const r = pinchRatio(lm);
      if (!pinched && r < PINCH_IN) {
        pinched = true; dragging = false;
        // The fingertip drifts while the fingers close; click where it was just before.
        const before = history.find((h) => now - h.t <= 180) || history[0];
        start = { x: before.x, y: before.y, t: now };
        lastY = cur.y;
      } else if (pinched && r > PINCH_OUT) {
        if (!dragging && now - start.t <= CLICK_MAX_MS) ev.push({ t: "click", x: start.x, y: start.y });
        pinched = false; dragging = false; start = null;
      }

      if (pinched) {
        if (!dragging && Math.abs(cur.y - start.y) > DRAG_START) { dragging = true; lastY = cur.y; }
        if (dragging) {
          const dy = cur.y - lastY; lastY = cur.y;
          // Pull the page up (hand moves up) to read further down, like a touchscreen.
          if (Math.abs(dy) > 0.0005) ev.push({ t: "scroll", dy: -dy * scrollGain });
        }
        ev.push({ t: "cur", x: start.x, y: start.y }); // cursor holds still while pinching
      } else {
        ev.push({ t: "cur", x: cur.x, y: cur.y });
      }
      return ev;
    },
  };
}

// Synthetic hand for tests: fingertip at (x, y) in image coords, thumb gap as a fraction of hand size.
export function fakeHand(x, y, gap = 0.8, size = 0.18) {
  const lm = Array.from({ length: 21 }, () => ({ x, y: y + size }));
  lm[WRIST] = { x, y: y + size * 1.6 };
  lm[MIDDLE_BASE] = { x, y: y + size * 0.6 };
  lm[TIP_INDEX] = { x, y };
  lm[TIP_THUMB] = { x: x + gap * size, y };
  return lm;
}
