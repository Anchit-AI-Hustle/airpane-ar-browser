"""Build a test video of real hands (photos) moving like a person using Airpane.
Timeline (seconds): point sweep 0-1.5, hold 1.5-2.1, pinch 2.1-2.35 (click), point 2.35-3.0,
open hand 3.0-3.5 then fast swipe left 3.5-3.75, open hand 3.75-4.3, V sign 4.3-4.7 then moving up 4.7-5.4 (scroll), 5.4-5.7,
fist 5.7-7.4 (pause), point moving 7.4-8.6 (must do nothing), end."""
import sys, cv2, numpy as np
from pathlib import Path
here = Path(__file__).parent
out = sys.argv[1]
W, H, FPS = 640, 480, 30
def load(p, size=230):
    im = cv2.imread(str(p)); h, w = im.shape[:2]; k = size / max(h, w)
    return cv2.resize(im, (int(w * k), int(h * k)))
point = load(here / "fixtures" / "pointing_up.jpg")
palm = load(here / "fixtures" / "open_palm.jpg")
fist = load(here / "fixtures" / "fist.jpg")
pinch = load(sys.argv[2], 260)  # a real OK-sign photo (thumb and index touching)
# the app mirrors the camera, so draw the scene mirrored: x here is where it appears after the flip
def frame(img, cx, cy):
    f = np.full((H, W, 3), (200, 205, 210), np.uint8)
    h, w = img.shape[:2]; x0, y0 = int(cx * W - w / 2), int(cy * H - h / 2)
    xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
    f[ya:yb, xa:xb] = img[ya - y0:yb - y0, xa - x0:xb - x0]
    return cv2.flip(f, 1)
seg = []
def add(img, secs, x0, x1=None, y=0.5):
    n = int(round(secs * FPS)); x1 = x0 if x1 is None else x1
    for i in range(n):
        k = i / max(1, n - 1); seg.append(frame(img, x0 + (x1 - x0) * k, y))
add(point, 1.5, 0.30, 0.70)
add(point, 0.6, 0.70)
add(pinch, 0.25, 0.70)
add(point, 0.65, 0.70)
add(palm, 0.5, 0.70)
add(palm, 0.25, 0.70, 0.25)
add(palm, 0.55, 0.25)
peace = load(here / "fixtures" / "victory.jpg")
add(peace, 0.4, 0.5, y=0.62)
n = int(0.7 * FPS)
for i in range(n):  # V sign moving up: scroll
    seg.append(frame(peace, 0.5, 0.62 - 0.26 * i / (n - 1)))
add(peace, 0.3, 0.5, y=0.36)
add(fist, 1.7, 0.5)
add(point, 1.2, 0.3, 0.7)
vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
for f in seg: vw.write(f)
vw.release(); print(len(seg), "frames")
