// Gesture logic with synthetic hands: point, pinch-click, pinch-scroll, hand lost.
import assert from "node:assert/strict";
import { createGestures, fakeHand, cursorFrom, pinchRatio } from "../public/gestures.js";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok  ", name); };
const run = (g, frames) => frames.flatMap(([lm, t]) => g.update(lm, t));

ok("fingertip on the left of the camera image moves the cursor right (mirrored)", () => {
  const c = cursorFrom(fakeHand(0.25, 0.4));
  assert.ok(c.x > 0.8, JSON.stringify(c));
  assert.ok(cursorFrom(fakeHand(0.75, 0.4)).x < 0.2);
});
ok("cursor is clamped to 0..1", () => {
  const c = cursorFrom(fakeHand(0.0, 0.0));
  assert.ok(c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1);
});
ok("pinch ratio tracks thumb gap", () => {
  assert.ok(Math.abs(pinchRatio(fakeHand(0.5, 0.4, 0.8)) - 0.8) < 1e-9);
  assert.ok(pinchRatio(fakeHand(0.5, 0.4, 0.1)) < 0.2);
});
ok("open hand only moves the cursor", () => {
  const g = createGestures({ smooth: 1 });
  const ev = run(g, [[fakeHand(0.5, 0.4), 0], [fakeHand(0.45, 0.4), 33]]);
  assert.ok(ev.every((e) => e.t === "cur"));
});
ok("short pinch clicks where the cursor was", () => {
  const g = createGestures({ smooth: 1 });
  const ev = run(g, [[fakeHand(0.5, 0.4), 0], [fakeHand(0.5, 0.4, 0.1), 50], [fakeHand(0.5, 0.4, 0.1), 200], [fakeHand(0.5, 0.4, 0.8), 300]]);
  const clicks = ev.filter((e) => e.t === "click");
  assert.equal(clicks.length, 1);
  const c = cursorFrom(fakeHand(0.5, 0.4));
  assert.ok(Math.abs(clicks[0].x - c.x) < 1e-9 && Math.abs(clicks[0].y - c.y) < 1e-9);
});
ok("pinch and move up scrolls down the page, and does not click", () => {
  const g = createGestures({ smooth: 1 });
  const frames = [[fakeHand(0.5, 0.5), 0], [fakeHand(0.5, 0.5, 0.1), 40]];
  for (let i = 1; i <= 10; i++) frames.push([fakeHand(0.5, 0.5 - i * 0.02, 0.1), 40 + i * 33]);
  frames.push([fakeHand(0.5, 0.3, 0.8), 500]);
  const ev = run(g, frames);
  const sc = ev.filter((e) => e.t === "scroll");
  assert.ok(sc.length >= 5, "no scroll events");
  assert.ok(sc.reduce((a, e) => a + e.dy, 0) > 0.2, "should scroll forward");
  assert.equal(ev.filter((e) => e.t === "click").length, 0);
});
ok("hysteresis: a half-closed hand does not flicker between pinch states", () => {
  const g = createGestures({ smooth: 1 });
  const ev = run(g, [[fakeHand(0.5, 0.4, 0.1), 0], [fakeHand(0.5, 0.4, 0.4), 30], [fakeHand(0.5, 0.4, 0.3), 60], [fakeHand(0.5, 0.4, 0.42), 90]]);
  assert.equal(ev.filter((e) => e.t === "click").length, 0);
  assert.equal(g.state.pinched, true);
});
ok("a pinch held too long does not click", () => {
  const g = createGestures({ smooth: 1 });
  const ev = run(g, [[fakeHand(0.5, 0.4), 0], [fakeHand(0.5, 0.4, 0.1), 30], [fakeHand(0.5, 0.4, 0.8), 2000]]);
  assert.equal(ev.filter((e) => e.t === "click").length, 0);
});
ok("losing the hand resets and reports it", () => {
  const g = createGestures({ smooth: 1 });
  run(g, [[fakeHand(0.5, 0.4, 0.1), 0]]);
  const ev = g.update(null, 50);
  assert.deepEqual(ev, [{ t: "lost" }]);
  assert.equal(g.state.pinched, false);
});
console.log(`\n${n} gesture tests passed`);
