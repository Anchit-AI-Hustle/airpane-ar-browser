// Laptop controller gestures, kept as easy as possible. Each action has its own
// natural hand shape, and loose shapes still count:
//   Point with your index finger ....... move the cursor (other fingers can be loose)
//   Pinch thumb and index .............. click
//   Open hand, move up or down ......... scroll, like pushing the page
//   Open hand, flick to the left ....... back
//   Thumbs up / thumbs down ............ bigger / smaller text
//   Fist for a second .................. pause or resume
// Pure logic, no DOM, so it can be tested with real recorded hands.
import { classify, palmCenter } from "./poses.js";

const TIP_INDEX = 8;
const BOX = { x0: 0.18, x1: 0.82, y0: 0.12, y1: 0.72 }; // comfortable reach area in the camera image
const POSE_FRAMES = 2;          // a new hand shape must be seen this many frames in a row
const CLICK_MAX_MS = 1200;      // any normal pinch clicks; only a very long one is ignored
const SWIPE_MS = 350, SWIPE_DIST = 0.16, SWIPE_BLOCK_MS = 700;
const HOLD = { thumbs_up: 400, thumbs_down: 400, fist: 1000 };
const REPEAT = { thumbs_up: 550, thumbs_down: 550 };
// Shapes that move the cursor: any hand with the index finger up that is not an open
// hand. A sloppy point (middle finger half up, pinky out) still moves the cursor.
const MOVE = new Set(["point", "peace", "three", "rock"]);
// Shapes that scroll: an open hand, with or without the thumb tucked in.
const OPEN = new Set(["open_palm", "four"]);
export const GESTURE_HELP = [
  ["Point with your index finger", "move the cursor"],
  ["Pinch thumb and index", "click"],
  ["Open hand, move up or down", "scroll"],
  ["Open hand, flick left", "go back"],
  ["Thumbs up / down", "bigger / smaller text"],
  ["Fist for a second", "pause or resume"],
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Camera landmarks ({x, y}, not mirrored) -> mirrored [x, y] pairs, so moving your hand
// to your right moves things right.
const mirror = (lm) => lm.map((p) => [1 - p.x, p.y]);

export function cursorFrom(lm) {
  const p = lm[TIP_INDEX];
  return { x: clamp01((1 - p.x - BOX.x0) / (BOX.x1 - BOX.x0)), y: clamp01((p.y - BOX.y0) / (BOX.y1 - BOX.y0)) };
}

export function createGestures({ smooth = 0.45, scrollGain = 1.6 } = {}) {
  let cur = null, pose = "none", raw = "none", rawN = 0, since = 0, paused = false;
  let pinch = null, scrollRef = null, swipe = [], swipeBlock = 0, held = {}, missed = false;
  const history = [];

  const kind = (p) => (MOVE.has(p) ? "move" : OPEN.has(p) ? "open" : p);
  const setPose = (p, now) => { if (p !== pose) { if (kind(p) !== kind(pose)) held = {}; pose = p; since = now; } };

  return {
    get state() { return { cursor: cur, pose, paused, pinched: pose === "pinch", dragging: false }; },
    reset() { cur = null; missed = false; pose = raw = "none"; rawN = 0; pinch = null; scrollRef = null; swipe = []; history.length = 0; held = {}; },
    setPaused(v) { paused = Boolean(v); },
    // Events: {t:"cur",x,y} {t:"click",x,y} {t:"scroll",dy} {t:"back"} {t:"size",up} {t:"pause",value} {t:"lost"}
    update(lm, now) {
      const ev = [];
      // The tracker sometimes misses the hand for a single frame: ignore one missed frame
      // instead of dropping the gesture half way through.
      if (!lm && !missed && pose !== "none") { missed = true; return ev; }
      missed = false;
      if (!lm) {
        if (cur) ev.push({ t: "lost" });
        cur = null;
        setPose("none", now); raw = "none"; rawN = 0; pinch = null; scrollRef = null; swipe = []; history.length = 0;
        return ev;
      }
      const m = mirror(lm);
      const r = classify(m, pose === "pinch");
      if (r === raw) rawN++; else { raw = r; rawN = 1; }
      const prev = pose;
      if (r !== pose && rawN >= POSE_FRAMES) setPose(r, now);
      // While the hand is changing shape, the old pose still counts but the landmarks
      // already belong to the new one: ignore motion on those frames. Loose variants of
      // the same shape (point / V, open hand / four fingers) count as the same shape.
      const certain = kind(r) === kind(pose);

      // Holds (fist works even while paused, so you can always resume)
      for (const p of Object.keys(HOLD)) {
        if (pose !== p || !certain) continue;
        if (paused && p !== "fist") continue;
        const h = held[p] || (held[p] = { fired: false, last: 0 });
        if (!h.fired && now - since >= HOLD[p]) { h.fired = true; h.last = now; fire(p); }
        else if (h.fired && REPEAT[p] && now - h.last >= REPEAT[p]) { h.last = now; fire(p); }
      }
      function fire(p) {
        if (p === "fist") { paused = !paused; ev.push({ t: "pause", value: paused }); if (paused) ev.push({ t: "lost" }); }
        else ev.push({ t: "size", up: p === "thumbs_up" });
      }
      if (paused) { pinch = null; scrollRef = null; swipe = []; return ev; }

      // Cursor (index fingertip, smoothed)
      const c = cursorFrom(lm);
      cur = cur ? { x: cur.x + (c.x - cur.x) * smooth, y: cur.y + (c.y - cur.y) * smooth } : c;
      if (MOVE.has(pose) && certain) {
        history.push({ ...cur, t: now });
        while (history.length > 10) history.shift();
        ev.push({ t: "cur", x: cur.x, y: cur.y });
      }

      // Click: a pinch, at the spot you pointed to just before pinching
      if (pose === "pinch" && prev !== "pinch") {
        const before = history.filter((h) => now - h.t >= 90).pop() || history[history.length - 1] || cur;
        pinch = { t: now, x: before.x, y: before.y };
      } else if (pose !== "pinch" && pinch) {
        if (now - pinch.t <= CLICK_MAX_MS) ev.push({ t: "click", x: pinch.x, y: pinch.y });
        pinch = null;
      }

      // Open hand: up / down scrolls (hand up = read further down, like pushing paper),
      // a quick flick to the left goes back.
      if (OPEN.has(pose) && certain) {
        const pc = palmCenter(m);
        if (now >= swipeBlock) {
          swipe.push({ t: now, x: pc[0], y: pc[1] });
          while (swipe.length && swipe[0].t < now - SWIPE_MS) swipe.shift();
          const dx = pc[0] - swipe[0].x, dy = pc[1] - swipe[0].y;
          if (-dx > SWIPE_DIST && Math.abs(dx) > 2 * Math.abs(dy)) {
            ev.push({ t: "back" }); swipe = []; swipeBlock = now + SWIPE_BLOCK_MS; scrollRef = null;
            return ev;
          }
        }
        if (scrollRef) {
          const dy = pc[1] - scrollRef[1], dx = pc[0] - scrollRef[0];
          // mostly-vertical movement only, so a sideways flick does not scroll
          if (Math.abs(dy) > 0.0015 && Math.abs(dy) > Math.abs(dx)) ev.push({ t: "scroll", dy: -dy * scrollGain * 2 });
        }
        scrollRef = pc;
      } else { scrollRef = null; swipe = []; }
      return ev;
    },
  };
}

// Test helper: a recorded hand pose ([[x, y]] mirrored) placed with its palm at (cx, cy),
// returned as camera landmarks ({x, y}, not mirrored) like MediaPipe gives them.
export function placeHand(mirroredLm, cx, cy) {
  const pc = palmCenter(mirroredLm);
  return mirroredLm.map(([x, y]) => ({ x: 1 - (x - pc[0] + cx), y: y - pc[1] + cy }));
}
