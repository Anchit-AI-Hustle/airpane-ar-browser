// Laptop-controller gestures, driven by real recorded hands (the same ones the desktop
// app is tested with). Each action has its own hand shape; nothing may fire by accident.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createGestures, placeHand, cursorFrom } from "../public/gestures.js";
import { classify } from "../public/poses.js";

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
  for (const p of ["point", "pinch", "peace", "open_palm", "thumbs_up", "thumbs_down", "fist"])
    assert.equal(classify(placeHand(HANDS[p], 0.5, 0.5).map((q) => [1 - q.x, q.y])), p, p);
});

ok("pointing moves the cursor, left to right as you see it", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["point", 0.3, 0.35], ["point", 1, 0.35, 0.65]]);
  const xs = of(ev, "cur").map((e) => e.x);
  assert.ok(xs.length > 20 && xs.at(-1) - xs[0] > 0.3, JSON.stringify(xs.slice(0, 3)));
});

ok("a brief pinch clicks once, where you pointed", () => {
  const g = createGestures(); run.t = 0;
  const ev0 = run(g, [["point", 0.6, 0.45]]);
  const last = of(ev0, "cur").at(-1);
  const ev = run(g, [["pinch", 0.25, 0.45], ["point", 0.3, 0.45]]);
  const clicks = of(ev, "click");
  assert.equal(clicks.length, 1);
  assert.ok(Math.abs(clicks[0].x - last.x) < 0.03 && Math.abs(clicks[0].y - last.y) < 0.03, JSON.stringify([clicks[0], last]));
  assert.equal(of(ev, "scroll").length, 0, "a pinch never scrolls any more");
});

ok("a slow pinch (up to a second) still clicks; a very long one does not", () => {
  let g = createGestures(); run.t = 0;
  assert.equal(of(run(g, [["point", 0.3], ["pinch", 1.0], ["point", 0.3]]), "click").length, 1);
  g = createGestures(); run.t = 0;
  assert.equal(of(run(g, [["point", 0.3], ["pinch", 1.6], ["point", 0.3]]), "click").length, 0);
});

ok("open hand moving up scrolls down the page, and never clicks or moves the cursor", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["open_palm", 0.3, 0.5, 0.5, 0.62], ["open_palm", 0.6, 0.5, 0.5, 0.62, 0.38]]);
  const total = of(ev, "scroll").reduce((s, e) => s + e.dy, 0);
  assert.ok(total > 0.3, total);
  assert.equal(of(ev, "click").length + of(ev, "cur").length + of(ev, "back").length, 0);
  const down = of(run(g, [["open_palm", 0.6, 0.5, 0.5, 0.38, 0.62]]), "scroll").reduce((s, e) => s + e.dy, 0);
  assert.ok(down < -0.3, down);
});

ok("a loose point (V sign) still moves the cursor and never scrolls", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["peace", 0.3, 0.35], ["peace", 1, 0.35, 0.65, 0.4, 0.6]]);
  assert.ok(of(ev, "cur").length > 20);
  assert.equal(of(ev, "scroll").length + of(ev, "click").length, 0);
});

ok("pointing and moving up or down never scrolls", () => {
  const g = createGestures(); run.t = 0;
  assert.equal(of(run(g, [["point", 1, 0.5, 0.5, 0.3, 0.7]]), "scroll").length, 0);
});

ok("pinching and moving no longer scrolls (the old clash)", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["point", 0.3], ["pinch", 0.8, 0.5, 0.5, 0.6, 0.35]]);
  assert.equal(of(ev, "scroll").length, 0);
});

ok("open hand flicked left goes back, once, with almost no scrolling", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["open_palm", 0.3, 0.7], ["open_palm", 0.25, 0.7, 0.3], ["open_palm", 0.4, 0.3]]);
  assert.equal(of(ev, "back").length, 1);
  assert.ok(Math.abs(of(ev, "scroll").reduce((s, e) => s + e.dy, 0)) < 0.02);
});

ok("slow drift with an open hand does nothing", () => {
  const g = createGestures(); run.t = 0;
  assert.equal(of(run(g, [["open_palm", 2, 0.7, 0.4]]), "back").length, 0);
});

ok("thumbs up / down change text size, repeating while held", () => {
  const g = createGestures(); run.t = 0;
  const up = of(run(g, [["thumbs_up", 1.6]]), "size");
  assert.ok(up.length >= 2 && up.every((e) => e.up === true), JSON.stringify(up));
  const down = of(run(g, [["point", 0.2], ["thumbs_down", 1.0]]), "size");
  assert.ok(down.length >= 1 && down.every((e) => e.up === false));
});

ok("holding a fist pauses; while paused nothing happens; fist again resumes", () => {
  const g = createGestures(); run.t = 0;
  let ev = run(g, [["point", 0.3], ["fist", 1.3]]);
  assert.deepEqual(of(ev, "pause").map((e) => e.value), [true]);
  ev = run(g, [["point", 0.5, 0.3, 0.7], ["pinch", 0.2], ["point", 0.2], ["open_palm", 0.5, 0.5, 0.5, 0.6, 0.4]]);
  assert.equal(ev.filter((e) => ["cur", "click", "scroll"].includes(e.t)).length, 0);
  ev = run(g, [["point", 0.2], ["fist", 1.3], ["point", 0.4, 0.3, 0.6]]);
  assert.deepEqual(of(ev, "pause").map((e) => e.value), [false]);
  assert.ok(of(ev, "cur").length > 5);
});

ok("a one-frame glitch does not click", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["point", 0.4], ["pinch", 1 / FPS], ["point", 0.4]]);
  assert.equal(of(ev, "click").length, 0);
});

ok("a single missed tracking frame does not interrupt scrolling", () => {
  const g = createGestures(); run.t = 0;
  let ev = run(g, [["open_palm", 0.3, 0.5, 0.5, 0.62]]);
  ev = [...ev, ...run(g, [["open_palm", 0.3, 0.5, 0.5, 0.62, 0.5], [null, 1 / FPS], ["open_palm", 0.3, 0.5, 0.5, 0.5, 0.38]])];
  assert.equal(of(ev, "lost").length, 0);
  assert.ok(of(ev, "scroll").reduce((s, e) => s + e.dy, 0) > 0.3);
});

ok("losing the hand reports it", () => {
  const g = createGestures(); run.t = 0;
  assert.equal(of(run(g, [["point", 0.3], [null, 0.1]]), "lost").length, 1);
});

ok("cursor mapping is mirrored and clamped", () => {
  assert.equal(cursorFrom(Array.from({ length: 21 }, () => ({ x: 0.99, y: 0.01 })))[`x`], 0);
});

console.log(`${n} gesture tests passed`);
