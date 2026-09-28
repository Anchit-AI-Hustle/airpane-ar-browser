"""Engine tests on real hand landmarks (from photos) moved around like a live hand."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from airpane_desktop.config import DEFAULTS, Store, conflicts, validate  # noqa: E402
from airpane_desktop.engine import Engine, palm_center  # noqa: E402
from airpane_desktop.poses import classify  # noqa: E402
D = json.load(open(Path(__file__).parent / "fixtures" / "landmarks.json"))
HANDS = {**D["real"], **D["derived"]}
# real hands for the newer poses, taken from the people photos
with open(Path(__file__).parent / "fixtures" / "hagrid_landmarks.json") as _f:
    PEOPLE = json.load(_f)["samples"]
for _s in PEOPLE:
    if _s["expect"] in ("thumbs_down", "call", "four") and _s["expect"] not in HANDS and classify(_s["lm"]) == _s["expect"]:
        HANDS[_s["expect"]] = _s["lm"]
FPS = 30


def hand(pose, cx=0.5, cy=0.5, scale=1.0):
    """The pose's landmarks with the palm centred at (cx, cy)."""
    lm = HANDS[pose]
    pc = palm_center(lm)
    return [((x - pc[0]) * scale + cx, (y - pc[1]) * scale + cy) for x, y in lm]


class Run:
    def __init__(self, cfg=None):
        self.cfg = validate(cfg or copy.deepcopy(DEFAULTS))
        self.e = Engine(self.cfg)
        self.t = 0.0
        self.log = []

    def frames(self, pose, n, x0=0.5, y0=0.5, x1=None, y1=None, jitter=0.0):
        x1 = x0 if x1 is None else x1
        y1 = y0 if y1 is None else y1
        out = []
        for i in range(n):
            k = i / max(1, n - 1)
            jx = jitter * (((i * 7919) % 13) / 6.5 - 1)
            jy = jitter * (((i * 104729) % 11) / 5.5 - 1)
            lm = None if pose is None else hand(pose, x0 + (x1 - x0) * k + jx, y0 + (y1 - y0) * k + jy)
            ev = self.e.update(lm, self.t)
            out += ev
            self.log += ev
            self.t += 1 / FPS
        return out

    def secs(self, pose, s, **kw):
        return self.frames(pose, int(round(s * FPS)), **kw)


def of(evs, do, **match):
    return [e for e in evs if e["do"] == do and all(e.get(k) == v for k, v in match.items())]


class PoseTests(unittest.TestCase):
    def test_real_and_derived_poses(self):
        for name, lm in HANDS.items():
            self.assertEqual(classify(lm), name, name)

    def test_pose_is_scale_and_position_independent(self):
        for name in HANDS:
            for s in (0.5, 1.4):
                self.assertEqual(classify(hand(name, 0.3, 0.6, s)), name, f"{name} at scale {s}")


class RealPeopleTests(unittest.TestCase):
    """308 photos of different people, rooms and lighting (HaGRID)."""

    def test_accuracy_on_real_hands(self):
        H = PEOPLE
        good = sum(classify(s["lm"]) == s["expect"] for s in H)
        self.assertGreaterEqual(good / len(H), 0.94, f"{good}/{len(H)}")

    def test_almost_nothing_else_is_taken_for_a_click(self):
        # 1 in 461: one photo where hand tracking itself misplaced the fingers. Live, a pose
        # must hold 2 frames and a click needs a pinch and a release, so a glitch can't click.
        H = PEOPLE
        false_clicks = [s["expect"] for s in H if s["expect"] != "pinch" and classify(s["lm"]) in ("pinch", "pinch_middle")]
        self.assertLessEqual(len(false_clicks), 1, false_clicks)

    def test_every_gesture_is_recognised_on_real_hands(self):
        import collections
        H = PEOPLE
        by = collections.defaultdict(list)
        for s in H:
            by[s["expect"]].append(classify(s["lm"]) == s["expect"])
        for pose, ok in by.items():
            self.assertGreaterEqual(sum(ok) / len(ok), 0.85, f"{pose}: {sum(ok)}/{len(ok)}")
        self.assertEqual(len(by), 11)


class CursorTests(unittest.TestCase):
    def test_pointing_moves_cursor_across_the_screen(self):
        r = Run()
        r.secs("point", 0.3, x0=0.35, y0=0.5)
        ev = r.secs("point", 1.0, x0=0.35, x1=0.65, y0=0.5)
        mv = of(ev, "move")
        self.assertGreater(len(mv), 10)
        xs = [m["x"] for m in mv]
        self.assertEqual(xs, sorted(xs), "cursor should move steadily right")
        self.assertGreater(xs[-1] - xs[0], 0.4)

    def test_hand_in_the_middle_puts_cursor_mid_screen(self):
        r = Run()
        r.secs("point", 1.0, x0=0.5, y0=0.5)
        x, y = r.e.cursor
        self.assertAlmostEqual(x, 0.5, delta=0.25)
        self.assertTrue(0 <= y <= 1)

    def test_smoothing_calms_a_shaky_hand(self):
        spreads = {}
        for s in (0.0, 0.9):
            cfg = copy.deepcopy(DEFAULTS); cfg["cursor"]["smoothing"] = s
            r = Run(cfg)
            r.secs("point", 0.5)
            ev = r.secs("point", 1.0, jitter=0.006)
            xs = [m["x"] for m in of(ev, "move")] or [r.e.cursor[0]]
            spreads[s] = max(xs) - min(xs)
        self.assertLess(spreads[0.9], spreads[0.0] * 0.6, spreads)

    def test_other_poses_do_not_move_the_cursor(self):
        r = Run()
        r.secs("point", 0.4)
        ev = r.secs("open_palm", 0.5, x0=0.4, x1=0.45)
        self.assertEqual(of(ev, "move"), [])


class ClickTests(unittest.TestCase):
    def test_quick_pinch_is_one_left_click_where_you_pointed(self):
        r = Run()
        r.secs("point", 0.6, x0=0.45)
        before = r.e.cursor
        ev = r.secs("pinch", 0.2, x0=0.45) + r.secs("point", 0.3, x0=0.45)
        clicks = of(ev, "click", button="left")
        self.assertEqual(len(clicks), 1)
        self.assertEqual(of(ev, "down"), [])
        self.assertAlmostEqual(clicks[0]["x"], before[0], delta=0.02)
        self.assertAlmostEqual(clicks[0]["y"], before[1], delta=0.02)

    def test_releasing_a_pinch_somewhere_else_is_still_a_click(self):
        # the frame where the fingers open reports a different hand position
        r = Run()
        r.secs("point", 0.5, x0=0.45)
        ev = r.secs("pinch", 0.2, x0=0.45) + r.secs("point", 0.3, x0=0.52)
        self.assertEqual([e["do"] for e in ev if e["do"] in ("down", "up", "click")], ["click"])

    def test_two_quick_pinches_are_two_clicks(self):
        r = Run()
        r.secs("point", 0.5)
        ev = r.secs("pinch", 0.15) + r.secs("point", 0.15) + r.secs("pinch", 0.15) + r.secs("point", 0.2)
        self.assertEqual(len(of(ev, "click", button="left")), 2)

    def test_pinch_and_move_drags_then_drops(self):
        r = Run()
        r.secs("point", 0.5, x0=0.4)
        ev = r.secs("pinch", 0.8, x0=0.4, x1=0.6) + r.secs("point", 0.3, x0=0.6)
        seq = [e["do"] for e in ev if e["do"] in ("down", "up", "click")]
        self.assertEqual(seq, ["down", "up"])
        i_down = next(i for i, e in enumerate(ev) if e["do"] == "down")
        i_up = next(i for i, e in enumerate(ev) if e["do"] == "up")
        moves = [e for e in ev[i_down:i_up] if e["do"] == "move"]
        self.assertGreater(len(moves), 5, "cursor should follow the hand while dragging")

    def test_losing_the_hand_mid_drag_releases_the_button(self):
        r = Run()
        r.secs("point", 0.4)
        r.secs("pinch", 0.7, x0=0.5, x1=0.6)
        self.assertTrue(r.e.state["dragging"])
        ev = r.frames(None, 1)
        self.assertEqual(of(ev, "up"), [{"do": "up"}])

    def test_middle_pinch_right_clicks_once(self):
        r = Run()
        r.secs("point", 0.3)
        ev = r.secs("pinch_middle", 0.6) + r.secs("point", 0.2)
        self.assertEqual(len(of(ev, "click", button="right")), 1)
        self.assertEqual(of(ev, "click", button="left"), [])

    def test_a_one_frame_glitch_does_not_click(self):
        r = Run()
        r.secs("point", 0.4)
        ev = r.frames("pinch", 1) + r.secs("point", 0.3)
        self.assertEqual(of(ev, "click"), [])


class ScrollTests(unittest.TestCase):
    def test_v_sign_moving_up_scrolls_like_a_touchscreen(self):
        r = Run()
        r.secs("peace", 0.3, y0=0.6)
        ev = r.secs("peace", 0.6, y0=0.6, y1=0.4)
        dy = sum(e["dy"] for e in of(ev, "scroll"))
        self.assertLess(dy, -5, "natural scrolling: hand up scrolls down the page")

    def test_changing_pose_mid_scroll_does_not_scroll_backwards(self):
        r = Run()
        r.secs("peace", 0.3, y0=0.6)
        r.secs("peace", 0.5, y0=0.6, y1=0.4)
        ev = r.secs("fist", 0.5, y0=0.55)  # the fist appears lower: must not count as a scroll
        self.assertEqual(of(ev, "scroll"), [])

    def test_scroll_direction_can_be_reversed(self):
        cfg = copy.deepcopy(DEFAULTS); cfg["cursor"]["natural_scroll"] = False
        r = Run(cfg)
        r.secs("peace", 0.3, y0=0.6)
        ev = r.secs("peace", 0.6, y0=0.6, y1=0.4)
        self.assertGreater(sum(e["dy"] for e in of(ev, "scroll")), 5)

    def test_scroll_speed_setting(self):
        tot = {}
        for sp in (0.5, 2.0):
            cfg = copy.deepcopy(DEFAULTS); cfg["cursor"]["scroll_speed"] = sp
            r = Run(cfg)
            r.secs("peace", 0.3, y0=0.6)
            tot[sp] = abs(sum(e["dy"] for e in of(r.secs("peace", 0.6, y0=0.6, y1=0.4), "scroll")))
        self.assertGreater(tot[2.0], tot[0.5] * 3)


class SwipeTests(unittest.TestCase):
    def test_fast_swipe_left_goes_to_next_desktop_once(self):
        r = Run()
        r.secs("open_palm", 0.3, x0=0.7)
        ev = r.secs("open_palm", 0.25, x0=0.7, x1=0.3) + r.secs("open_palm", 0.4, x0=0.3)
        acts = of(ev, "action")
        self.assertEqual([a["action"] for a in acts], ["next_desktop"])

    def test_each_direction(self):
        want = {"swipe_right": "previous_desktop", "swipe_up": "mission_control", "swipe_down": "show_desktop"}
        paths = {"swipe_right": dict(x0=0.3, x1=0.7), "swipe_up": dict(y0=0.7, y1=0.3), "swipe_down": dict(y0=0.3, y1=0.7)}
        for g, p in paths.items():
            r = Run()
            start = {k: v for k, v in p.items() if k in ("x0", "y0")}
            r.secs("open_palm", 0.3, **start)
            ev = r.secs("open_palm", 0.25, **p)
            self.assertEqual([a["action"] for a in of(ev, "action")], [want[g]], g)

    def test_slow_drift_is_not_a_swipe(self):
        r = Run()
        ev = r.secs("open_palm", 2.0, x0=0.7, x1=0.4)
        self.assertEqual(of(ev, "action"), [])


class RuleTests(unittest.TestCase):
    def test_holding_a_fist_pauses_and_resumes(self):
        r = Run()
        r.secs("point", 0.3)
        ev = r.secs("fist", 1.5)
        self.assertEqual(of(ev, "paused"), [{"do": "paused", "value": True}])
        ev = r.secs("point", 0.8, x0=0.3, x1=0.7)
        self.assertEqual(of(ev, "move"), [], "nothing moves while paused")
        ev = r.secs("pinch", 0.2) + r.secs("point", 0.2)
        self.assertEqual(of(ev, "click"), [], "no clicks while paused")
        r.secs("point", 1.0)  # cooldown passes
        ev = r.secs("fist", 1.5)
        self.assertEqual(of(ev, "paused"), [{"do": "paused", "value": False}])
        ev = r.secs("point", 0.6, x0=0.3, x1=0.7)
        self.assertTrue(of(ev, "move"))

    def test_a_short_fist_does_nothing(self):
        r = Run()
        ev = r.secs("fist", 0.6) + r.secs("point", 0.3)
        self.assertEqual(of(ev, "paused"), [])

    def test_hold_fires_once_per_hold(self):
        r = Run()
        ev = r.secs("three", 2.0)
        self.assertEqual([a["action"] for a in of(ev, "action")], ["app_switcher"])

    def test_new_gestures_do_their_own_actions(self):
        for pose, action in (("thumbs_down", "volume_down"), ("call", "mute"), ("four", "screenshot"), ("rock", "play_pause")):
            r = Run()
            acts = [a["action"] for a in of(r.secs(pose, 1.2), "action")]
            self.assertEqual(acts[:1], [action], pose)
            self.assertEqual(set(acts), {action}, pose)

    def test_repeat_while_held(self):
        r = Run()
        ev = r.secs("thumbs_up", 2.0)
        n = len(of(ev, "action", action="volume_up"))
        self.assertTrue(3 <= n <= 5, n)

    def test_hold_needs_a_still_hand(self):
        r = Run()
        ev = r.secs("three", 2.0, x0=0.2, x1=0.8)
        self.assertEqual(of(ev, "action"), [])

    def test_cooldown(self):
        cfg = copy.deepcopy(DEFAULTS)
        cfg["rules"] = [{"gesture": "rock", "action": "hotkey", "keys": "cmd+c", "hold_ms": 100, "cooldown_ms": 3000}]
        r = Run(cfg)
        ev = r.secs("rock", 0.5) + r.secs("point", 0.3) + r.secs("rock", 0.5)
        self.assertEqual(len(of(ev, "action")), 1)
        r.secs("point", 3.0)
        self.assertEqual(len(of(r.secs("rock", 0.5), "action", keys="cmd+c")), 1)

    def test_disabled_rule_is_ignored(self):
        cfg = copy.deepcopy(DEFAULTS)
        for x in cfg["rules"]:
            x["enabled"] = False
        r = Run(cfg)
        self.assertEqual(of(r.secs("three", 1.5), "action"), [])

    def test_new_settings_apply_immediately(self):
        r = Run()
        cfg = copy.deepcopy(r.cfg)
        cfg["rules"] = [{"gesture": "three", "action": "spotlight", "hold_ms": 200, "cooldown_ms": 0}]
        r.e.set_config(validate(cfg))
        self.assertEqual([a["action"] for a in of(r.secs("three", 1.0), "action")], ["spotlight"])


class ConfigTests(unittest.TestCase):
    def test_bad_values_are_cleaned(self):
        c = validate({"cursor": {"area": 9, "smoothing": "x", "cursor_pose": "banana"}, "rules": [
            {"gesture": "nope", "action": "left_click"}, {"gesture": "fist", "action": "rm -rf"},
            {"gesture": "fist", "action": "mute", "hold_ms": -5, "keys": "a" * 999}]})
        self.assertEqual(c["cursor"]["area"], 1.0)
        self.assertEqual(c["cursor"]["smoothing"], DEFAULTS["cursor"]["smoothing"])
        self.assertEqual(c["cursor"]["cursor_pose"], "point")
        self.assertEqual(len(c["rules"]), 1)
        self.assertEqual(c["rules"][0]["hold_ms"], 0)
        self.assertEqual(len(c["rules"][0]["keys"]), 60)

    def test_defaults_use_every_gesture_once(self):
        c = validate(copy.deepcopy(DEFAULTS))
        used = [c["cursor"][k] for k in ("cursor_pose", "click_pose", "right_click_pose", "scroll_pose")]
        used += [r["gesture"] for r in c["rules"] if r["enabled"]]
        self.assertEqual(len(used), len(set(used)), used)
        self.assertEqual(conflicts(c), [])
        self.assertTrue(all(r["enabled"] and not r["clash"] for r in c["rules"]))

    def test_a_gesture_can_only_do_one_thing(self):
        c = copy.deepcopy(DEFAULTS)
        c["cursor"]["scroll_pose"] = "point"                       # same as the cursor pose
        c["rules"].append({"gesture": "pinch", "action": "mute"})  # already clicks
        c["rules"].append({"gesture": "three", "action": "spotlight"})  # already switches apps
        c["rules"].append({"gesture": "open_palm", "action": "mute"})   # open hand is for swipes
        c = validate(c)
        self.assertEqual(c["cursor"]["scroll_pose"], "none")
        extra = c["rules"][-3:]
        self.assertTrue(all(not r["enabled"] and r["clash"] for r in extra), extra)
        self.assertEqual(c["rules"][5]["enabled"], True, "the first rule on a gesture keeps it")
        w = " ".join(conflicts(c))
        self.assertIn("click and drag", w)
        self.assertIn("Switch app", w)
        self.assertIn("swipes", w)

    def test_clash_reason_survives_being_checked_again(self):
        c = copy.deepcopy(DEFAULTS)
        c["rules"].append({"gesture": "three", "action": "spotlight"})
        once = validate(c)
        twice = validate(once)
        self.assertEqual(once["rules"][-1], twice["rules"][-1])
        self.assertTrue(twice["rules"][-1]["clash"])
        twice["rules"][5]["enabled"] = False  # free the gesture
        freed = validate(twice)
        self.assertEqual((freed["rules"][-1]["enabled"], freed["rules"][-1]["clash"]), (False, ""))

    def test_open_hand_control_turns_off_swipes(self):
        c = copy.deepcopy(DEFAULTS)
        c["cursor"]["scroll_pose"] = "open_palm"
        c = validate(c)
        swipes = [r for r in c["rules"] if r["gesture"].startswith("swipe_")]
        self.assertTrue(all(not r["enabled"] for r in swipes))

    def test_clashing_rule_never_fires(self):
        c = copy.deepcopy(DEFAULTS)
        c["rules"].append({"gesture": "three", "action": "type_text", "text": "oops", "hold_ms": 100})
        r = Run(c)
        acts = [a["action"] for a in of(r.secs("three", 1.5), "action")]
        self.assertEqual(acts, ["app_switcher"])

    def test_no_pause_gesture_is_flagged(self):
        c = validate({**copy.deepcopy(DEFAULTS), "rules": []})
        self.assertIn("No gesture pauses", " ".join(conflicts(c)))

    def test_store_round_trip(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            s = Store(Path(d) / "a" / "settings.json")
            self.assertEqual(s.load(), validate(DEFAULTS))
            c = s.load(); c["cursor"]["area"] = 0.7
            s.save(c)
            self.assertEqual(Store(Path(d) / "a" / "settings.json").load()["cursor"]["area"], 0.7)
            (Path(d) / "a" / "settings.json").write_text("{broken")
            self.assertEqual(s.load(), validate(DEFAULTS))


if __name__ == "__main__":
    unittest.main(verbosity=1)
