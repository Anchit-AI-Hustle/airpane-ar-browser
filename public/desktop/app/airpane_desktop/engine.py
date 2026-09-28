"""Turns a stream of hand landmarks into computer actions, following the user's rules.

Pure logic: no camera and no operating system calls, so it can be tested exactly.
update() takes mirrored, normalized landmarks (or None when no hand is seen) and a
time in seconds, and returns a list of commands for the executor:

  {"do": "move", "x": 0..1, "y": 0..1}     cursor position as a fraction of the screen
  {"do": "down"} / {"do": "up"}              left button (dragging)
  {"do": "click", "button": "left"|"right"}
  {"do": "scroll", "dx": int, "dy": int}     wheel steps (dy > 0 scrolls up)
  {"do": "action", "action": name, "keys": str, "text": str, "rule": index}
  {"do": "paused", "value": bool}
"""
from __future__ import annotations

import math
from collections import deque

from .config import ACTIONS, GESTURES
from .poses import INDEX, MIDDLE, WRIST, classify

KNUCKLE = INDEX[0]
TIP = INDEX[3]
POSE_FRAMES = 2          # a new pose must be seen this many frames in a row
STILL_MOVE = 0.045       # hand moving more than this (of the camera view) restarts a hold
SWIPE_WINDOW = 0.35      # seconds
SWIPE_DIST = 0.18        # of the camera view
SWIPE_BLOCK = 0.6        # seconds with no swipe after one fires
CLICK_FREEZE = 0.09      # use the cursor position from this long before the pinch
RIGHT_CLICK_GAP = 0.4


class OneEuro:
    """One Euro filter: smooth when the hand is slow, responsive when it is fast."""

    def __init__(self, min_cutoff=1.0, beta=8.0, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x = self.dx = self.t = None

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def reset(self):
        self.x = self.dx = self.t = None

    def __call__(self, x, t):
        if self.t is None or t <= self.t:
            self.x, self.dx, self.t = x, 0.0, t
            return x
        dt = t - self.t
        dx = (x - self.x) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        self.dx = a_d * dx + (1 - a_d) * self.dx
        cutoff = self.min_cutoff + self.beta * abs(self.dx)
        a = self._alpha(cutoff, dt)
        self.x = a * x + (1 - a) * self.x
        self.t = t
        return self.x


def palm_center(lm):
    pts = [lm[i] for i in (WRIST, 5, 9, 13, 17)]
    return (sum(p[0] for p in pts) / 5, sum(p[1] for p in pts) / 5)


class Engine:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.paused = bool(cfg.get("paused"))
        self._setup_filters()
        self.pose = "none"          # stable pose
        self._raw = "none"
        self._raw_n = 0
        self.pose_since = 0.0
        self.still_ref = None
        self.still_since = 0.0
        self.cursor = None          # smoothed screen position (0..1)
        self.hist = deque()         # (t, x, y) cursor history, for click freezing
        self.pinch = None           # {"t0", "start", "freeze", "dragging"}
        self.scroll_ref = None
        self.scroll_acc = [0.0, 0.0]
        self.swipe_hist = deque()
        self.swipe_block_until = 0.0
        self.rule_state = {}        # index -> {"fired": t, "last": t}
        self.last_right = -1.0
        self.last_event = ""
        self.hand = False
        self._certain = True

    # ----- settings -----
    def set_config(self, cfg: dict):
        self.cfg = cfg
        self.paused = bool(cfg.get("paused", self.paused))
        self._setup_filters()
        self.rule_state = {}

    def _setup_filters(self):
        s = self.cfg["cursor"]["smoothing"]
        mc = 0.35 + (1 - s) * 3.0
        self.fx, self.fy = OneEuro(mc, 6.0), OneEuro(mc, 6.0)

    @property
    def state(self):
        return {
            "hand": self.hand,
            "pose": self.pose,
            "paused": self.paused,
            "cursor": self.cursor,
            "dragging": bool(self.pinch and self.pinch["dragging"]),
            "last": self.last_event,
        }

    # ----- helpers -----
    def _anchor(self, lm):
        return lm[TIP] if self.cfg["cursor"]["anchor"] == "fingertip" else lm[KNUCKLE]

    def _to_screen(self, p):
        c = self.cfg["cursor"]
        a = c["area"]
        x = (p[0] - (c["center_x"] - a / 2)) / a
        y = (p[1] - (c["center_y"] - a / 2)) / a
        return min(1.0, max(0.0, x)), min(1.0, max(0.0, y))

    def _cursor_at(self, t_before):
        best = None
        for t, x, y in self.hist:
            if t <= t_before:
                best = (x, y)
        return best or (self.cursor if self.cursor else None)

    def _label(self, text):
        self.last_event = text

    # ----- main -----
    def update(self, lm, t):
        out = []
        if lm is None:
            self.hand = False
            if self.pinch and self.pinch["dragging"]:
                out.append({"do": "up"})
                self._label("Hand lost: released drag")
            self.pinch = None
            self.scroll_ref = None
            self.swipe_hist.clear()
            self._set_pose("none", t)
            self.fx.reset(); self.fy.reset()
            return out
        self.hand = True

        raw = classify(lm, was_pinched=self.pose == "pinch", was_pinched_middle=self.pose == "pinch_middle")
        if raw == self._raw:
            self._raw_n += 1
        else:
            self._raw, self._raw_n = raw, 1
        prev = self.pose
        if raw != self.pose and self._raw_n >= POSE_FRAMES:
            self._set_pose(raw, t)
        # False on frames where the hand is changing shape: the stable pose is still the
        # old one, but the landmarks already belong to the new one. Motion is ignored then.
        self._certain = raw == self.pose

        # stillness, for hold rules
        pc = palm_center(lm)
        if self.still_ref is None or math.dist(pc, self.still_ref) > STILL_MOVE:
            self.still_ref, self.still_since = pc, t

        # rules (pause toggle works even while paused)
        out += self._rules(t, pc)
        if self.paused:
            if self.pinch and self.pinch["dragging"]:
                out.append({"do": "up"})
            self.pinch = None
            return out

        c = self.cfg["cursor"]
        # cursor position (always tracked so clicks land where the user pointed)
        sx, sy = self._to_screen(self._anchor(lm))
        fx, fy = self.fx(sx, t), self.fy(sy, t)
        # Move only while the pose is certain: in the frame where the hand changes shape,
        # the old pose still applies but the landmarks already belong to the new one.
        moving_pose = raw == self.pose and (self.pose == c["cursor_pose"] or (self.pose == c["click_pose"] and self.pinch and self.pinch["dragging"]))
        if moving_pose:
            if self.cursor is None or abs(fx - self.cursor[0]) > 0.0004 or abs(fy - self.cursor[1]) > 0.0004:
                self.cursor = (fx, fy)
                out.append({"do": "move", "x": fx, "y": fy})
            self.hist.append((t, fx, fy))
        while self.hist and self.hist[0][0] < t - 1.0:
            self.hist.popleft()

        out += self._click(t, prev, sx, sy, certain=raw == self.pose)
        out += self._right_click(t, prev)
        out += self._scroll(lm, t)
        return out

    def _set_pose(self, pose, t):
        if pose != self.pose:
            self.pose = pose
            self.pose_since = t

    def _click(self, t, prev, sx, sy, certain=True):
        c = self.cfg["cursor"]
        out = []
        pinched = self.pose == c["click_pose"] and c["click_pose"] != "none"
        if pinched and self.pinch is None:
            freeze = self._cursor_at(t - CLICK_FREEZE) or (sx, sy)
            self.pinch = {"t0": t, "start": (sx, sy), "freeze": freeze, "dragging": False}
            if self.cursor != freeze:
                self.cursor = freeze
                out.append({"do": "move", "x": freeze[0], "y": freeze[1]})
        elif pinched and not self.pinch["dragging"]:
            # Only count movement on frames that really are a pinch; the frame where the
            # fingers open still reads "pinch" but the hand has already changed shape.
            moved = math.dist((sx, sy), self.pinch["start"]) * c["area"] if certain else 0.0  # camera units
            if t - self.pinch["t0"] > c["click_ms"] / 1000 or moved > c["drag_move"]:
                self.pinch["dragging"] = True
                out.append({"do": "down"})
                self._label("Drag")
        elif not pinched and self.pinch is not None:
            if self.pinch["dragging"]:
                out.append({"do": "up"})
                self._label("Drop")
            else:
                f = self.pinch["freeze"]
                out.append({"do": "click", "button": "left", "x": f[0], "y": f[1]})
                self._label("Click")
            self.pinch = None
        return out

    def _right_click(self, t, prev):
        c = self.cfg["cursor"]
        if c["right_click_pose"] == "none":
            return []
        if self.pose == c["right_click_pose"] and prev != self.pose and t - self.last_right > RIGHT_CLICK_GAP:
            self.last_right = t
            self._label("Right click")
            return [{"do": "click", "button": "right"}]
        return []

    def _scroll(self, lm, t):
        c = self.cfg["cursor"]
        if self.pose != c["scroll_pose"] or c["scroll_pose"] == "none":
            self.scroll_ref = None
            self.scroll_acc = [0.0, 0.0]
            return []
        p = palm_center(lm)
        if self.scroll_ref is None or not self._certain:
            self.scroll_ref = p if self._certain else None
            return []
        dx, dy = p[0] - self.scroll_ref[0], p[1] - self.scroll_ref[1]
        self.scroll_ref = p
        k = 60.0 * c["scroll_speed"]  # moving across the whole view is about 60 wheel steps
        sign = 1 if c["natural_scroll"] else -1
        self.scroll_acc[0] += -dx * k * sign
        self.scroll_acc[1] += dy * k * sign  # natural: hand up (dy<0) pushes the content up, like a touchscreen
        ix, iy = int(self.scroll_acc[0]), int(self.scroll_acc[1])
        if ix or iy:
            self.scroll_acc[0] -= ix
            self.scroll_acc[1] -= iy
            self._label("Scroll")
            return [{"do": "scroll", "dx": ix, "dy": iy}]
        return []

    def _swipe(self, t, pc):
        if self.pose != "open_palm" or t < self.swipe_block_until or not self._certain:
            self.swipe_hist.clear()
            return None
        self.swipe_hist.append((t, pc))
        while self.swipe_hist and self.swipe_hist[0][0] < t - SWIPE_WINDOW:
            self.swipe_hist.popleft()
        t0, p0 = self.swipe_hist[0]
        dx, dy = pc[0] - p0[0], pc[1] - p0[1]
        if abs(dx) > SWIPE_DIST and abs(dx) > 2 * abs(dy):
            g = "swipe_right" if dx > 0 else "swipe_left"
        elif abs(dy) > SWIPE_DIST and abs(dy) > 2 * abs(dx):
            g = "swipe_down" if dy > 0 else "swipe_up"
        else:
            return None
        self.swipe_hist.clear()
        self.swipe_block_until = t + SWIPE_BLOCK
        self.still_ref, self.still_since = pc, t
        return g

    def _rules(self, t, pc):
        out = []
        swipe = self._swipe(t, pc)
        held = t - max(self.pose_since, self.still_since)
        for i, r in enumerate(self.cfg["rules"]):
            if not r["enabled"] or r["action"] == "none":
                continue
            if self.paused and r["action"] != "toggle_pause":
                continue
            st = self.rule_state.setdefault(i, {"fired_for": None, "last": -1e9})
            g = r["gesture"]
            fire = False
            if g.startswith("swipe_"):
                fire = swipe == g
            elif self.pose == g:
                entry = self.pose_since
                if st["fired_for"] != entry:
                    fire = held >= r["hold_ms"] / 1000
                elif r["repeat_ms"] > 0 and t - st["last"] >= r["repeat_ms"] / 1000:
                    fire = True
            if fire and t - st["last"] < r["cooldown_ms"] / 1000:
                fire = False
            if fire:
                st["last"] = t
                if not g.startswith("swipe_"):
                    st["fired_for"] = self.pose_since
                if r["action"] == "toggle_pause":
                    self.paused = not self.paused
                    out.append({"do": "paused", "value": self.paused})
                    self._label("Paused" if self.paused else "Resumed")
                else:
                    out.append({"do": "action", "action": r["action"], "keys": r["keys"], "text": r["text"], "rule": i})
                    self._label(f"{GESTURES[g]}: {ACTIONS[r['action']]}")
        return out
