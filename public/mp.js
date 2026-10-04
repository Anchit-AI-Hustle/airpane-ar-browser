// MediaPipe set-up that works in every browser, Safari / iPhone included.
// MediaPipe draws camera frames with WebGL on an OffscreenCanvas by default. Safari has
// OffscreenCanvas but often without WebGL there, and then hand / face tracking fails
// silently (GPU set-up errors, and even the CPU mode throws on every frame). Giving it a
// normal page canvas avoids that. Each mode is also tried on a blank frame before it is
// used, so a mode that would fail on every frame is skipped up front.
export const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1";

let filesP = null;
export async function vision() {
  const mod = await import(MP + "/vision_bundle.mjs");
  filesP ||= mod.FilesetResolver.forVisionTasks(MP + "/wasm");
  return { mod, files: await filesP };
}

// Task: e.g. HandLandmarker. opts: its options without baseOptions.delegate / canvas.
// Returns { task, delegate }. skip: delegates not to try (e.g. after GPU failed at run time).
export async function createTask(Task, files, modelAssetPath, opts, skip = []) {
  const probe = document.createElement("canvas");
  probe.width = 64; probe.height = 48;
  probe.getContext("2d").fillRect(0, 0, 64, 48);
  let lastErr = null;
  for (const delegate of ["GPU", "CPU"]) {
    if (skip.includes(delegate)) continue;
    let task = null;
    try {
      task = await Task.createFromOptions(files, { ...opts, baseOptions: { modelAssetPath, delegate }, canvas: document.createElement("canvas") });
      // must survive a real frame, not just the set-up
      if (opts.runningMode === "VIDEO") task.detectForVideo(probe, 1); // real frames come later, with larger times
      else task.detect(probe);
      return { task, delegate };
    } catch (e) { lastErr = e; try { task && task.close(); } catch {} }
  }
  throw lastErr || new Error("No working MediaPipe mode");
}

// Whether a new camera frame is there to read. Uses the video clock, but also lets a frame
// through every 80 ms in case a browser does not move that clock for live camera video.
// MediaPipe needs every frame time to be later than the one before.
export function clock() { let last = 1; return (now) => (last = Math.max(now, last + 1)); }

export function frameGate() {
  let lastT = -1, lastAt = 0;
  return (video, now) => {
    if (!video.srcObject || video.readyState < 2 || !video.videoWidth) return false;
    if (video.currentTime !== lastT || now - lastAt >= 80) { lastT = video.currentTime; lastAt = now; return true; }
    return false;
  };
}
