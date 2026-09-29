// Laptop controller gestures. Four, and no two share a movement:
//   Open hand, move it ................ move the cursor
//   Close the open hand into a fist ... click (once per fist)
//   Index finger, move up / down ...... scroll up / down
//   Index finger, quick flick left / right ... back / forward
// The index finger decides up-down or sideways from how a movement starts and keeps
// to that until the finger rests, so a scroll never turns into back / forward and a
// flick never scrolls. A fist only clicks when it closes straight from an open hand.
// Pure logic, no DOM, so it can be tested with real recorded hands.
import { classify, palmCenter } from "./poses.js";

const TIP_INDEX = 8;
const BOX = { x0: 0.2, x1: 0.8, y0: 0.15, y1: 0.7 }; // comfortable reach area in the camera image
const POSE_FRAMES = 2;          // a new hand shape must be seen this many frames in a row
const CLICK_LOOKBACK_MS = 150;  // click where the cursor was just before the hand started closing
const CLICK_FROM_OPEN_MS = 700; // or, if some other shape came between, within this long of it being open
const SWIPE_MS = 400, SWIPE_DIST = 0.14, SWIPE_BLOCK_MS = 700;
const AXIS_V = 0.02, AXIS_H = 0.035; // movement that decides up-down or sideways
const REST_MS = 350, REST_STEP = 0.003; // a finger this still for this long can start a new movement
const SCROLL_GAIN = 3.2, SCROLL_DEAD = 0.002;
const OPEN = new Set(["open_palm", "four"]);          // move the cursor
const INDEX = new Set(["point", "peace"]);            // scroll and flick (a loose point still counts)
export const GESTURE_HELP = [
  ["Open hand, move it", "move the cursor"],
  ["Close the open hand into a fist", "click"],
  ["Index finger, move up / down", "scroll"],
  ["Index finger, quick flick left / right", "back / forward"],
];

// Which line of the gesture guide a hand shape belongs to (to highlight it live).
export const gestureKind = (pose) => (OPEN.has(pose) ? "open" : pose === "fist" ? "fist" : INDEX.has(pose) ? "index" : "");

const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Camera landmarks ({x, y}, not mirrored) -> mirrored [x, y] pairs, so moving your hand
// to your right moves things right.
const mirror = (lm) => lm.map((p) => [1 - p.x, p.y]);
const toScreen = ([x, y]) => ({ x: clamp01((x - BOX.x0) / (BOX.x1 - BOX.x0)), y: clamp01((y - BOX.y0) / (BOX.y1 - BOX.y0)) });

// Cursor from the palm centre: steadier than a fingertip and it barely moves when the
// hand closes into a fist, so the click lands where you aimed.
export function cursorFrom(lm) { return toScreen(palmCenter(mirror(lm))); }

// One Euro filter: smooth when the hand is still, responsive when it moves fast.
function oneEuro({ minCutoff = 1.2, beta = 8, dCutoff = 1 } = {}) {
  let x = null, dx = 0, t = 0;
  const a = (fc, dt) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
  return {
    reset() { x = null; },
    f(v, now) {
      if (x === null) { x = v; t = now; return v; }
      const dt = Math.max(1e-3, (now - t) / 1000); t = now;
      const d = (v - x) / dt; dx += a(dCutoff, dt) * (d - dx);
      x += a(minCutoff + beta * Math.abs(dx), dt) * (v - x);
      return x;
    },
  };
}

export function createGestures() {
  let pose = "none", raw = "none", rawN = 0, since = 0, paused = false, missed = false;
  let cur = null, scrollRef = null, swipe = [], swipeBlock = 0, clicked = false;
  let axis = null, lastMove = 0, lastOpen = -1e9, fistFromOpen = false;
  const history = [];
  const fx = oneEuro(), fy = oneEuro();

  const kind = (p) => (OPEN.has(p) ? "open" : INDEX.has(p) ? "index" : p);
  const setPose = (p, now) => {
    if (p === pose) return;
    // a fist counts as a click only if the hand closed straight from open
    if (p === "fist") fistFromOpen = OPEN.has(pose) || now - lastOpen <= CLICK_FROM_OPEN_MS;
    if (kind(p) !== kind(pose)) since = now;
    pose = p;
  };
  const clear = () => { scrollRef = null; swipe = []; axis = null; };

  return {
    get state() { return { cursor: cur, pose, paused, pinched: pose === "fist", dragging: false }; },
    reset() { cur = null; missed = false; pose = raw = "none"; rawN = 0; clicked = false; clear(); history.length = 0; lastOpen = -1e9; fx.reset(); fy.reset(); },
    setPaused(v) { paused = Boolean(v); },
    // Events: {t:"cur",x,y} {t:"click",x,y} {t:"scroll",dy} {t:"back"} {t:"forward"} {t:"lost"}
    update(lm, now) {
      const ev = [];
      // The tracker sometimes misses the hand for one frame: ignore a single missed frame.
      if (!lm && !missed && pose !== "none") { missed = true; return ev; }
      missed = false;
      if (!lm) {
        if (cur) ev.push({ t: "lost" });
        cur = null; setPose("none", now); raw = "none"; rawN = 0; clicked = false; clear(); history.length = 0; fx.reset(); fy.reset();
        return ev;
      }
      if (paused) return ev;
      const m = mirror(lm);
      const r = classify(m);
      if (r === raw) rawN++; else { raw = r; rawN = 1; }
      if (r !== pose && rawN >= POSE_FRAMES) setPose(r, now);
      // While the hand changes shape the old pose still counts but the landmarks belong
      // to the new one, so motion on those frames is ignored.
      const certain = kind(r) === kind(pose);

      // Open hand: move the cursor (smoothed)
      if (OPEN.has(pose) && certain) {
        const c = cursorFrom(lm);
        cur = { x: fx.f(c.x, now), y: fy.f(c.y, now) };
        history.push({ ...cur, t: now });
        while (history.length > 20) history.shift();
        ev.push({ t: "cur", x: cur.x, y: cur.y });
        lastOpen = now;
      }

      // Fist: one click at the spot the open hand pointed to just before closing.
      // Only a hand that was open a moment ago clicks: curling a pointing finger
      // (or any other shape) into a fist does nothing.
      if (pose === "fist") {
        if (!clicked && history.length && fistFromOpen) {
          const aim = history.filter((h) => now - h.t >= CLICK_LOOKBACK_MS).pop() || history[0];
          ev.push({ t: "click", x: aim.x, y: aim.y });
        }
        clicked = true;
      } else if (OPEN.has(pose)) clicked = false;
      if (!OPEN.has(pose) && pose !== "fist") history.length = 0;

      // Index finger: up / down scrolls, a quick flick left / right goes back / forward.
      if (INDEX.has(pose) && certain) {
        const tip = m[TIP_INDEX];
        const step = scrollRef ? Math.hypot(tip[0] - scrollRef[0], tip[1] - scrollRef[1]) : 0;
        if (step > REST_STEP) lastMove = now;
        // a rested finger may start a new movement in either direction
        if (axis && now - lastMove > REST_MS) { axis = null; swipe = []; }
        swipe.push({ t: now, x: tip[0], y: tip[1] });
        // keep the last SWIPE_MS of movement, but always at least the previous frame so a
        // slow camera (a frame or two a second) can still tell up-down from sideways
        while (swipe.length > 2 && swipe[0].t < now - SWIPE_MS) swipe.shift();
        const wx = tip[0] - swipe[0].x, wy = tip[1] - swipe[0].y;
        const quick = now - swipe[0].t <= SWIPE_MS + 50; // a flick must be fast, whatever the frame rate
        if (!axis && now >= swipeBlock) {
          if (Math.abs(wy) > AXIS_V && Math.abs(wy) > 1.5 * Math.abs(wx)) axis = "v";
          else if (Math.abs(wx) > AXIS_H && Math.abs(wx) > 1.5 * Math.abs(wy)) axis = "h";
        }
        if (axis === "h" && quick && now >= swipeBlock && Math.abs(wx) > SWIPE_DIST && Math.abs(wx) > 2 * Math.abs(wy)) {
          ev.push({ t: wx < 0 ? "back" : "forward" });
          // bringing the finger back must not flick the other way: wait for it to rest
          swipe = []; swipeBlock = now + SWIPE_BLOCK_MS; axis = "done";
        }
        if (axis === "v" && scrollRef) {
          const dy = tip[1] - scrollRef[1], dx = tip[0] - scrollRef[0];
          // finger up scrolls up, finger down scrolls down
          if (Math.abs(dy) > SCROLL_DEAD && Math.abs(dy) > Math.abs(dx)) ev.push({ t: "scroll", dy: dy * SCROLL_GAIN });
        }
        scrollRef = tip;
      } else clear();

      // Any other shape (thumbs up, a loose hand...) does nothing.
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
