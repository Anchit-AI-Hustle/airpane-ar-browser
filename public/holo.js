// Hologram view for laptops and desktops.
//
// A laptop camera faces the user, so there is no room behind the screen to pin
// the page to. Instead the camera watches the user's head, and the scene is drawn
// from where their eyes actually are (head-coupled perspective). The screen acts
// like a window: a 3D room sits behind it and the page floats in front of it.
// When the head moves, near and far things shift by different amounts, which is
// what makes the page read as an object in the air rather than a flat picture.
//
// CSS does the projection: `perspective` is the eye's distance from the screen
// and `perspective-origin` is the point on the screen straight in front of the
// eye, which is exactly an off-axis (window) projection. Every element gets one
// flat transform under that parent, so clicks still land on the right link.

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const PX_PER_CM = 42;     // CSS pixels per cm on a typical laptop screen
const FACE_CM = 15;       // average face width
const CAM_HFOV = 1.155;   // 2 * tan(30deg): width of view per unit distance
const GAIN = 1.35;        // a little stronger than life so the effect is obvious
const ROOM_DEPTH = 2600;
const REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function headFromFace(box, vw, neutral) {
  // box is in video pixels. Returns the eye position relative to screen centre
  // in CSS px: x right, y down, d = distance from the screen.
  const fx = (box.originX + box.width / 2) / vw;
  const fy = (box.originY + box.height * 0.4) / vw; // eyes sit ~40% down the face box
  const wn = box.width / vw;
  const zcm = FACE_CM / (CAM_HFOV * Math.max(wn, 0.04));
  const span = CAM_HFOV * zcm * PX_PER_CM * GAIN;
  const n = neutral || { fx, fy };
  return {
    // The camera image is not mirrored: moving to your right moves your face left in it.
    x: (n.fx - fx) * span,
    y: (fy - n.fy) * span,
    d: Math.min(4200, Math.max(1100, zcm * PX_PER_CM)),
    fx, fy,
  };
}

export function createHolo({ stage, panel, video, onStatus }) {
  // CSS perspective only reaches direct children of the stage, so every room
  // piece is added to the stage itself (no wrapper).
  const room = { children: [], appendChild(el) { this.children.push(el); } };
  const planes = ["floor", "ceil", "left", "right", "back"].map((n) => {
    const el = document.createElement("div");
    el.className = "holo-plane holo-" + n;
    room.appendChild(el);
    return el;
  });
  const shadow = document.createElement("div");
  shadow.className = "holo-shadow";
  room.appendChild(shadow);
  // A few floating markers at different depths make the parallax easy to see.
  const dots = [[-0.34, -0.22, -900], [0.38, 0.18, -1500], [-0.28, 0.3, -2100], [0.3, -0.3, -400]].map(([x, y, z]) => {
    const el = document.createElement("i");
    el.className = "holo-dot";
    room.appendChild(el);
    return { el, x, y, z };
  });

  const s = {
    on: false, eye: { x: 0, y: 0, d: 2200 }, target: { x: 0, y: 0, d: 2200 },
    pz: 140, neutral: null, calib: [], detector: null, loading: false,
    lastFace: 0, mouse: null, tracking: false, t0: performance.now(), lastVideoTime: -1,
  };

  function onMouse(e) {
    // pointing at the floating page is for using it, not for looking around
    if (e.target && e.target.closest && e.target.closest(".panel")) return;
    s.mouse = { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  async function loadDetector() {
    if (s.detector || s.loading) return;
    s.loading = true;
    try {
      const { FilesetResolver, FaceDetector } = await import(MP + "/vision_bundle.mjs");
      const files = await FilesetResolver.forVisionTasks(MP + "/wasm");
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", minDetectionConfidence: 0.5 });
      try { s.detector = await FaceDetector.createFromOptions(files, opts("GPU")); }
      catch { s.detector = await FaceDetector.createFromOptions(files, opts("CPU")); }
    } catch (e) {
      onStatus && onStatus("nohead");
    }
    s.loading = false;
  }

  function detect(now) {
    if (!s.detector || !video.srcObject || video.readyState < 2 || !video.videoWidth) return;
    if (video.currentTime === s.lastVideoTime) return;
    s.lastVideoTime = video.currentTime;
    let res;
    try { res = s.detector.detectForVideo(video, now); } catch { return; }
    const det = res && res.detections && res.detections[0];
    if (!det) return;
    const box = det.boundingBox;
    const vw = video.videoWidth;
    if (!s.neutral) {
      // Calibrate: wherever the user sits when it starts is "straight on".
      const h = headFromFace(box, vw, null);
      s.calib.push(h);
      if (s.calib.length < 8) return;
      s.neutral = {
        fx: s.calib.reduce((a, c) => a + c.fx, 0) / s.calib.length,
        fy: s.calib.reduce((a, c) => a + c.fy, 0) / s.calib.length,
      };
    }
    const h = headFromFace(box, vw, s.neutral);
    s.target = { x: h.x, y: h.y, d: h.d };
    s.lastFace = now;
    if (!s.tracking) { s.tracking = true; onStatus && onStatus("tracking"); }
  }

  function layout(W, H) {
    const D = ROOM_DEPTH;
    const set = (el, w, h, tf) => {
      el.style.width = w + "px"; el.style.height = h + "px";
      el.style.marginLeft = -w / 2 + "px"; el.style.marginTop = -h / 2 + "px";
      el.style.transform = tf;
    };
    const [floor, ceil, left, right, back] = planes;
    set(floor, W, D, `translate3d(0,${H / 2}px,${-D / 2}px) rotateX(90deg)`);
    set(ceil, W, D, `translate3d(0,${-H / 2}px,${-D / 2}px) rotateX(-90deg)`);
    set(left, D, H, `translate3d(${-W / 2}px,0,${-D / 2}px) rotateY(90deg)`);
    set(right, D, H, `translate3d(${W / 2}px,0,${-D / 2}px) rotateY(-90deg)`);
    set(back, W, H, `translate3d(0,0,${-D}px)`);
    for (const d of dots) d.el.style.transform = `translate3d(${d.x * W}px,${d.y * H}px,${d.z}px)`;
  }

  let lastW = 0, lastH = 0;
  function frame(now, size) {
    if (!s.on) return;
    const W = innerWidth, H = innerHeight;
    if (W !== lastW || H !== lastH) { layout(W, H); lastW = W; lastH = H; }
    detect(now);

    const faceFresh = now - s.lastFace < 1200;
    if (!faceFresh) {
      if (s.tracking) { s.tracking = false; onStatus && onStatus("lost"); }
      if (s.mouse && now - s.mouse.t < 4000) {
        s.target = { x: (s.mouse.x - W / 2) * 0.9, y: (s.mouse.y - H / 2) * 0.7, d: 2000 };
      } else {
        // Gentle idle drift so the depth is visible before any input.
        const t = REDUCED ? 0 : (now - s.t0) / 1000;
        s.target = { x: Math.sin(t * 0.5) * 160, y: Math.sin(t * 0.37) * 50, d: 2000 };
      }
    }
    const k = faceFresh ? 0.35 : 0.08;
    s.eye.x += (s.target.x - s.eye.x) * k;
    s.eye.y += (s.target.y - s.eye.y) * k;
    s.eye.d += (s.target.d - s.eye.d) * k * 0.5;

    stage.style.perspective = s.eye.d.toFixed(1) + "px";
    stage.style.perspectiveOrigin = `${(W / 2 + s.eye.x).toFixed(1)}px ${(H / 2 + s.eye.y).toFixed(1)}px`;

    // Size the page so it fills most of the window, then float it in front of the glass.
    // Fit the page at the default depth; zooming then moves it nearer or further.
    const pz = Math.min(s.pz, 0.45 * s.eye.d);
    const grow0 = s.eye.d / (s.eye.d - 140);
    const sc = Math.min((0.7 * W) / size.w, (0.6 * H) / size.h) / grow0;
    const bob = REDUCED ? 0 : Math.sin((now - s.t0) / 900) * 5;
    const py = -0.03 * H + bob;
    panel.style.visibility = "visible";
    panel.style.transform = `translate3d(0,${py.toFixed(1)}px,${pz}px) scale(${sc.toFixed(4)})`;
    shadow.style.width = size.w * sc * 0.9 + "px";
    shadow.style.height = "320px";
    shadow.style.marginLeft = -(size.w * sc * 0.9) / 2 + "px";
    shadow.style.marginTop = "-160px";
    shadow.style.transform = `translate3d(0,${H / 2 - 1}px,${Math.min(pz, -10)}px) rotateX(90deg)`;
    shadow.style.opacity = String(0.55 - Math.min(0.3, bob / 40));
  }

  return {
    get state() { return { on: s.on, tracking: s.tracking, eye: { ...s.eye }, pz: s.pz, detector: Boolean(s.detector) }; },
    start() {
      s.on = true; s.neutral = null; s.calib = []; s.tracking = false; s.lastVideoTime = -1;
      stage.classList.add("holo");
      stage.prepend(...room.children);
      lastW = 0;
      addEventListener("pointermove", onMouse);
      loadDetector();
    },
    stop() {
      s.on = false;
      stage.classList.remove("holo");
      room.children.forEach((el) => el.remove());
      stage.style.perspectiveOrigin = "";
      removeEventListener("pointermove", onMouse);
    },
    frame,
    zoom(f) { s.pz = Math.max(-1500, Math.min(800, s.pz + (f < 1 ? 250 : -250))); },
    recenter() { s.neutral = null; s.calib = []; s.pz = 140; },
  };
}
