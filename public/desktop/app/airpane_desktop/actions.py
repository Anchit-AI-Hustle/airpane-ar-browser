"""Carries out engine commands on the real computer (mouse, keyboard, media keys)."""
from __future__ import annotations

import sys
import threading
import time
from collections import deque

MAC = sys.platform == "darwin"
WIN = sys.platform.startswith("win")

# System shortcuts per platform. "win" is the Windows/Super key, "cmd" is Command on a Mac.
PRESETS_MAC = {
    "mission_control": "ctrl+up",
    "app_switcher": "cmd+tab",
    "next_desktop": "ctrl+right",
    "previous_desktop": "ctrl+left",
    "show_desktop": "f11",
    "spotlight": "cmd+space",
    "screenshot": "cmd+shift+4",
    "close_window": "cmd+w",
    "browser_back": "cmd+[",
    "browser_forward": "cmd+]",
}
PRESETS_WIN = {
    "mission_control": "win+tab",
    "app_switcher": "alt+tab",
    "next_desktop": "ctrl+win+right",
    "previous_desktop": "ctrl+win+left",
    "show_desktop": "win+d",
    "spotlight": "win+s",
    "screenshot": "win+shift+s",
    "close_window": "ctrl+w",
    "browser_back": "alt+left",
    "browser_forward": "alt+right",
}
PRESETS_LINUX = dict(PRESETS_WIN, mission_control="win", next_desktop="ctrl+alt+right", previous_desktop="ctrl+alt+left", spotlight="win", screenshot="shift+print")
PRESETS = PRESETS_MAC if MAC else PRESETS_WIN if WIN else PRESETS_LINUX
MEDIA = {"volume_up": "media_volume_up", "volume_down": "media_volume_down", "mute": "media_volume_mute",
         "play_pause": "media_play_pause", "next_track": "media_next", "previous_track": "media_previous"}

NAMED = {"tab": "tab", "space": "space", "enter": "enter", "return": "enter", "esc": "esc", "escape": "esc",
         "left": "left", "right": "right", "up": "up", "down": "down", "backspace": "backspace",
         "delete": "delete", "del": "delete", "home": "home", "end": "end", "pageup": "page_up", "pagedown": "page_down",
         "print": "print_screen", "capslock": "caps_lock"}
NAMED.update({f"f{i}": f"f{i}" for i in range(1, 21)})


def parse_keys(spec: str, mac: bool = MAC):
    """'cmd+shift+4' -> (["cmd", "shift"], "4"). Returns key names as pynput Key
    attribute names or single characters. Raises ValueError for anything unknown."""
    parts = [p.strip().lower() for p in spec.replace(" ", "").split("+") if p.strip()]
    if not parts:
        raise ValueError("empty shortcut")
    mods, key = [], parts[-1]
    for p in parts[:-1]:
        if p in ("cmd", "command", "⌘"):
            mods.append("cmd" if mac else "ctrl")
        elif p in ("win", "super", "meta", "windows"):
            mods.append("cmd")
        elif p in ("ctrl", "control", "ctl"):
            mods.append("ctrl")
        elif p in ("alt", "option", "opt"):
            mods.append("alt")
        elif p == "shift":
            mods.append("shift")
        else:
            raise ValueError(f"unknown modifier '{p}'")
    if key in NAMED:
        key = NAMED[key]
    elif key in ("cmd", "win", "super"):
        key = "cmd"
    elif len(key) != 1:
        raise ValueError(f"unknown key '{key}'")
    return mods, key


def screen_size():
    """Main display size in the units the mouse uses (points on a Mac)."""
    try:
        if MAC:
            import Quartz  # comes with pynput on macOS
            b = Quartz.CGDisplayBounds(Quartz.CGMainDisplayID())
            return int(b.size.width), int(b.size.height)
        if WIN:
            import ctypes
            u = ctypes.windll.user32
            try:
                u.SetProcessDPIAware()
            except Exception:
                pass
            return u.GetSystemMetrics(0), u.GetSystemMetrics(1)
        from Xlib import display  # comes with pynput on Linux
        s = display.Display().screen()
        return s.width_in_pixels, s.height_in_pixels
    except Exception:
        return 1440, 900


def accessibility_ok(prompt: bool = False):
    """On a Mac, controlling the mouse needs Accessibility permission. None elsewhere."""
    if not MAC:
        return None
    try:
        from ApplicationServices import AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt
        return bool(AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: bool(prompt)}))
    except Exception:
        try:
            from ApplicationServices import AXIsProcessTrusted
            return bool(AXIsProcessTrusted())
        except Exception:
            return None


class Executor:
    """Runs engine commands. With dry_run it only records what it would have done."""

    def __init__(self, dry_run=False, size=None):
        self.dry_run = dry_run
        self.size = size or screen_size()
        self.log = deque(maxlen=200)
        self.errors = deque(maxlen=20)
        self._lock = threading.Lock()
        self._mouse = self._kb = None
        self._down = False

    def _ctl(self):
        if self._mouse is None:
            from pynput import keyboard, mouse
            self._pm, self._pk = mouse, keyboard
            self._mouse, self._kb = mouse.Controller(), keyboard.Controller()
        return self._mouse, self._kb

    def _px(self, x, y):
        w, h = self.size
        return int(round(x * (w - 1))), int(round(y * (h - 1)))

    def run(self, cmds):
        for c in cmds:
            try:
                self._one(c)
            except Exception as e:  # never let one bad command stop tracking
                self.errors.append(f"{c.get('do')}: {e}")

    def _record(self, text):
        self.log.append((time.time(), text))

    def _one(self, c):
        do = c["do"]
        if do == "move":
            x, y = self._px(c["x"], c["y"])
            if not self.dry_run:
                self._ctl()[0].position = (x, y)
            return  # moves are not logged, too many
        if do == "paused":
            if c["value"] and self._down:
                self._one({"do": "up"})
            self._record("Paused" if c["value"] else "Resumed")
            return
        if do == "down":
            self._record("Mouse down (drag)")
            if not self.dry_run:
                m, _ = self._ctl(); m.press(self._pm.Button.left)
            self._down = True
        elif do == "up":
            self._record("Mouse up (drop)")
            if not self.dry_run and self._down:
                m, _ = self._ctl(); m.release(self._pm.Button.left)
            self._down = False
        elif do == "click":
            b = c.get("button", "left")
            self._record(f"{b.title()} click")
            if not self.dry_run:
                m, _ = self._ctl()
                if "x" in c:
                    m.position = self._px(c["x"], c["y"])
                m.click(getattr(self._pm.Button, b), 1)
        elif do == "scroll":
            self._record(f"Scroll {c['dy']:+d}" if c["dy"] else f"Scroll sideways {c['dx']:+d}")
            if not self.dry_run:
                self._ctl()[0].scroll(c["dx"], c["dy"])
        elif do == "action":
            self._action(c["action"], c.get("keys", ""), c.get("text", ""))

    def _action(self, a, keys="", text=""):
        if a in ("left_click", "right_click", "middle_click", "double_click"):
            b = "left" if a == "double_click" else a.split("_")[0]
            self._record(a.replace("_", " ").capitalize())
            if not self.dry_run:
                m, _ = self._ctl(); m.click(getattr(self._pm.Button, b), 2 if a == "double_click" else 1)
        elif a in ("scroll_up", "scroll_down"):
            self._record(a.replace("_", " ").capitalize())
            if not self.dry_run:
                self._ctl()[0].scroll(0, 5 if a == "scroll_up" else -5)
        elif a in MEDIA:
            self._record(a.replace("_", " ").capitalize())
            if not self.dry_run:
                _, k = self._ctl(); key = getattr(self._pk.Key, MEDIA[a]); k.press(key); k.release(key)
        elif a == "type_text":
            self._record(f"Type: {text[:40]}")
            if not self.dry_run and text:
                self._ctl()[1].type(text)
        elif a == "hotkey" or a in PRESETS:
            spec = keys if a == "hotkey" else PRESETS[a]
            self._record(f"Keys {spec}")
            self.press(spec)
        elif a == "toggle_pause":
            pass  # handled by the engine
        else:
            raise ValueError(f"unknown action {a}")

    def press(self, spec):
        mods, key = parse_keys(spec)
        if self.dry_run:
            return
        _, k = self._ctl()
        K = self._pk.Key
        mk = [getattr(K, m) for m in mods]
        kk = getattr(K, key) if len(key) > 1 else key
        with self._lock:
            for m in mk:
                k.press(m)
            try:
                k.press(kk); time.sleep(0.02); k.release(kk)
            finally:
                for m in reversed(mk):
                    k.release(m)

    def release_all(self):
        if self._down and not self.dry_run:
            try:
                m, _ = self._ctl(); m.release(self._pm.Button.left)
            except Exception:
                pass
        self._down = False
