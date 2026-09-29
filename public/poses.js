// Hand pose recognition from the 21 MediaPipe landmarks. A direct port of the
// Airpane Desktop classifier (desktop/airpane_desktop/poses.py), tested against the
// same real-hand photos so the web and desktop apps read hands identically.
// Landmarks: [[x, y], ...] in image coordinates, mirrored so left/right match the user.

export const WRIST = 0;
export const THUMB = [1, 2, 3, 4], INDEX = [5, 6, 7, 8], MIDDLE = [9, 10, 11, 12], RING = [13, 14, 15, 16], PINKY = [17, 18, 19, 20];

export const POSES = {
  point: "Index finger up",
  pinch: "Thumb and index finger touching",
  pinch_middle: "Thumb and middle finger touching",
  peace: "Index and middle finger up (V)",
  three: "Three fingers up",
  open_palm: "Open hand",
  fist: "Closed fist",
  thumbs_up: "Thumbs up",
  rock: "Index and pinky up",
  thumbs_down: "Thumbs down",
  call: "Only the pinky up",
  four: "Four fingers up, thumb folded in",
};

const PINCH_ENTER = 0.30, PINCH_EXIT = 0.45, PINCH_REACH = 0.5;

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const palmSize = (lm) => Math.max(1e-6, dist(lm[WRIST], lm[MIDDLE[0]]));

function fingerUp(lm, [mcp, pip, , tip]) {
  const w = lm[WRIST];
  return dist(w, lm[tip]) > dist(w, lm[pip]) * 1.12 && dist(w, lm[tip]) > dist(w, lm[mcp]) * 1.25;
}
function thumbOut(lm) {
  const p = palmSize(lm);
  return dist(lm[THUMB[3]], lm[INDEX[0]]) > 0.55 * p && dist(lm[THUMB[3]], lm[PINKY[0]]) > 0.9 * p;
}
export function fingers(lm) {
  return { thumb: thumbOut(lm), index: fingerUp(lm, INDEX), middle: fingerUp(lm, MIDDLE), ring: fingerUp(lm, RING), pinky: fingerUp(lm, PINKY) };
}
export const pinchRatio = (lm, tip = INDEX[3]) => dist(lm[THUMB[3]], lm[tip]) / palmSize(lm);
const reach = (lm, f) => dist(lm[f[3]], lm[f[0]]) / palmSize(lm);

export function classify(lm, wasPinched = false, wasPinchedMiddle = false) {
  if (!lm || lm.length < 21) return "none";
  const f = fingers(lm);
  const pi = pinchRatio(lm, INDEX[3]), pm = pinchRatio(lm, MIDDLE[3]);
  const othersUp = (f.middle + f.ring + f.pinky) >= 2;
  if (pi < (wasPinched ? PINCH_EXIT : PINCH_ENTER) && (reach(lm, INDEX) > PINCH_REACH || othersUp)) return "pinch";
  if (pm < (wasPinchedMiddle ? PINCH_EXIT : PINCH_ENTER) && pi > PINCH_EXIT && reach(lm, MIDDLE) > PINCH_REACH && !f.pinky) return "pinch_middle";
  const up = [f.index, f.middle, f.ring, f.pinky];
  const n = up.filter(Boolean).length;
  const p = palmSize(lm), tTip = lm[THUMB[3]], tMcp = lm[THUMB[1]];
  if (n === 0) {
    if (tTip[1] - tMcp[1] > 0.3 * p && dist(tTip, tMcp) > 0.4 * p) return "thumbs_down";
    if (f.thumb && tMcp[1] - tTip[1] > 0.5 * p) return "thumbs_up";
    return "fist";
  }
  const is = (a, b, c, d) => up[0] === a && up[1] === b && up[2] === c && up[3] === d;
  if (is(false, false, false, true)) return "call";
  if (is(true, false, false, false)) return "point";
  if (is(true, true, false, false)) return "peace";
  if (is(true, true, true, false)) return "three";
  if (is(true, false, false, true)) return "rock";
  if (n === 4) return dist(tTip, lm[PINKY[0]]) < 0.66 * p ? "four" : "open_palm";
  return "none";
}

export const palmCenter = (lm) => {
  const pts = [0, 5, 9, 13, 17].map((i) => lm[i]);
  return [pts.reduce((s, q) => s + q[0], 0) / 5, pts.reduce((s, q) => s + q[1], 0) / 5];
};
