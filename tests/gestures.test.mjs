// Laptop-controller gestures, driven by real recorded hands (the same ones the desktop
// app is tested with). Each action has its own hand shape; nothing may fire by accident.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createGestures, placeHand, cursorFrom, pointDir } from "../public/gestures.js";
import { classify, palmCenter } from "../public/poses.js";

const D = JSON.parse(fs.readFileSync(new URL("../desktop/tests/fixtures/landmarks.json", import.meta.url)));
const H = JSON.parse(fs.readFileSync(new URL("../desktop/tests/fixtures/hagrid_landmarks.json", import.meta.url))).samples;
const HANDS = { ...D.real, ...D.derived };
for (const s of H) if (!HANDS[s.expect] && classify(s.lm) === s.expect) HANDS[s.expect] = s.lm;

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok  ", name); };
const FPS = 30;
function run(g, steps) { // steps: [pose|null, seconds, x0, x1, y0, y1]
  let t = run.t || 0; const ev = [];
  for (const [pose, secs, x0 = 0.5, x1 = x0, y0 = 0.5, y1 = y0] of steps) {
    const frames = Math.round(secs * FPS);
    for (let i = 0; i < frames; i++) {
      const k = i / Math.max(1, frames - 1);
      const lm = pose ? placeHand(HANDS[pose], x0 + (x1 - x0) * k, y0 + (y1 - y0) * k) : null;
      ev.push(...g.update(lm, t)); t += 1000 / FPS;
    }
  }
  run.t = t; return ev;
}
const of = (ev, t) => ev.filter((e) => e.t === t);

ok("every hand shape used here is recognised", () => {
  for (const p of ["point", "open_palm", "fist", "thumbs_up", "thumbs_down"])
    assert.equal(classify(placeHand(HANDS[p], 0.5, 0.5).map((q) => [1 - q.x, q.y])), p, p);
});

ok("an open hand moves the cursor, left to right as you see it, smoothly", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["open_palm", 0.3, 0.35], ["open_palm", 1, 0.35, 0.65]]);
  const xs = of(ev, "cur").map((e) => e.x);
  assert.ok(xs.length > 20 && xs.at(-1) - xs[0] > 0.3, JSON.stringify(xs.slice(0, 3)));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1] - 0.005, "cursor jittered backwards at " + i);
  assert.equal(of(ev, "click").length + of(ev, "scroll").length, 0);
});

ok("holding an open hand still keeps the cursor still (no jitter)", () => {
  const g = createGestures(); run.t = 0;
  const xs = of(run(g, [["open_palm", 1, 0.5]]), "cur").slice(5).map((e) => e.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 0.002);
});

ok("camera noise on a still open hand barely moves the cursor", () => {
  const g = createGestures(); let t = 0, seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.008;
  const xs = [];
  for (let i = 0; i < 60; i++) { const lm = placeHand(HANDS.open_palm, 0.5, 0.5).map((p) => ({ x: p.x + rnd(), y: p.y + rnd() })); for (const e of g.update(lm, t)) if (e.t === "cur") xs.push(e.x); t += 33; }
  const tail = xs.slice(10);
  assert.ok(Math.max(...tail) - Math.min(...tail) < 0.012, "jitter " + (Math.max(...tail) - Math.min(...tail)));
});

ok("closing the hand into a fist clicks once, where the open hand was", () => {
  const g = createGestures(); run.t = 0;
  const ev0 = run(g, [["open_palm", 0.8, 0.4]]);
  const last = of(ev0, "cur").at(-1);
  const ev = run(g, [["fist", 1.5, 0.4], ["open_palm", 0.3, 0.4]]);
  const clicks = of(ev, "click");
  assert.equal(clicks.length, 1, "exactly one click per fist, however long it is held");
  assert.ok(Math.abs(clicks[0].x - last.x) < 0.03 && Math.abs(clicks[0].y - last.y) < 0.03, JSON.stringify([clicks[0], last]));
  const again = of(run(g, [["fist", 0.3, 0.4], ["open_palm", 0.3, 0.4]]), "click");
  assert.equal(again.length, 1, "opening and closing again clicks again");
});

ok("a one-frame fist glitch does not click", () => {
  const g = createGestures(); run.t = 0;
  assert.equal(of(run(g, [["open_palm", 0.5], ["fist", 1 / FPS], ["open_palm", 0.5]]), "click").length, 0);
});

// Pointing directions, made by turning the recorded pointing hand around its palm.
const turn = (lm, deg) => { const c = palmCenter(lm), a = (deg * Math.PI) / 180; return lm.map(([x, y]) => { const dx = x - c[0], dy = y - c[1]; return [c[0] + dx * Math.cos(a) - dy * Math.sin(a), c[1] + dx * Math.sin(a) + dy * Math.cos(a)]; }); };
HANDS.point_up = HANDS.point;
HANDS.point_right = turn(HANDS.point, 90);
HANDS.point_down = turn(HANDS.point, 180);
HANDS.point_left = turn(HANDS.point, -90);
HANDS.point_diag = turn(HANDS.point, 45);       // in between up and right: does nothing
HANDS.point_up_tilt = turn(HANDS.point, 25);    // a bit off straight up: still up
const total = (ev) => of(ev, "scroll").reduce((s, e) => s + e.dy, 0);

ok("pointing directions are read correctly, and in-between directions are no direction", () => {
  const dirOf = (k) => pointDir(placeHand(HANDS[k], 0.5, 0.5).map((q) => [1 - q.x, q.y]));
  assert.deepEqual(["point_up", "point_down", "point_left", "point_right", "point_diag", "point_up_tilt"].map(dirOf), ["up", "down", "left", "right", "", "up"]);
  for (const k of ["point_up", "point_down", "point_left", "point_right"]) assert.equal(classify(placeHand(HANDS[k], 0.5, 0.5).map((q) => [1 - q.x, q.y])), "point", k);
});

ok("pointing up scrolls up, pointing down scrolls down, steadily while held; nothing else", () => {
  let g = createGestures(); run.t = 0;
  const up = run(g, [["point_up", 2]]);
  assert.ok(total(up) < -0.5, "up: " + total(up));
  assert.ok(of(up, "scroll").every((e) => e.dy < 0), "pointing up must never scroll down");
  g = createGestures(); run.t = 0;
  const down = run(g, [["point_down", 2]]);
  assert.ok(total(down) > 0.5, "down: " + total(down));
  assert.ok(of(down, "scroll").every((e) => e.dy > 0), "pointing down must never scroll up");
  for (const ev of [up, down]) assert.equal(of(ev, "click").length + of(ev, "cur").length + of(ev, "back").length + of(ev, "forward").length + of(ev, "grab").length, 0);
});

ok("moving the pointing hand around never changes the scroll direction (no undo on the way back)", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["point_down", 0.5, 0.5, 0.5, 0.3], ["point_down", 0.6, 0.5, 0.5, 0.3, 0.7], ["point_down", 0.6, 0.5, 0.5, 0.7, 0.3], ["point_down", 0.6, 0.3, 0.7, 0.3, 0.3]]);
  assert.ok(of(ev, "scroll").length > 30 && of(ev, "scroll").every((e) => e.dy > 0));
  assert.equal(of(ev, "back").length + of(ev, "forward").length, 0);
});

ok("scrolling is smooth (small steps) and speeds up the longer you point", () => {
  const g = createGestures(); run.t = 0;
  const s = of(run(g, [["point_down", 3]]), "scroll");
  assert.ok(Math.max(...s.map((e) => e.dy)) < 0.06, "steps too big");
  const early = s.slice(2, 12).reduce((a, e) => a + e.dy, 0), late = s.slice(-10).reduce((a, e) => a + e.dy, 0);
  assert.ok(late > early * 1.8, `should speed up: ${early} -> ${late}`);
});

ok("a quick glance of the finger (shorter than a quarter second) does nothing", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["open_palm", 0.5], ["point_down", 0.15], ["open_palm", 0.5], ["point_left", 0.15], ["open_palm", 0.3]]);
  assert.equal(of(ev, "scroll").length + of(ev, "back").length + of(ev, "forward").length + of(ev, "click").length, 0);
});

ok("pointing left goes back, pointing right goes forward, once per point", () => {
  let g = createGestures(); run.t = 0;
  let ev = run(g, [["point_left", 2]]);
  assert.equal(of(ev, "back").length, 1); assert.equal(of(ev, "forward").length + of(ev, "scroll").length, 0);
  g = createGestures(); run.t = 0;
  ev = run(g, [["point_right", 2]]);
  assert.equal(of(ev, "forward").length, 1); assert.equal(of(ev, "back").length + of(ev, "scroll").length, 0);
  // lower the hand and point again to go back again
  g = createGestures(); run.t = 0;
  ev = run(g, [["point_left", 0.6], [null, 0.3], ["point_left", 0.6]]);
  assert.equal(of(ev, "back").length, 2);
});

ok("pointing diagonally does nothing, and wobbling into the gap and back does not repeat back", () => {
  let g = createGestures(); run.t = 0;
  assert.deepEqual(run(g, [["point_diag", 2]]).filter((e) => e.t !== "lost"), []);
  g = createGestures(); run.t = 0;
  const ev = run(g, [["point_left", 0.6], ["point_diag", 0.4], ["point_left", 0.6]]);
  assert.equal(of(ev, "back").length, 1);
});

ok("turning from up to down: the scroll stops before it reverses, never mixing the two", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["point_up", 1], ["point_down", 1]]);
  const s = of(ev, "scroll"), flip = s.findIndex((e) => e.dy > 0);
  assert.ok(flip > 0 && s.slice(0, flip).every((e) => e.dy < 0) && s.slice(flip).every((e) => e.dy > 0));
});

ok("a finger near the edge of a direction keeps it (no flicker)", () => {
  const g = createGestures(); let t = 0; const ev = [];
  for (let i = 0; i < 60; i++) { ev.push(...g.update(placeHand(turn(HANDS.point, i % 2 ? 28 : 36), 0.5, 0.5), t)); t += 33; }
  const s = of(ev, "scroll");
  assert.ok(s.length > 45 && s.every((e) => e.dy < 0), s.length);
});

ok("an open hand swept around only moves the cursor", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["open_palm", 0.3, 0.7], ["open_palm", 0.25, 0.7, 0.3], ["open_palm", 0.5, 0.3, 0.3, 0.3, 0.8]]);
  assert.equal(of(ev, "back").length + of(ev, "forward").length + of(ev, "click").length + of(ev, "scroll").length, 0);
});

ok("thumbs up / down do nothing (they look too much like a fist)", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["thumbs_up", 1.2], ["thumbs_down", 1.2]]);
  assert.deepEqual(ev.filter((e) => e.t !== "lost"), []);
});

ok("curling a pointing finger into a fist does not click", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["open_palm", 0.5], ["point", 0.8], ["fist", 1]]);
  assert.equal(of(ev, "click").length, 0);
});

ok("a fist that closes long after the hand was open does not click", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["open_palm", 0.5], ["thumbs_up", 1.2], ["fist", 1]]);
  assert.equal(of(ev, "click").length, 0);
});

ok("every gesture does only its own action", () => {
  const acts = (ev) => [...new Set(ev.map((e) => e.t).filter((t) => t !== "lost"))].sort().join(",");
  const only = (steps) => { const g = createGestures(); run.t = 0; return acts(run(g, steps)); };
  assert.equal(only([["open_palm", 1, 0.3, 0.7, 0.3, 0.6]]), "cur");
  assert.equal(only([["point_up", 1, 0.5, 0.5, 0.6, 0.3]]), "scroll");
  assert.equal(only([["point_down", 1, 0.5, 0.5, 0.6, 0.3]]), "scroll");
  assert.equal(only([["point_left", 1, 0.3, 0.7]]), "back");
  assert.equal(only([["point_right", 1, 0.7, 0.3]]), "forward");
  assert.equal(only([["pinch", 1]]), "grab,hold");
  const g = createGestures(); run.t = 0;
  const c = run(g, [["open_palm", 0.5], ["fist", 0.6]]);
  assert.equal(of(c, "click").length, 1);
  assert.equal(of(c, "scroll").length + of(c, "back").length + of(c, "forward").length, 0);
});

ok("on a slow camera (about 1 frame a second) open hand then fist still clicks once", () => {
  const g = createGestures(); let t = 0; const ev = [];
  for (const [p, n] of [["open_palm", 4], ["fist", 4], ["open_palm", 2]]) for (let i = 0; i < n; i++) { ev.push(...g.update(placeHand(HANDS[p], 0.5, 0.5), t)); t += 800; }
  assert.equal(of(ev, "click").length, 1);
});

ok("on a slow camera (about 1 frame a second) pointing still scrolls the right way and goes back once", () => {
  let g = createGestures(); let t = 0; let ev = [];
  for (let i = 0; i < 8; i++) { ev.push(...g.update(placeHand(HANDS.point_down, 0.5, 0.5), t)); t += 800; }
  assert.ok(total(ev) > 2 && of(ev, "scroll").every((e) => e.dy > 0), JSON.stringify(of(ev, "scroll")));
  g = createGestures(); t = 0; ev = [];
  for (let i = 0; i < 8; i++) { ev.push(...g.update(placeHand(HANDS.point_left, 0.5, 0.5), t)); t += 800; }
  assert.equal(of(ev, "back").length, 1);
});

ok("a single missed tracking frame does not interrupt scrolling", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["point_up", 0.6], [null, 1 / FPS], ["point_up", 0.6]]);
  assert.equal(of(ev, "lost").length, 0);
  assert.ok(total(ev) < -0.3 && of(ev, "scroll").every((e) => e.dy < 0));
});

ok("losing the hand reports it", () => {
  const g = createGestures(); run.t = 0;
  assert.equal(of(run(g, [["open_palm", 0.3], [null, 0.1]]), "lost").length, 1);
});


// ---------- pinch: grab, throw, drop ----------
const scaled = (lm, k) => { const c = lm.reduce((a, q) => [a[0] + q.x / lm.length, a[1] + q.y / lm.length], [0, 0]); return lm.map((q) => ({ x: c[0] + (q.x - c[0]) * k, y: c[1] + (q.y - c[1]) * k })); };

ok("a pinch is recognised (recorded and real photos) and is not any other gesture", () => {
  assert.equal(classify(placeHand(HANDS.pinch, 0.5, 0.5).map((q) => [1 - q.x, q.y])), "pinch");
  const real = H.filter((x) => x.expect === "pinch");
  const hit = real.filter((x) => classify(x.lm) === "pinch").length;
  assert.ok(hit / real.length >= 0.8, `${hit}/${real.length}`);
  // none of the other gestures in use reads as a pinch (real photos)
  for (const x of H) if (["open_palm", "four", "fist", "point", "peace"].includes(x.expect)) assert.notEqual(classify(x.lm), "pinch", x.expect);
});

ok("pinch grabs the page and it follows the hand; no cursor, click or scroll", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["pinch", 0.3, 0.4], ["pinch", 1.2, 0.4, 0.6, 0.5, 0.45]]);
  assert.equal(of(ev, "grab").length, 1);
  const hold = of(ev, "hold");
  assert.ok(hold.length > 20 && hold.at(-1).x > hold[0].x + 0.2, JSON.stringify([hold[0], hold.at(-1)]));
  assert.equal(of(ev, "cur").length + of(ev, "click").length + of(ev, "scroll").length + of(ev, "back").length + of(ev, "forward").length, 0);
});

ok("pinch, swing up fast and let go throws the page (once)", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["pinch", 0.4, 0.5, 0.5, 0.65], ["pinch", 0.2, 0.5, 0.5, 0.65, 0.3], ["open_palm", 0.5, 0.5, 0.5, 0.28]]);
  const th = of(ev, "throw");
  assert.equal(th.length, 1, JSON.stringify(ev.filter((e) => e.t !== "hold" && e.t !== "cur")));
  assert.ok(th[0].vy < -0.9, "upward: " + th[0].vy);
  assert.equal(of(ev, "drop").length + of(ev, "click").length, 0);
});

ok("pinch and push the hand towards the camera, then let go, also throws", () => {
  const g = createGestures(); let t = 0; const ev = [];
  const base = placeHand(HANDS.pinch, 0.5, 0.5);
  for (let i = 0; i < 12; i++) { ev.push(...g.update(base, t)); t += 33; }
  for (let i = 0; i < 8; i++) { ev.push(...g.update(scaled(base, 1 + i * 0.07), t)); t += 33; }
  for (let i = 0; i < 6; i++) { ev.push(...g.update(scaled(placeHand(HANDS.open_palm, 0.5, 0.5), 1.5), t)); t += 33; }
  assert.equal(of(ev, "throw").length, 1, JSON.stringify(ev.filter((e) => e.t !== "hold" && e.t !== "cur")));
});

ok("pinch, move slowly and let go just drops the page back (no throw)", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["pinch", 0.3, 0.5], ["pinch", 1.5, 0.5, 0.6], ["pinch", 0.5, 0.6], ["open_palm", 0.4, 0.6]]);
  assert.equal(of(ev, "throw").length, 0);
  assert.equal(of(ev, "drop").length, 1);
  assert.equal(of(ev, "click").length, 0);
});

ok("swinging the pinched hand out of view throws", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["pinch", 0.4, 0.5], ["pinch", 0.2, 0.5, 0.85], [null, 0.3]]);
  assert.equal(of(ev, "throw").length, 1);
});

ok("fast open-hand or index-finger swings never throw or grab", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["open_palm", 0.3, 0.5, 0.5, 0.7], ["open_palm", 0.2, 0.5, 0.5, 0.7, 0.2], ["point", 0.4, 0.5], ["point", 0.2, 0.3, 0.8], [null, 0.3]]);
  assert.equal(of(ev, "grab").length + of(ev, "throw").length + of(ev, "drop").length, 0);
});

ok("on a slow camera (about 1 frame a second) a big pinch swing still throws", () => {
  const g = createGestures(); let t = 0; const ev = [];
  for (const [p, y] of [["pinch", 0.7], ["pinch", 0.7], ["pinch", 0.7], ["pinch", 0.3], ["open_palm", 0.3], ["open_palm", 0.3]]) { ev.push(...g.update(placeHand(HANDS[p], 0.5, y), t)); t += 800; }
  assert.equal(of(ev, "throw").length, 1, JSON.stringify(ev));
});

ok("a swing that stops a moment before letting go still throws; a long stop just drops", () => {
  let g = createGestures(); run.t = 0;
  let ev = run(g, [["pinch", 0.4, 0.5, 0.5, 0.7], ["pinch", 0.25, 0.5, 0.5, 0.7, 0.3], ["pinch", 0.2, 0.5, 0.5, 0.3], ["open_palm", 0.3, 0.5, 0.5, 0.3]]);
  assert.equal(of(ev, "throw").length, 1, "short stop");
  g = createGestures(); run.t = 0;
  ev = run(g, [["pinch", 0.4, 0.5, 0.5, 0.7], ["pinch", 0.25, 0.5, 0.5, 0.7, 0.3], ["pinch", 1, 0.5, 0.5, 0.3], ["open_palm", 0.3, 0.5, 0.5, 0.3]]);
  assert.equal(of(ev, "throw").length, 0, "long stop");
  assert.equal(of(ev, "drop").length, 1);
});

console.log(`${n} gesture tests passed`);
