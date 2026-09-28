"""Settings and gesture rules, stored as JSON in the user's settings folder."""
from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path

from .poses import POSES

# Gestures a rule can listen to.
#  - poses fire once when held still for hold_ms (and again every repeat_ms if set)
#  - swipes fire when an open hand moves quickly in one direction
GESTURES = dict(POSES)
GESTURES.update({
    "swipe_left": "Swipe left (open hand)",
    "swipe_right": "Swipe right (open hand)",
    "swipe_up": "Swipe up (open hand)",
    "swipe_down": "Swipe down (open hand)",
})

# What a rule can do. "keys" is a shortcut like "cmd+shift+4" (cmd is Ctrl on Windows/Linux).
ACTIONS = {
    "left_click": "Left click",
    "right_click": "Right click",
    "double_click": "Double click",
    "middle_click": "Middle click",
    "hotkey": "Keyboard shortcut",
    "type_text": "Type text",
    "scroll_up": "Scroll up",
    "scroll_down": "Scroll down",
    "volume_up": "Volume up",
    "volume_down": "Volume down",
    "mute": "Mute",
    "play_pause": "Play / pause",
    "next_track": "Next track",
    "previous_track": "Previous track",
    "mission_control": "Mission Control (all windows)",
    "app_switcher": "Switch app (Cmd+Tab)",
    "next_desktop": "Next desktop",
    "previous_desktop": "Previous desktop",
    "show_desktop": "Show desktop",
    "spotlight": "Search (Spotlight)",
    "screenshot": "Screenshot (select area)",
    "close_window": "Close window",
    "browser_back": "Back (browser)",
    "browser_forward": "Forward (browser)",
    "toggle_pause": "Pause / resume Airpane",
    "none": "Do nothing",
}

# Built-in behaviours that are not single-shot rules.
MODES = {
    "cursor_pose": "Pose that moves the cursor",
    "click_pose": "Pose that clicks (tap) and drags (hold)",
    "right_click_pose": "Pose that right clicks",
    "scroll_pose": "Pose that scrolls when moved",
}

DEFAULTS = {
    "version": 1,
    "camera": 0,
    "mirror": True,
    "paused": False,
    "dry_run": False,
    "cursor": {
        "cursor_pose": "point",
        "click_pose": "pinch",
        "right_click_pose": "pinch_middle",
        "scroll_pose": "peace",
        "anchor": "knuckle",          # knuckle (steady) or fingertip
        "area": 0.5,                  # part of the camera view that maps to the whole screen
        "center_x": 0.5,
        "center_y": 0.45,
        "smoothing": 0.6,             # 0 = raw, 1 = very smooth
        "click_ms": 350,              # pinch shorter than this = click
        "drag_move": 0.035,           # pinch and move this far = drag
        "scroll_speed": 1.0,
        "natural_scroll": True,
    },
    # Every gesture does exactly one thing: no rule shares a gesture with another rule
    # or with the hand controls above (validate() enforces this).
    "rules": [
        {"gesture": "fist", "action": "toggle_pause", "hold_ms": 1200, "cooldown_ms": 1500, "repeat_ms": 0, "keys": "", "text": "", "enabled": True},
        {"gesture": "swipe_left", "action": "next_desktop", "hold_ms": 0, "cooldown_ms": 900, "repeat_ms": 0, "keys": "", "text": "", "enabled": True},
        {"gesture": "swipe_right", "action": "previous_desktop", "hold_ms": 0, "cooldown_ms": 900, "repeat_ms": 0, "keys": "", "text": "", "enabled": True},
        {"gesture": "swipe_up", "action": "mission_control", "hold_ms": 0, "cooldown_ms": 900, "repeat_ms": 0, "keys": "", "text": "", "enabled": True},
        {"gesture": "swipe_down", "action": "show_desktop", "hold_ms": 0, "cooldown_ms": 900, "repeat_ms": 0, "keys": "", "text": "", "enabled": True},
        {"gesture": "three", "action": "app_switcher", "hold_ms": 500, "cooldown_ms": 1000, "repeat_ms": 0, "keys": "", "text": "", "enabled": True},
        {"gesture": "thumbs_up", "action": "volume_up", "hold_ms": 500, "cooldown_ms": 0, "repeat_ms": 400, "keys": "", "text": "", "enabled": True},
        {"gesture": "thumbs_down", "action": "volume_down", "hold_ms": 500, "cooldown_ms": 0, "repeat_ms": 400, "keys": "", "text": "", "enabled": True},
        {"gesture": "rock", "action": "play_pause", "hold_ms": 600, "cooldown_ms": 1500, "repeat_ms": 0, "keys": "", "text": "", "enabled": True},
        {"gesture": "call", "action": "mute", "hold_ms": 600, "cooldown_ms": 1500, "repeat_ms": 0, "keys": "", "text": "", "enabled": True},
        {"gesture": "four", "action": "screenshot", "hold_ms": 800, "cooldown_ms": 2000, "repeat_ms": 0, "keys": "", "text": "", "enabled": True},
    ],
}

RULE_KEYS = {"gesture", "action", "hold_ms", "cooldown_ms", "repeat_ms", "keys", "text", "enabled", "clash"}
MODE_KEYS = ("cursor_pose", "click_pose", "right_click_pose", "scroll_pose")
MODE_NAMES = {"cursor_pose": "moving the cursor", "click_pose": "click and drag", "right_click_pose": "right click", "scroll_pose": "scrolling"}
SWIPES = ("swipe_left", "swipe_right", "swipe_up", "swipe_down")


def owners(cfg: dict) -> dict:
    """Which job each gesture is used for. Swipes are made with an open hand, so they
    also claim the open-hand pose."""
    own = {}
    for k in MODE_KEYS:
        p = cfg["cursor"][k]
        if p != "none":
            own.setdefault(p, MODE_NAMES[k])
    for r in cfg["rules"]:
        if r["enabled"] and not r.get("clash"):
            label = ACTIONS[r["action"]]
            own.setdefault(r["gesture"], label)
            if r["gesture"] in SWIPES:
                own.setdefault("open_palm", "swipes")
    return own


def settings_dir() -> Path:
    if os.environ.get("AIRPANE_HOME"):
        return Path(os.environ["AIRPANE_HOME"])
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Airpane"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home())) / "Airpane"
    return Path.home() / ".config" / "airpane"


def _num(v, lo, hi, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def validate(cfg: dict) -> dict:
    """Return a clean config: unknown keys dropped, numbers clamped, bad rules removed."""
    out = copy.deepcopy(DEFAULTS)
    if not isinstance(cfg, dict):
        return out
    out["camera"] = int(_num(cfg.get("camera", 0), 0, 9, 0))
    for k in ("mirror", "paused", "dry_run"):
        if k in cfg:
            out[k] = bool(cfg[k])
    c, d = cfg.get("cursor") or {}, DEFAULTS["cursor"]
    oc = out["cursor"]
    for k in ("cursor_pose", "click_pose", "right_click_pose", "scroll_pose"):
        if c.get(k) in POSES or c.get(k) == "none":
            oc[k] = c[k]
    if c.get("anchor") in ("knuckle", "fingertip"):
        oc["anchor"] = c["anchor"]
    oc["area"] = _num(c.get("area", d["area"]), 0.2, 1.0, d["area"])
    oc["center_x"] = _num(c.get("center_x", d["center_x"]), 0.1, 0.9, d["center_x"])
    oc["center_y"] = _num(c.get("center_y", d["center_y"]), 0.1, 0.9, d["center_y"])
    oc["smoothing"] = _num(c.get("smoothing", d["smoothing"]), 0.0, 0.95, d["smoothing"])
    oc["click_ms"] = int(_num(c.get("click_ms", d["click_ms"]), 100, 1500, d["click_ms"]))
    oc["drag_move"] = _num(c.get("drag_move", d["drag_move"]), 0.005, 0.2, d["drag_move"])
    oc["scroll_speed"] = _num(c.get("scroll_speed", d["scroll_speed"]), 0.1, 5.0, d["scroll_speed"])
    if "natural_scroll" in c:
        oc["natural_scroll"] = bool(c["natural_scroll"])
    if isinstance(cfg.get("rules"), list):
        rules = []
        for r in cfg["rules"][:50]:
            if not isinstance(r, dict) or r.get("gesture") not in GESTURES or r.get("action") not in ACTIONS:
                continue
            rules.append({
                "gesture": r["gesture"],
                "action": r["action"],
                "hold_ms": int(_num(r.get("hold_ms", 0), 0, 10000, 0)),
                "cooldown_ms": int(_num(r.get("cooldown_ms", 0), 0, 60000, 0)),
                "repeat_ms": int(_num(r.get("repeat_ms", 0), 0, 10000, 0)),
                "keys": str(r.get("keys", ""))[:60],
                "text": str(r.get("text", ""))[:500],
                "enabled": bool(r.get("enabled", True)),
                "clash": str(r.get("clash") or "")[:200],
            })
        out["rules"] = rules
    return enforce_unique(out)


def enforce_unique(cfg: dict) -> dict:
    """One gesture, one job. A hand control that repeats an earlier one is switched off;
    a rule whose gesture is already taken is switched off and marked as a clash."""
    c = cfg["cursor"]
    seen = set()
    for k in MODE_KEYS:
        if c[k] != "none" and c[k] in seen:
            c[k] = "none"
        seen.add(c[k])
    taken = {c[k]: MODE_NAMES[k] for k in MODE_KEYS if c[k] != "none"}
    any_swipe = any(r["enabled"] and r["gesture"] in SWIPES for r in cfg["rules"])
    for r in cfg["rules"]:
        # A rule switched off earlier because of a clash is checked again, so the
        # reason stays visible (or clears once its gesture is free).
        was_clash = bool(r.get("clash")) and not r["enabled"]
        r["clash"] = ""
        if not r["enabled"] and not was_clash:
            continue
        g = r["gesture"]
        if g in SWIPES and "open_palm" in taken and taken["open_palm"] != "swipes":
            r["clash"] = f"Swipes use an open hand, which is already used for {taken['open_palm']}."
        elif g == "open_palm" and any_swipe and g not in taken:
            r["clash"] = "An open hand is already used for swipes."
        elif g in taken:
            r["clash"] = f"This gesture is already used for {taken[g]}."
        if r["clash"]:
            r["enabled"] = False
            continue
        if was_clash:
            continue  # gesture is free now, but the user switches it back on
        taken[g] = ACTIONS[r["action"]]
        if g in SWIPES:
            taken.setdefault("open_palm", "swipes")
    return cfg


def conflicts(cfg: dict) -> list[str]:
    """Plain-language notes about rules that were switched off, and a missing pause."""
    out = []
    for r in cfg["rules"]:
        if r.get("clash"):
            out.append(f"'{GESTURES[r['gesture']]}' then {ACTIONS[r['action']]} is off: {r['clash']} Pick another gesture.")
    if not any(r["enabled"] and r["action"] == "toggle_pause" for r in cfg["rules"]):
        out.append("No gesture pauses Airpane. The Pause button and the Ctrl+Alt+P shortcut still work.")
    return out


class Store:
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else settings_dir() / "settings.json"

    def load(self) -> dict:
        try:
            return validate(json.loads(self.path.read_text()))
        except (OSError, ValueError):
            return validate(copy.deepcopy(DEFAULTS))

    def save(self, cfg: dict) -> dict:
        cfg = validate(cfg)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cfg, indent=2))
        os.replace(tmp, self.path)
        return cfg
