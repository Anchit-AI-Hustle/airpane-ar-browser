"""Settings page, tested in a real browser against the running app (test mode, hand video).

  python tests/test_ui.py MODEL.task HANDS_VIDEO.mp4
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
model, video = sys.argv[1], sys.argv[2]
home = Path(tempfile.mkdtemp())
PORT = 47297
URL = f"http://127.0.0.1:{PORT}/"
fails = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        fails.append(name)


def saved():
    return json.loads((home / "settings.json").read_text())


app = subprocess.Popen([sys.executable, "-m", "airpane_desktop", "--video", video, "--realtime", "--loop", "--dry-run",
                        "--no-browser", "--no-hotkeys", "--model", model, "--port", str(PORT)],
                       cwd=ROOT, env=dict(os.environ, AIRPANE_HOME=str(home)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    for _ in range(60):
        try:
            urllib.request.urlopen(URL + "api/state", timeout=1); break
        except Exception:
            time.sleep(0.5)

    # --- the API refuses anything that is not our own page ---
    req = urllib.request.Request(URL + "api/config", data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req); code = 200
    except urllib.error.HTTPError as e:
        code = e.code
    check("API refuses a post without the Airpane header (other websites)", code == 403, code)
    req = urllib.request.Request(URL + "api/state", headers={"Host": "evil.example:47297"})
    try:
        urllib.request.urlopen(req); code = 200
    except urllib.error.HTTPError as e:
        code = e.code
    check("API refuses a foreign Host name (DNS rebinding)", code == 403, code)

    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1360, "height": 900})
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("dialog", lambda d: d.accept())
        pg.goto(URL)
        pg.wait_for_function("document.getElementById('status-text').textContent.includes('Test mode')", timeout=20000)
        check("status shows test mode", "Test mode" in pg.text_content("#status-text"))
        pg.wait_for_function("document.getElementById('preview').naturalWidth > 0", timeout=20000)
        check("live camera view with tracking is streaming", pg.evaluate("document.getElementById('preview').naturalWidth") == 640)
        pg.wait_for_function("!['No hand',''].includes(document.getElementById('pose').textContent)", timeout=20000)
        check("current pose is shown", pg.text_content("#pose") not in ("No hand", ""))
        pg.wait_for_function("document.querySelectorAll('#log li:not(.muted)').length > 0", timeout=30000)
        log = pg.text_content("#log")
        check("'Just now' lists what gestures did", any(w in log for w in ("click", "Keys", "Scroll", "Paused")), log[:120])
        check("four hand controls listed", pg.locator(".mode").count() == 4)
        check("default rules listed", pg.locator(".rule").count() == 11)

        # one gesture, one job
        opt = pg.locator('.mode[data-mode="scroll_pose"] select option[value="three"]')
        check("a pose used by a rule is greyed out for the hand controls", opt.is_disabled() and "Switch app" in opt.text_content(), opt.text_content())
        opt = pg.locator('.rule[data-g="rock"] select[data-f="gesture"] option[value="point"]')
        check("a pose used for the cursor is greyed out for rules", opt.is_disabled() and "moving the cursor" in opt.text_content())
        opt = pg.locator('.rule[data-g="rock"] select[data-f="gesture"] option[value="open_palm"]')
        check("the open hand is reserved for swipes", opt.is_disabled() and "swipes" in opt.text_content())
        pg.click("#add")
        check("with every gesture in use, Add rule explains instead of duplicating", pg.locator(".rule").count() == 11 and "Every gesture" in pg.text_content("#saved"))

        # free a gesture, then add a rule: it takes the free one
        pg.locator('.rule[data-g="call"] [data-del]').click()
        pg.wait_for_timeout(700)
        pg.click("#add")
        last = pg.locator(".rule").last
        check("new rule gets the free gesture", last.get_attribute("data-g") == "call", last.get_attribute("data-g"))
        last.locator('select[data-f="action"]').select_option("hotkey")
        last = pg.locator(".rule").last
        check("shortcut box appears for keyboard shortcuts", last.locator('input[data-f="keys"]').is_visible())
        last.locator('input[data-f="keys"]').fill("cmd+shift+5")
        last.locator('input[data-f="keys"]').press("Tab")
        last.locator('input[data-f="hold_ms"]').fill("800")
        last.locator('input[data-f="hold_ms"]').press("Tab")
        pg.wait_for_timeout(800)
        r = saved()["rules"][-1]
        check("new rule saved", (r["gesture"], r["action"], r["keys"], r["hold_ms"]) == ("call", "hotkey", "cmd+shift+5", 800), r)
        pg.locator(".rule").last.locator(".switch").click()
        pg.wait_for_timeout(700)
        check("rule can be switched off", saved()["rules"][-1]["enabled"] is False)
        pg.locator(".rule").last.locator("[data-del]").click()
        pg.wait_for_timeout(700)
        check("rule can be deleted", len(saved()["rules"]) == 10)

        # a duplicate that arrives anyway (edited file, old version) is switched off and explained
        cfg = json.loads(urllib.request.urlopen(URL + "api/config").read())["config"]
        cfg["rules"].append({"gesture": "three", "action": "spotlight", "enabled": True})
        req = urllib.request.Request(URL + "api/config", data=json.dumps(cfg).encode(), headers={"Content-Type": "application/json", "X-Airpane": "1"}, method="POST")
        out = json.loads(urllib.request.urlopen(req).read())["config"]["rules"][-1]
        check("server refuses a second job for a gesture", out["enabled"] is False and "Switch app" in out["clash"], out)
        pg.reload()
        pg.wait_for_selector(".rule.clash")
        check("clashing rule shows why it is off", "already used" in pg.text_content(".rule.clash .clash-note"))
        check("and is listed under the rules", "is off" in pg.text_content("#warnings"))
        pg.locator(".rule.clash .switch").click()
        pg.wait_for_timeout(500)
        check("it cannot be switched on while the gesture is taken", saved()["rules"][-1]["enabled"] is False and "already used" in pg.text_content("#saved"))
        pg.locator(".rule.clash select[data-f='gesture']").select_option("call")
        pg.wait_for_timeout(800)
        r = saved()["rules"][-1]
        check("moving it to a free gesture switches it on", (r["gesture"], r["enabled"], r["clash"]) == ("call", True, ""), r)

        # tuning
        pg.eval_on_selector("#area", "e => { e.value = 0.7; e.dispatchEvent(new Event('input')); }")
        pg.wait_for_timeout(700)
        check("hand travel slider saves", abs(saved()["cursor"]["area"] - 0.7) < 1e-6)
        check("slider shows its value", pg.text_content("#area-v") == "70% of view")

        # pause / resume (the test video holds a fist, which also pauses: switch that rule off first)
        pg.locator('.rule[data-g="fist"] .switch').click()
        pg.wait_for_timeout(700)
        if pg.text_content("#pause") == "Resume":
            pg.click("#pause"); pg.wait_for_timeout(500)
        pg.click("#pause")
        pg.wait_for_function("document.getElementById('status-text').textContent === 'Paused'", timeout=5000)
        check("Pause button pauses", pg.text_content("#pause") == "Resume")
        pg.eval_on_selector("#smoothing", "e => { e.value = 0.3; e.dispatchEvent(new Event('input')); }")
        pg.wait_for_timeout(900)
        check("changing a setting does not undo the pause", pg.text_content("#status-text") == "Paused")
        pg.click("#pause")
        pg.wait_for_function("document.getElementById('status-text').textContent !== 'Paused'", timeout=5000)
        check("Resume works", pg.text_content("#pause") == "Pause")

        pg.screenshot(path=str(ROOT / "tests" / "ui-desktop.png"), full_page=True)
        # reset
        pg.click("#reset")
        pg.wait_for_timeout(800)
        check("reset restores defaults", saved()["cursor"]["area"] == 0.5 and len(saved()["rules"]) == 11 and saved()["rules"][-2]["gesture"] == "call")

        # phone-sized window: nothing spills sideways
        m = b.new_page(viewport={"width": 390, "height": 844})
        m.goto(URL)
        m.wait_for_selector(".rule")
        over = m.evaluate("document.documentElement.scrollWidth - innerWidth")
        check("fits a narrow window", over <= 0, over)
        m.screenshot(path=str(ROOT / "tests" / "ui-narrow.png"), full_page=True)
        check("no page errors", [e for e in errors if "fonts" not in e] == [], errors)
        b.close()
finally:
    app.terminate()
    app.wait(10)
print(f"\n{'ALL PASSED' if not fails else str(len(fails)) + ' FAILED'}")
sys.exit(1 if fails else 0)
