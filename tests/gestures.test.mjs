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

ok("index finger moving up scrolls up, moving down scrolls down; no clicks or cursor", () => {
  const g = createGestures(); run.t = 0;
  const up = run(g, [["point", 0.3, 0.5, 0.5, 0.6], ["point", 0.8, 0.5, 0.5, 0.6, 0.35]]);
  const tu = of(up, "scroll").reduce((s, e) => s + e.dy, 0);
  assert.ok(tu < -0.3, "up should scroll up: " + tu);
  const down = of(run(g, [["point", 0.8, 0.5, 0.5, 0.35, 0.6]]), "scroll").reduce((s, e) => s + e.dy, 0);
  assert.ok(down > 0.3, "down should scroll down: " + down);
  assert.equal(of(up, "click").length + of(up, "cur").length + of(up, "back").length, 0);
});

ok("slow index-finger scroll is smooth: many small steps, not jumps", () => {
  const g = createGestures(); run.t = 0;
  const s = of(run(g, [["point", 0.3, 0.5, 0.5, 0.6], ["point", 1.5, 0.5, 0.5, 0.6, 0.4]]), "scroll");
  assert.ok(s.length > 25, s.length);
  assert.ok(Math.max(...s.map((e) => Math.abs(e.dy))) < 0.05);
});

ok("index finger flicked left goes back, flicked right goes forward, once each", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["point", 0.3, 0.7], ["point", 0.25, 0.7, 0.3], ["point", 0.8, 0.3]]);
  assert.equal(of(ev, "back").length, 1); assert.equal(of(ev, "forward").length, 0);
  assert.ok(Math.abs(of(ev, "scroll").reduce((s, e) => s + e.dy, 0)) < 0.03, "a sideways flick must not scroll");
  const ev2 = run(g, [["point", 0.3, 0.3], ["point", 0.25, 0.3, 0.7], ["point", 0.8, 0.7]]);
  assert.equal(of(ev2, "forward").length, 1); assert.equal(of(ev2, "back").length, 0);
});

ok("slow sideways drift with the index finger does not go back or forward", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["point", 2, 0.7, 0.4]]);
  assert.equal(of(ev, "back").length + of(ev, "forward").length, 0);
});

ok("an open hand swept sideways only moves the cursor (no back / forward)", () => {
  const g = createGestures(); run.t = 0;
  const ev = run(g, [["open_palm", 0.3, 0.7], ["open_palm", 0.25, 0.7, 0.3]]);
  assert.equal(of(ev, "back").length + of(ev, "forward").length + of(ev, "click").length, 0);
});

ok("thumbs up / down change text size, repeating while held", () => {
  const g = createGestures(); run.t = 0;
  const up = of(run(g, [["thumbs_up", 1.6]]), "size");
  assert.ok(up.length >= 2 && up.every((e) => e.up === true), JSON.stringify(up));
  const down = of(run(g, [["open_palm", 0.2], ["thumbs_down", 1.0]]), "size");
  assert.ok(down.length >= 1 && down.every((e) => e.up === false));
});

ok("a single missed tracking frame does not interrupt scrolling", () => {
  const g = createGestures(); run.t = 0;
  let ev = run(g, [["point", 0.3, 0.5, 0.5, 0.62]]);
  ev = [...ev, ...run(g, [["point", 0.3, 0.5, 0.5, 0.62, 0.5], [null, 1 / FPS], ["point", 0.3, 0.5, 0.5, 0.5, 0.38]])];
  assert.equal(of(ev, "lost").length, 0);
  assert.ok(of(ev, "scroll").reduce((s, e) => s + e.dy, 0) < -0.3);
});

ok("losing the hand reports it", () => {
  const g = createGestures(); run.t = 0;
  assert.equal(of(run(g, [["open_palm", 0.3], [null, 0.1]]), "lost").length, 1);
});

console.log(`${n} gesture tests passed`);
