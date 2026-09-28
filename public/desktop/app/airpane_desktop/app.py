"""Airpane Desktop: control your computer with your hand, through the webcam.

Run:  python -m airpane_desktop            (opens the settings page in your browser)
Test: python -m airpane_desktop --video clip.mp4 --dry-run --no-browser
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

from . import actions
from .config import Store, conflicts, settings_dir
from .engine import Engine

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
CONNECTIONS = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
               (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (17, 18), (18, 19), (19, 20), (0, 17)]
VERSION = "1.0.0"


def ensure_model(path: Path) -> Path:
    if path.exists() and path.stat().st_size > 1_000_000:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    ctx = None
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    tmp = path.with_suffix(".part")
    with urllib.request.urlopen(MODEL_URL, context=ctx, timeout=60) as r, open(tmp, "wb") as f:
        f.write(r.read())
    os.replace(tmp, path)
    return path


class App:
    def __init__(self, args):
        self.args = args
        self.store = Store(Path(args.settings) if args.settings else None)
        self.cfg = self.store.load()
        self.cfg["paused"] = False  # always start active
        if args.dry_run:
            self.cfg["dry_run"] = True
        self.engine = Engine(self.cfg)
        self.exec = actions.Executor(dry_run=self.cfg["dry_run"])
        self.status = {"camera": "starting", "tracker": "loading", "fps": 0.0, "frames": 0, "error": "",
                       "accessibility": actions.accessibility_ok(prompt=not args.dry_run and not args.video),
                       "screen": list(self.exec.size), "platform": sys.platform, "version": VERSION}
        self.running = True
        self.lock = threading.Lock()
        self.jpeg = None
        self.jpeg_cond = threading.Condition()
        self.viewers = 0
        self.frame_evt = threading.Event()

    # ----- settings -----
    def apply(self, cfg):
        with self.lock:
            self.cfg = self.store.save(cfg)
            self.engine.set_config(self.cfg)
            self.exec.dry_run = self.cfg["dry_run"]
            if self.engine.paused:
                self.exec.release_all()
        return self.cfg

    def set_paused(self, value: bool):
        cfg = dict(self.cfg, paused=bool(value))
        self.apply(cfg)
        self.exec._record("Paused" if value else "Resumed")

    def snapshot(self):
        with self.lock:
            st = dict(self.status)
            st.update(self.engine.state)
            st["dry_run"] = self.cfg["dry_run"]
            st["warnings"] = conflicts(self.cfg)
            st["log"] = [{"t": t, "text": x} for t, x in list(self.exec.log)[-12:]]
            st["errors"] = list(self.exec.errors)[-5:]
        return st

    # ----- camera and tracking -----
    def run(self):
        import cv2
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        try:
            model = ensure_model(Path(self.args.model) if self.args.model else settings_dir() / "hand_landmarker.task")
            lmk = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(model)), running_mode=vision.RunningMode.VIDEO,
                num_hands=1, min_hand_detection_confidence=0.6, min_hand_presence_confidence=0.6, min_tracking_confidence=0.5))
            self.status["tracker"] = "ready"
        except Exception as e:
            self.status.update(tracker="failed", error=f"Hand tracking could not start: {e}")
            return

        def open_cam():
            src = self.args.video if self.args.video else self.cfg["camera"]
            c = cv2.VideoCapture(src, cv2.CAP_AVFOUNDATION) if (sys.platform == "darwin" and not self.args.video) else cv2.VideoCapture(src)
            if not self.args.video:
                c.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                c.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            return c, src

        cap, cam_src = open_cam()
        if not cap.isOpened():
            self.status.update(camera="failed", error="The camera could not be opened. Allow camera access for Terminal in System Settings > Privacy & Security > Camera, then restart Airpane.")
            return
        self.status["camera"] = "on"
        t_start = time.monotonic()
        last_ts = -1
        fps_t, fps_n = time.monotonic(), 0
        video_fps = cap.get(cv2.CAP_PROP_FPS) or 30
        n = 0
        try:
            while self.running:
                if not self.args.video and self.cfg["camera"] != cam_src:
                    cap.release()
                    cap, cam_src = open_cam()
                    if not cap.isOpened():
                        self.status.update(camera="failed", error=f"Camera {cam_src} could not be opened. Pick another camera in Tuning.")
                        time.sleep(0.5)
                        continue
                    self.status.update(camera="on", error="")
                ok, frame = cap.read()
                if not ok and self.args.video and self.args.loop:
                    cap.release()
                    cap, cam_src = open_cam()
                    ok, frame = cap.read()
                if not ok:
                    if self.args.video:
                        break
                    self.status["camera"] = "no frames"
                    time.sleep(0.05)
                    continue
                self.status["camera"] = "on"
                n += 1
                if self.cfg["mirror"]:
                    frame = cv2.flip(frame, 1)
                # Video files run on their own clock so tests are repeatable.
                t = n / video_fps if self.args.video else time.monotonic() - t_start
                ts = int(t * 1000)
                if ts <= last_ts:
                    ts = last_ts + 1
                last_ts = ts
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                res = lmk.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts)
                lm = [(p.x, p.y) for p in res.hand_landmarks[0]] if res.hand_landmarks else None
                with self.lock:
                    cmds = self.engine.update(lm, t)
                self.exec.run(cmds)
                if self.args.trace:
                    for c in cmds:
                        self.args.trace.write(json.dumps({"t": round(t, 3), **c}) + "\n")
                fps_n += 1
                if time.monotonic() - fps_t >= 1:
                    self.status["fps"] = round(fps_n / (time.monotonic() - fps_t), 1)
                    fps_t, fps_n = time.monotonic(), 0
                self.status["frames"] = n
                if self.viewers:
                    self._preview(frame, lm)
                self.frame_evt.set()
                if self.args.frames and n >= self.args.frames:
                    break
                if self.args.video and self.args.realtime:
                    time.sleep(max(0, 1 / video_fps - 0.001))
        finally:
            cap.release()
            lmk.close()
            self.exec.release_all()
            self.status["camera"] = "stopped"
            if self.args.video:
                self.running = False

    def _preview(self, frame, lm):
        import cv2
        h, w = frame.shape[:2]
        img = frame.copy()
        c = self.cfg["cursor"]
        a = c["area"]
        x0, y0 = int((c["center_x"] - a / 2) * w), int((c["center_y"] - a / 2) * h)
        x1, y1 = int((c["center_x"] + a / 2) * w), int((c["center_y"] + a / 2) * h)
        cv2.rectangle(img, (x0, y0), (x1, y1), (211, 245, 124), 1)
        if lm:
            pts = [(int(x * w), int(y * h)) for x, y in lm]
            for i, j in CONNECTIONS:
                cv2.line(img, pts[i], pts[j], (211, 245, 124), 2)
            for p in pts:
                cv2.circle(img, p, 3, (255, 255, 255), -1)
            anchor = pts[8] if c["anchor"] == "fingertip" else pts[5]
            cv2.circle(img, anchor, 9, (102, 209, 255), 2)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            with self.jpeg_cond:
                self.jpeg = buf.tobytes()
                self.jpeg_cond.notify_all()

    # ----- safety hotkeys -----
    def hotkeys(self):
        if self.args.no_hotkeys:
            return
        try:
            from pynput import keyboard
            hk = keyboard.GlobalHotKeys({
                "<ctrl>+<alt>+p": lambda: self.set_paused(not self.engine.paused),
                "<ctrl>+<alt>+q": self.stop,
            })
            hk.daemon = True
            hk.start()
        except Exception as e:
            self.status["error"] = self.status["error"] or f"Shortcut keys unavailable: {e}"

    def stop(self):
        self.running = False
        self.exec.release_all()


def main(argv=None):
    p = argparse.ArgumentParser(prog="airpane", description="Control your computer with hand gestures.")
    p.add_argument("--port", type=int, default=int(os.environ.get("AIRPANE_PORT", 47210)))
    p.add_argument("--no-browser", action="store_true", help="don't open the settings page")
    p.add_argument("--dry-run", action="store_true", help="test mode: show gestures without controlling the computer")
    p.add_argument("--video", help="use a video file instead of the camera (testing)")
    p.add_argument("--realtime", action="store_true", help="play --video at its real speed")
    p.add_argument("--loop", action="store_true", help="repeat --video (testing the settings page)")
    p.add_argument("--frames", type=int, default=0, help="stop after this many frames")
    p.add_argument("--model", help="hand_landmarker.task path")
    p.add_argument("--settings", help="settings.json path")
    p.add_argument("--trace", type=argparse.FileType("w"), help="write every command as JSON lines")
    p.add_argument("--no-hotkeys", action="store_true")
    p.add_argument("--no-server", action="store_true")
    args = p.parse_args(argv)

    app = App(args)
    server = None
    if not args.no_server:
        from .server import serve
        try:
            server = serve(app, args.port)
        except OSError:
            url = f"http://127.0.0.1:{args.port}/"
            print(f"Airpane is already running. Settings: {url}", flush=True)
            if not args.no_browser:
                webbrowser.open(url)
            return 0
        url = f"http://127.0.0.1:{server.server_address[1]}/"
        print(f"Airpane is running. Settings: {url}", flush=True)
        print("Pause or resume: hold a fist, or press Ctrl+Alt+P.  Quit: Ctrl+Alt+Q or Ctrl+C here.", flush=True)
        if not args.no_browser:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    app.hotkeys()
    worker = threading.Thread(target=app.run, daemon=True)
    worker.start()
    try:
        while app.running and worker.is_alive():
            worker.join(0.3)
        if app.status.get("error") and not args.video:
            print(app.status["error"], file=sys.stderr, flush=True)
            # keep the settings page up so the problem is visible there
            while app.running and server is not None:
                time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
        if server:
            server.shutdown()
        if args.trace:
            args.trace.close()
    return 0 if app.status.get("tracker") != "failed" else 1


if __name__ == "__main__":
    sys.exit(main())
