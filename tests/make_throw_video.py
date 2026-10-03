"""Fake webcam for the pinch-and-throw test, built from a real hand photo (HaGRID "ok").
Timeline: no hand, pointing down (scroll), pinch held still (grab), a fast swing upwards, the hand leaves (throw).
Usage: python tests/make_throw_video.py out.y4m"""
import subprocess, sys, tempfile
from pathlib import Path
import cv2, numpy as np
here = Path(__file__).resolve().parent
W, H, FPS = 640, 480, 15
def load(p, size=230):
    im = cv2.imread(str(p)); h, w = im.shape[:2]; k = size / max(h, w)
    return cv2.resize(im, (int(w * k), int(h * k)))
pinch = load(here / "fixtures" / "pinch.jpg")
up = load(here.parent / "desktop" / "tests" / "fixtures" / "pointing_up.jpg")
down = cv2.rotate(up, cv2.ROTATE_180)
def frame(img, cx, cy):
    f = np.full((H, W, 3), (200, 205, 210), np.uint8)
    if img is not None:
        h, w = img.shape[:2]; x0, y0 = int(cx * W - w / 2), int(cy * H - h / 2)
        xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
        f[ya:yb, xa:xb] = img[ya - y0:yb - y0, xa - x0:xb - x0]
    return cv2.flip(f, 1)
seg = []
def add(img, secs, x0, x1=None, y0=0.5, y1=None):
    n = max(1, int(round(secs * FPS))); x1 = x0 if x1 is None else x1; y1 = y0 if y1 is None else y1
    for i in range(n):
        k = i / max(1, n - 1); seg.append(frame(img, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k))
add(None, 2, 0.5)
add(down, 5, 0.5)                           # point down: scroll down (keeps going)
add(None, 1.5, 0.5)
add(pinch, 5, 0.5, y0=0.72)                 # pinch held still: grab
add(pinch, 0.8, 0.5, y0=0.72, y1=0.3)       # a quick swing upwards
add(pinch, 0.35, 0.5, y0=0.3)               # (a moment at the top: this test machine only sees a few frames a second)
add(None, 4, 0.5)                           # let go / hand leaves: throw
with tempfile.TemporaryDirectory() as d:
    for i, f in enumerate(seg): cv2.imwrite(f"{d}/{i:04d}.png", f)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i", f"{d}/%04d.png", "-pix_fmt", "yuv420p", sys.argv[1]], check=True)
print(len(seg), "frames")
