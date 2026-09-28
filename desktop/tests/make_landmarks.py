"""Extract real hand landmarks from the fixture photos (mirrored, like the live camera)
and derive the poses no photo shows. Run once; writes tests/fixtures/landmarks.json."""
import json, sys, cv2, mediapipe as mp
from pathlib import Path
from mediapipe.tasks.python import vision, BaseOptions
here = Path(__file__).parent
model = sys.argv[1]
lmk = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=model), num_hands=1, running_mode=vision.RunningMode.IMAGE))
real = {}
for name, f in {"point": "pointing_up", "fist": "fist", "peace": "victory", "thumbs_up": "thumb_up", "open_palm": "open_palm"}.items():
    img = cv2.cvtColor(cv2.flip(cv2.imread(str(here / "fixtures" / f"{f}.jpg")), 1), cv2.COLOR_BGR2RGB)
    r = lmk.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=img))
    real[name] = [[round(p.x, 5), round(p.y, 5)] for p in r.hand_landmarks[0]]
lmk.close()

def lerp(a, b, k): return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
def curl(lm, f):  # fold a finger: tip and joints back towards the knuckle
    m = lm[f[0]]
    for j, k in zip(f[1:], (0.55, 0.75, 0.85)):
        lm[j] = lerp(lm[j], lm[0], k * 0.6)
    lm[f[3]] = lerp(m, lm[0], 0.25)
    return lm
import copy
d = {}
p = copy.deepcopy(real["point"])          # pinch: thumb tip meets the index tip
p[4] = lerp(p[8], p[3], 0.08); p[3] = lerp(p[3], p[8], 0.5)
p[8] = lerp(p[8], p[5], 0.25); p[7] = lerp(p[7], p[5], 0.15)
p[4] = lerp(p[8], p[3], 0.05)
d["pinch"] = p
q = copy.deepcopy(real["open_palm"])      # middle pinch: thumb meets middle tip, index stays up
q = curl(q, (13, 14, 15, 16)); q = curl(q, (17, 18, 19, 20))
q[12] = lerp(q[12], q[9], 0.3); q[4] = lerp(q[12], q[3], 0.05); q[3] = lerp(q[3], q[12], 0.5)
d["pinch_middle"] = q
d["three"] = curl(copy.deepcopy(real["open_palm"]), (17, 18, 19, 20))
r3 = copy.deepcopy(real["open_palm"]); r3 = curl(r3, (9, 10, 11, 12)); r3 = curl(r3, (13, 14, 15, 16))
d["rock"] = r3
json.dump({"real": real, "derived": d}, open(here / "fixtures" / "landmarks.json", "w"))
print("ok")
