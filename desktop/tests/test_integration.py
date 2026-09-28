"""End to end: a video of real hands drives the real app, which controls a real
(virtual) screen. A separate recorder captures what the computer receives.

Needs Linux with Xvfb (the CI image has it). Usage:
  python tests/test_integration.py MODEL.task OK_SIGN_PHOTO.jpg
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent
model, ok_photo = sys.argv[1], sys.argv[2]
tmp = Path(tempfile.mkdtemp())
fails = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        fails.append(name)


video = tmp / "hands.mp4"
subprocess.run([sys.executable, str(HERE / "make_video.py"), str(video), ok_photo], check=True, capture_output=True)
xvfb = subprocess.Popen(["Xvfb", ":98", "-screen", "0", "1280x800x24", "+extension", "RECORD"], stderr=subprocess.DEVNULL)
time.sleep(1.5)
env = dict(os.environ, DISPLAY=":98", AIRPANE_HOME=str(tmp / "home"))
try:
    rec = subprocess.Popen([sys.executable, str(HERE / "recorder.py"), str(tmp / "rec.jsonl"), "20"], env=env)
    time.sleep(1.5)
    r = subprocess.run([sys.executable, "-m", "airpane_desktop", "--video", str(video), "--realtime", "--no-browser",
                        "--no-hotkeys", "--model", model, "--trace", str(tmp / "trace.jsonl"), "--port", "47298"],
                       cwd=ROOT, env=env, capture_output=True, text=True, timeout=90)
    time.sleep(1.0)
    rec.terminate()
    check("app exits cleanly", r.returncode == 0, r.stderr[-400:])
    T = [json.loads(l) for l in open(tmp / "trace.jsonl")]
    R = [json.loads(l) for l in open(tmp / "rec.jsonl")]
    moves = [x for x in R if x["ev"] == "move"]
    xs = [m["x"] for m in moves]
    check("real cursor moves", len(moves) >= 20, len(moves))
    check("cursor sweeps most of the screen", xs and max(xs) - min(xs) > 640, (min(xs), max(xs)) if xs else None)
    presses = [x for x in R if x["ev"] == "click" and x["b"] == "left"]
    check("one real left click (press + release)", [p["down"] for p in presses] == [True, False], presses)
    if len(presses) == 2:
        check("click lands where the hand pointed, without sliding", presses[0]["x"] == presses[1]["x"] and presses[0]["y"] == presses[1]["y"])
    keys = [x["key"] for x in R if x["ev"] == "key"]
    check("swipe left presses the next-desktop shortcut", keys[:3] == ["Key.ctrl", "Key.alt", "Key.right"], keys)
    sc = [x["dy"] for x in R if x["ev"] == "scroll"]
    check("V sign moving up scrolls the page down (natural)", len(sc) >= 3 and sum(sc) < -3, sc)
    kinds = [x.get("action", x["do"]) for x in T if x["do"] not in ("move", "scroll")]
    check("only the intended actions fire, nothing extra while the hand changes pose", kinds == ["click", "next_desktop", "paused"], kinds)
    pt = [x["t"] for x in T if x["do"] == "paused"]
    check("holding a fist pauses", pt and [x["value"] for x in T if x["do"] == "paused"] == [True])
    if pt:
        after = [x for x in T if x["t"] > pt[0] and x["do"] != "paused"]
        check("nothing happens while paused", after == [], after[:3])
    sent = sum(1 for x in T if x["do"] == "move") + sum(1 for x in T if x["do"] == "click" and "x" in x)  # a click also places the cursor
    check("recorder saw every cursor move the app made", len(moves) == sent, (len(moves), sent))
finally:
    xvfb.terminate()
print(f"\n{'ALL PASSED' if not fails else str(len(fails)) + ' FAILED'}")
sys.exit(1 if fails else 0)
