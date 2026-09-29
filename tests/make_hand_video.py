"""Fake webcam for the browser hand-gesture test, built from real hand photos.
Timeline: index finger moving down (scroll down), hand leaves, open hand (cursor), fist (click).
Usage: python tests/make_hand_video.py out.y4m"""
import subprocess, sys, tempfile
from pathlib import Path
import cv2, numpy as np
fx = Path(__file__).resolve().parent.parent / "desktop" / "tests" / "fixtures"
W, H, FPS = 640, 480, 15
def load(name, size=230):
    im = cv2.imread(str(fx / name)); h, w = im.shape[:2]; k = size / max(h, w)
    return cv2.resize(im, (int(w * k), int(h * k)))
palm, point, fist = load("open_palm.jpg"), load("pointing_up.jpg"), load("fist.jpg")
def frame(img, cx, cy):
    f = np.full((H, W, 3), (200, 205, 210), np.uint8)
    if img is not None:
        h, w = img.shape[:2]; x0, y0 = int(cx * W - w / 2), int(cy * H - h / 2)
        xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
        f[ya:yb, xa:xb] = img[ya - y0:yb - y0, xa - x0:xb - x0]
    return cv2.flip(f, 1)  # drawn mirrored: x is where it appears in the mirrored preview
seg = []
def add(img, secs, x0, x1=None, y0=0.5, y1=None):
    n = max(1, int(round(secs * FPS))); x1 = x0 if x1 is None else x1; y1 = y0 if y1 is None else y1
    for i in range(n):
        k = i / max(1, n - 1); seg.append(frame(img, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k))
# Slow on purpose: the test machine only runs hand tracking a few times a second.
add(point, 3, 0.5, y0=0.36)
add(point, 8, 0.5, y0=0.36, y1=0.70)          # index finger moving down: scroll down
add(None, 2, 0.5)                             # hand leaves the frame
add(palm, 4, 0.5, y0=0.5)                     # open hand: cursor
add(fist, 4, 0.5, y0=0.5)                     # close into a fist: click
add(None, 3, 0.5)
with tempfile.TemporaryDirectory() as d:
    for i, f in enumerate(seg): cv2.imwrite(f"{d}/{i:04d}.png", f)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i", f"{d}/%04d.png", "-pix_fmt", "yuv420p", sys.argv[1]], check=True)
print(len(seg), "frames")
