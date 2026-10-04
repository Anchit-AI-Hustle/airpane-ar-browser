// Hand control from this device's own camera (Floating glass on any device, and the
// laptop Hologram). Gestures:
//   open hand moves the cursor, closing it into a fist clicks,
//   point up / down scrolls, point left / right goes back / forward, pinch and swing throws.
import { createGestures } from "./gestures.js";
import { vision, createTask, frameGate, clock } from "./mp.js";

const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const OPTS = { runningMode: "VIDEO", numHands: 1, minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5 };

export function createHandTracker(video, onEvent) {
  const gestures = createGestures();
  const recent = []; // the last few events, for tests and debugging
  const gate = frameGate(), ts = clock();
  let landmarker = null, delegate = "", loading = null, running = false, raf = 0, hand = false, events = 0, frames = 0, errors = 0, error = "";
  async function load(skip) {
    const { mod, files } = await vision();
    const r = await createTask(mod.HandLandmarker, files, HAND_MODEL, OPTS, skip);
    delegate = r.delegate;
    return r.task;
  }
  // a mode that set up fine but keeps failing on real frames: switch to the other one
  async function recover() {
    const old = landmarker; landmarker = null;
    try { old && old.close(); } catch {}
    if (delegate === "CPU") { error = "Hand tracking does not work in this browser"; return; }
    try { landmarker = await load(["GPU"]); errors = 0; } catch { error = "Hand tracking does not work in this browser"; }
  }
  function tick(now) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    if (!landmarker || !gate(video, now)) return;
    let r;
    try { r = landmarker.detectForVideo(video, ts(now)); errors = 0; }
    catch { if (++errors === 5) recover(); return; }
    frames++;
    const lm = r && r.landmarks && r.landmarks[0];
    hand = Boolean(lm);
    for (const ev of gestures.update(lm || null, now)) { events++; recent.push({ ...ev, at: Math.round(now) }); if (recent.length > 40) recent.shift(); onEvent(ev); }
  }
  return {
    get state() { return { ready: Boolean(landmarker), delegate, running, hand, pose: gestures.state.pose, dir: gestures.state.dir, events, frames, error, recent: recent.slice() }; },
    async start() {
      running = true;
      try { landmarker = landmarker || (await (loading ||= load())); } catch (e) { running = false; loading = null; error = "Hand tracking could not start"; return false; }
      if (running) { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }
      return true;
    },
    stop() { running = false; cancelAnimationFrame(raf); gestures.reset(); hand = false; },
  };
}
