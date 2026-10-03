// Hand gestures. Each one is a different hand shape or a different pointing direction,
// so no two can be mixed up, and none depends on which way the hand happens to be moving:
//   Open hand, move it ................ move the cursor
//   Close the open hand into a fist ... click (once per fist)
//   Index finger pointing up .......... scroll up (keeps scrolling while you point)
//   Index finger pointing down ........ scroll down (keeps scrolling while you point)
//   Index finger pointing left / right  back / forward (once per point)
//   Pinch (thumb and index touching) .. grab the page; swing and let go to throw it
//                                       out into the air (let go slowly: it drops back)
// Moving the hand never scrolls, so bringing it back can't undo a scroll. A pointing
// direction only counts after it has been held steadily for a moment, and pointing
// in between two directions (diagonally) does nothing. A fist only clicks when it closes
// straight from an open hand.
// Pure logic, no DOM, so it can be tested with real recorded hands.
import { classify, palmCenter } from "./poses.js";

const TIP_INDEX = 8;
const BOX = { x0: 0.2, x1: 0.8, y0: 0.15, y1: 0.7 }; // comfortable reach area in the camera image
const POSE_FRAMES = 2;          // a new hand shape must be seen this many frames in a row
const CLICK_LOOKBACK_MS = 150;  // click where the cursor was just before the hand started closing
const CLICK_FROM_OPEN_MS = 700; // or, if some other shape came between, within this long of it being open
const DIR_MS = 250;          // a pointing direction must be held this long (and 2 frames) to count
const DIR_HALF = 32;         // degrees either side of straight up / down / left / right; the rest is dead zone
const DIR_KEEP = 42;         // once pointing one way, it stays that way until the finger turns this far
const SCROLL_SPEED = 0.45, SCROLL_MAX = 1.4, SCROLL_RAMP_MS = 2000; // screens a second, speeding up while held
const MAX_STEP_S = 1;        // a slow camera scrolls by elapsed time, but never more than this at once
const OPEN = new Set(["open_palm", "four"]);          // move the cursor
const INDEX = new Set(["point", "peace"]);            // scroll and flick (a loose point still counts)
// Throw: how fast (screen widths a second) and how far the pinched hand must travel within
// THROW_MS, in the last THROW_RECENT_MS before letting go, or how fast it must come towards the camera.
const THROW_RECENT_MS = 500, THROW_MS = 320, THROW_SPEED = 0.9, THROW_DIST = 0.1, THROW_TOWARD = 1.2, THROW_SLOW_DIST = 0.22;
export const GESTURE_HELP = [
  ["Open hand, move it", "move the cursor"],
  ["Close the open hand into a fist", "click"],
  ["Point up / down", "scroll up / down"],
  ["Point left / right", "back / forward"],
  ["Pinch, swing and let go", "throw the page into the air"],
];

// Which line of the gesture guide a hand shape belongs to (to highlight it live).
// dir: the pointing direction ("up", "down", "left", "right") when pointing.
export const gestureKind = (pose, dir = "") => (OPEN.has(pose) ? "open" : pose === "fist" ? "fist" : INDEX.has(pose) ? (dir ? "point-" + dir : "point") : pose === "pinch" ? "pinch" : "");

// Which way the index finger points ([x, y] mirrored landmarks): from its knuckle to its tip.
// "" when it points in between two directions. keep: the direction it pointed until now,
// which it keeps a little further round, so a finger near the edge doesn't flicker.
const DIRS = { up: -90, down: 90, right: 0, left: 180 };
export function pointDir(m, keep = "") {
  const a = (Math.atan2(m[TIP_INDEX][1] - m[5][1], m[TIP_INDEX][0] - m[5][0]) * 180) / Math.PI; // 0 right, 90 down
  const off = (t) => Math.abs(((a - t + 540) % 360) - 180);
  if (keep && off(DIRS[keep]) <= DIR_KEEP) return keep;
  for (const [k, t] of Object.entries(DIRS)) if (off(t) <= DIR_HALF) return k;
  return "";
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Camera landmarks ({x, y}, not mirrored) -> mirrored [x, y] pairs, so moving your hand
// to your right moves things right.
const mirror = (lm) => lm.map((p) => [1 - p.x, p.y]);
const toBox = ([x, y]) => ({ x: (x - BOX.x0) / (BOX.x1 - BOX.x0), y: (y - BOX.y0) / (BOX.y1 - BOX.y0) });
const toScreen = (p) => { const b = toBox(p); return { x: clamp01(b.x), y: clamp01(b.y) }; };

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
  let cur = null, clicked = false, lastOpen = -1e9, fistFromOpen = false;
  // pointing: the candidate direction, how many frames / since when, the direction acted on
  let dCand = "", dN = 0, dSince = 0, dir = "", dirSince = 0, lastT = 0, fired = "";
  let held = null; // pinch: [{t, x, y, s}] where the pinched hand has been (s = its size, bigger = closer)
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
  const clear = () => { dCand = ""; dN = 0; dir = ""; fired = ""; };

  return {
    get state() { return { cursor: cur, pose, dir, paused, pinched: pose === "fist", dragging: false }; },
    reset() { cur = null; missed = false; pose = raw = "none"; rawN = 0; clicked = false; clear(); history.length = 0; lastOpen = -1e9; held = null; fx.reset(); fy.reset(); },
    setPaused(v) { paused = Boolean(v); },
    // Events: {t:"cur",x,y} {t:"click",x,y} {t:"scroll",dy} {t:"back"} {t:"forward"} {t:"lost"}
    //         {t:"grab",x,y} {t:"hold",x,y} {t:"throw",x,y,vx,vy,vz} {t:"drop"}
    update(lm, now) {
      const ev = [];
      // Letting go of a pinch: a quick swing (or a push towards the camera) throws, anything else drops.
      const release = () => {
        const h = held; held = null;
        const last = h[h.length - 1];
        // the fastest recent stretch of the swing: the hand may slow down a moment before letting go
        let best = null;
        for (let j = 1; j < h.length; j++) {
          const q = h[j];
          if (q.t < last.t - THROW_RECENT_MS) continue;
          for (let i = j - 1; i >= 0; i--) {
            const p = h[i], dt = (q.t - p.t) / 1000;
            // a slow camera (a frame or two a second) only sees the start and end of a swing
            const slow = i === j - 1 && q.t - p.t > THROW_MS;
            if (q.t - p.t > THROW_MS && !slow) break;
            const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy), grow = q.s / p.s, vz = (grow - 1) / Math.max(dt, 1e-3);
            const ok = (d >= THROW_DIST && d / dt >= THROW_SPEED) || (slow && d >= THROW_SLOW_DIST) || (vz >= THROW_TOWARD && grow > 1.15);
            if (ok && (!best || d / dt > best.sp)) best = { sp: d / dt, vx: dx / dt, vy: dy / dt, vz };
            if (slow) break;
          }
        }
        ev.push(best ? { t: "throw", x: clamp01(last.x), y: clamp01(last.y), vx: best.vx, vy: best.vy, vz: best.vz } : { t: "drop" });
      };
      // The tracker sometimes misses the hand for one frame: ignore a single missed frame.
      if (!lm && !missed && pose !== "none") { missed = true; return ev; }
      missed = false;
      if (!lm) {
        if (held) release(); // the hand swung out of view while holding the page
        if (cur) ev.push({ t: "lost" });
        cur = null; setPose("none", now); raw = "none"; rawN = 0; clicked = false; clear(); history.length = 0; fx.reset(); fy.reset();
        return ev;
      }
      if (paused) return ev;
      const m = mirror(lm);
      const r = classify(m, pose === "pinch");
      if (r === raw) rawN++; else { raw = r; rawN = 1; }
      if (r !== pose && rawN >= POSE_FRAMES) setPose(r, now);

      // Pinch: grab the page, it follows the hand; letting go throws or drops it.
      if (pose === "pinch") {
        // not clamped to the screen, so a swing past the edge still counts at full speed
        const b = toBox(palmCenter(m)), c = { x: clamp01(b.x), y: clamp01(b.y) }, sz = Math.hypot(m[0][0] - m[9][0], m[0][1] - m[9][1]);
        // only frames that still look like a pinch: an opening hand has another size and centre
        if (!held) { held = [{ t: now, x: b.x, y: b.y, s: sz }]; ev.push({ t: "grab", x: c.x, y: c.y }); }
        else if (r === "pinch") { held.push({ t: now, x: b.x, y: b.y, s: sz }); ev.push({ t: "hold", x: c.x, y: c.y }); }
        while (held.length > 2 && held[0].t < now - 1000) held.shift();
      } else if (held) release();
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

      // Index finger: the direction it points decides the action, held steadily.
      if (INDEX.has(pose) && certain) {
        const d = pointDir(m, dir || dCand);
        if (d === dCand) dN++; else { dCand = d; dN = 1; dSince = now; }
        const steady = dN >= POSE_FRAMES && now - dSince >= DIR_MS;
        if (steady && d !== dir) { dir = d; dirSince = now; lastT = now; if (d === "up" || d === "down") fired = ""; }
        else if (!steady && d !== dir && dir) { dir = ""; } // wavering: stop until it settles
        if (dir === "up" || dir === "down") {
          const step = Math.min(MAX_STEP_S, (now - lastT) / 1000);
          const speed = SCROLL_SPEED + (SCROLL_MAX - SCROLL_SPEED) * Math.min(1, (now - dirSince) / SCROLL_RAMP_MS);
          if (step > 0) ev.push({ t: "scroll", dy: (dir === "up" ? -1 : 1) * speed * step });
        } else if ((dir === "left" || dir === "right") && fired !== dir) {
          ev.push({ t: dir === "left" ? "back" : "forward" });
          // once: to go again, lower the hand (or point up / down) and point again
          fired = dir;
        }
        lastT = now;
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
