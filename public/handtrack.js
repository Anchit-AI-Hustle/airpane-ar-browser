// Hand control from this device's own camera (used by the laptop Hologram, where no
// phone is involved). Same gestures as the laptop controller:
//   open hand moves the cursor, closing it into a fist clicks,
//   index finger up / down scrolls, a quick index flick left / right goes back / forward.
import { createGestures } from "./gestures.js";

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export function createHandTracker(video, onEvent) {
  const gestures = createGestures();
  let landmarker = null, loading = null, running = false, raf = 0, lastT = -1, hand = false, events = 0;
  async function load() {
    const { FilesetResolver, HandLandmarker } = await import(MP + "/vision_bundle.mjs");
    const files = await FilesetResolver.forVisionTasks(MP + "/wasm");
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: HAND_MODEL, delegate }, runningMode: "VIDEO", numHands: 1, minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    try { return await HandLandmarker.createFromOptions(files, opts("GPU")); }
    catch { return await HandLandmarker.createFromOptions(files, opts("CPU")); }
  }
  function tick(now) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    if (!landmarker || !video.srcObject || video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    let r;
    try { r = landmarker.detectForVideo(video, now); } catch { return; }
    const lm = r && r.landmarks && r.landmarks[0];
    hand = Boolean(lm);
    for (const ev of gestures.update(lm || null, now)) { events++; onEvent(ev); }
  }
  return {
    get state() { return { ready: Boolean(landmarker), running, hand, pose: gestures.state.pose, events }; },
    async start() {
      running = true;
      try { landmarker = landmarker || (await (loading ||= load())); } catch { running = false; return false; }
      if (running) { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }
      return true;
    },
    stop() { running = false; cancelAnimationFrame(raf); gestures.reset(); hand = false; },
  };
}
