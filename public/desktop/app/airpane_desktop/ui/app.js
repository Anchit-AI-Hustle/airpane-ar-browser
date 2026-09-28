// Airpane Desktop settings page. Talks only to the Airpane app on this computer.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let meta = null, cfg = null, saveT = null, lastLogT = 0;

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Airpane": "1" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

const MODE_ROWS = [
  ["cursor_pose", "Move the cursor", "Hold this pose and move your hand"],
  ["click_pose", "Click and drag", "Quick = click, hold or move = drag"],
  ["right_click_pose", "Right click", "Make the pose once"],
  ["scroll_pose", "Scroll", "Hold the pose and move up or down"],
];
const TUNE = { area: (v) => Math.round(v * 100) + "% of view", smoothing: (v) => Math.round(v * 100) + "%", click_ms: (v) => v + " ms", scroll_speed: (v) => (+v).toFixed(1) + "x", center_x: (v) => Math.round(v * 100) + "%", center_y: (v) => Math.round(v * 100) + "%" };

// One gesture, one job: what each gesture is already used for, ignoring one item.
const SWIPES = ["swipe_left", "swipe_right", "swipe_up", "swipe_down"];
const MODE_NAMES = { cursor_pose: "moving the cursor", click_pose: "click and drag", right_click_pose: "right click", scroll_pose: "scrolling" };
function taken({ skipMode = null, skipRule = -1 } = {}) {
  const t = {};
  for (const k of Object.keys(MODE_NAMES)) if (k !== skipMode && cfg.cursor[k] !== "none") t[cfg.cursor[k]] = MODE_NAMES[k];
  cfg.rules.forEach((r, i) => {
    if (i === skipRule || !r.enabled || r.clash) return;
    t[r.gesture] = t[r.gesture] || meta.actions[r.action];
    if (SWIPES.includes(r.gesture)) t.open_palm = t.open_palm || "swipes";
  });
  return t;
}
function blocked(g, t) {
  if (t[g]) return t[g];
  if (SWIPES.includes(g) && t.open_palm && t.open_palm !== "swipes") return t.open_palm + " (open hand)";
  if (g === "open_palm" && SWIPES.some((s) => t[s])) return "swipes";
  return "";
}
function opt(k, label, sel, why) {
  return `<option value="${k}"${k === sel ? " selected" : ""}${why && k !== sel ? " disabled" : ""}>${esc(label)}${why && k !== sel ? " - used for " + esc(why) : ""}</option>`;
}
function poseOptions(sel, withNone, t) {
  const o = Object.entries(meta.poses).map(([k, v]) => opt(k, v, sel, blocked(k, t)));
  if (withNone) o.push(`<option value="none"${sel === "none" ? " selected" : ""}>Off</option>`);
  return o.join("");
}
function gestureOptions(sel, t) {
  return Object.entries(meta.gestures).map(([k, v]) => opt(k, v, sel, blocked(k, t))).join("");
}
function actionOptions(sel) {
  return Object.entries(meta.actions).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(v)}</option>`).join("");
}
function freeGesture() {
  const t = taken();
  return Object.keys(meta.gestures).find((g) => !blocked(g, t));
}
function renderAll() { renderModes(); renderRules(); }

function renderModes() {
  $("modes").innerHTML = MODE_ROWS.map(([k, title, sub]) => `
    <div class="mode" data-mode="${k}">
      <div class="what"><b>${title}</b><span>${sub}</span></div>
      <select aria-label="${title} pose" data-k="${k}">${poseOptions(cfg.cursor[k], k !== "cursor_pose", taken({ skipMode: k }))}</select>
    </div>`).join("");
  for (const s of $("modes").querySelectorAll("select")) s.onchange = () => { cfg.cursor[s.dataset.k] = s.value; renderAll(); save(); };
}

function renderRules() {
  $("rules").innerHTML = cfg.rules.map((r, i) => `
    <div class="rule${r.enabled ? "" : " off"}${r.clash ? " clash" : ""}" data-i="${i}" data-g="${r.gesture}">
      <label class="switch" title="On or off"><input type="checkbox" data-f="enabled" ${r.enabled ? "checked" : ""} aria-label="Rule ${i + 1} on"><span class="track"></span></label>
      <select data-f="gesture" aria-label="Gesture">${gestureOptions(r.gesture, taken({ skipRule: i }))}</select>
      <span class="arrow" aria-hidden="true">then</span>
      <select class="act" data-f="action" aria-label="Action">${actionOptions(r.action)}</select>
      <button class="btn ghost icon" data-del="${i}" type="button" aria-label="Delete rule ${i + 1}" title="Delete">&times;</button>
      <div class="param" ${r.action === "hotkey" ? "" : "hidden"}><input type="text" data-f="keys" value="${esc(r.keys)}" placeholder="Shortcut, e.g. cmd+shift+4 or ctrl+c" aria-label="Keyboard shortcut"></div>
      <div class="param" ${r.action === "type_text" ? "" : "hidden"}><input type="text" data-f="text" value="${esc(r.text)}" placeholder="Text to type" aria-label="Text to type"></div>
      ${r.clash ? `<p class="clash-note">${esc(r.clash)} Pick another gesture to switch it on.</p>` : ""}
      <div class="extra">
        ${r.gesture.startsWith("swipe_") ? "<label>Hold<span class=\"muted\">not used</span></label><label>Repeat<span class=\"muted\">not used</span></label>" : `
        <label>Hold (ms)<input type="number" min="0" max="10000" step="100" data-f="hold_ms" value="${r.hold_ms}"></label>
        <label>Repeat (ms, 0 = off)<input type="number" min="0" max="10000" step="100" data-f="repeat_ms" value="${r.repeat_ms}"></label>`}
        <label>Cooldown (ms)<input type="number" min="0" max="60000" step="100" data-f="cooldown_ms" value="${r.cooldown_ms}"></label>
      </div>
    </div>`).join("") || `<p class="muted">No rules yet. Add one to link a gesture to an action.</p>`;
  for (const el of $("rules").querySelectorAll("[data-f]")) {
    el.onchange = () => {
      const i = +el.closest(".rule").dataset.i, f = el.dataset.f, r = cfg.rules[i];
      r[f] = el.type === "checkbox" ? el.checked : el.type === "number" ? Math.max(0, +el.value || 0) : el.value;
      if (f === "gesture" && r.clash) { r.clash = ""; r.enabled = true; }  // moved to a free gesture: switch it back on
      if (f === "enabled" && r.enabled && blocked(r.gesture, taken({ skipRule: i }))) {
        r.enabled = false; el.checked = false;
        $("saved").textContent = "That gesture is already used. Pick another gesture first.";
        return;
      }
      if (f === "action" || f === "gesture" || f === "enabled") renderAll();
      save();
    };
  }
  for (const b of $("rules").querySelectorAll("[data-del]")) b.onclick = () => { cfg.rules.splice(+b.dataset.del, 1); renderAll(); save(); };
}

function renderTune() {
  for (const k of Object.keys(TUNE)) { $(k).value = cfg.cursor[k]; $(k + "-v").textContent = TUNE[k](cfg.cursor[k]); }
  $("anchor").value = cfg.cursor.anchor;
  $("natural_scroll").checked = cfg.cursor.natural_scroll;
  $("mirror").checked = cfg.mirror;
  $("camera").value = String(cfg.camera);
  $("dry").checked = cfg.dry_run;
}
function wireTune() {
  for (const k of Object.keys(TUNE)) $(k).oninput = () => { cfg.cursor[k] = +$(k).value; $(k + "-v").textContent = TUNE[k](cfg.cursor[k]); save(); };
  $("anchor").onchange = () => { cfg.cursor.anchor = $("anchor").value; save(); };
  $("natural_scroll").onchange = () => { cfg.cursor.natural_scroll = $("natural_scroll").checked; save(); };
  $("mirror").onchange = () => { cfg.mirror = $("mirror").checked; save(); };
  $("camera").onchange = () => { cfg.camera = +$("camera").value; save(); };
  $("dry").onchange = () => { cfg.dry_run = $("dry").checked; save(0); };
}

function save(delay = 350) {
  clearTimeout(saveT);
  $("saved").textContent = "Saving";
  saveT = setTimeout(async () => {
    try {
      const r = await api("/api/config", cfg);
      const before = JSON.stringify(cfg.rules.map((x) => [x.enabled, x.clash])) + JSON.stringify(cfg.cursor);
      cfg = r.config;
      if (before !== JSON.stringify(cfg.rules.map((x) => [x.enabled, x.clash])) + JSON.stringify(cfg.cursor) && !document.activeElement?.closest?.(".rule, .mode")) renderAll();
      $("saved").textContent = "Saved";
      showState(r.state);
    } catch { $("saved").textContent = "Could not save. Is Airpane still running?"; }
  }, delay);
}

function showState(s) {
  cfg.paused = s.paused;
  const st = $("status"), txt = $("status-text");
  const bad = s.tracker === "failed" || s.camera === "failed";
  st.className = "status " + (bad ? "bad" : s.paused ? "paused" : s.dry_run ? "test" : "live");
  txt.textContent = bad ? "Not running" : s.paused ? "Paused" : s.dry_run ? "Test mode: watching only" : s.hand ? "Controlling your computer" : "Ready: show your hand";
  const p = $("pause");
  p.textContent = s.paused ? "Resume" : "Pause";
  p.classList.toggle("resume", s.paused);
  $("pose").textContent = s.hand ? (meta.poses[s.pose] || "Hand seen") : "No hand";
  $("fps").textContent = s.fps ? `${s.fps} fps` : "";
  $("cam-empty").hidden = s.camera === "on" && s.frames > 0;
  if (!$("cam-empty").hidden) $("cam-empty").textContent = s.camera === "failed" || s.tracker === "failed" ? "Camera unavailable" : "Starting the camera";
  // banner: things the user must fix
  const msgs = [];
  if (s.error) msgs.push(esc(s.error));
  if (s.accessibility === false && !s.dry_run) msgs.push("<b>One more step:</b> Airpane can see your hand but macOS is blocking mouse control. Open <b>System Settings &gt; Privacy &amp; Security &gt; Accessibility</b>, turn on <b>Terminal</b> (or the app you started Airpane from), then quit and start Airpane again.");
  for (const e of s.errors || []) msgs.push("Last problem: " + esc(e));
  $("banner").innerHTML = msgs.join("<br>");
  $("banner").hidden = msgs.length === 0;
  // highlight what the hand is doing right now
  for (const m of document.querySelectorAll(".mode")) m.classList.toggle("active", s.hand && cfg.cursor[m.dataset.mode] === s.pose);
  for (const r of document.querySelectorAll(".rule")) r.classList.toggle("active", s.hand && r.dataset.g === s.pose);
  $("warnings").innerHTML = (s.warnings || []).map((w) => `<li>${esc(w)}</li>`).join("");
  if (s.log && s.log.length) {
    const newest = s.log[s.log.length - 1].t;
    if (newest !== lastLogT) {
      $("log").innerHTML = s.log.slice().reverse().map((e, i) => `<li class="${e.t > lastLogT && lastLogT ? "new" : ""}"><span>${esc(e.text)}</span><time>${new Date(e.t * 1000).toLocaleTimeString()}</time></li>`).join("");
      lastLogT = newest;
    }
  }
}

async function poll() {
  try { showState(await api("/api/state")); }
  catch { $("status").className = "status bad"; $("status-text").textContent = "Airpane is not running"; }
  setTimeout(poll, 250);
}

async function init() {
  const r = await api("/api/config");
  meta = r; cfg = r.config;
  renderModes(); renderRules(); renderTune(); wireTune();
  $("add").onclick = () => {
    const g = freeGesture();
    if (!g) { $("saved").textContent = "Every gesture already has a job. Delete or change a rule to free one."; return; }
    cfg.rules.push({ gesture: g, action: "hotkey", keys: "", text: "", hold_ms: 500, repeat_ms: 0, cooldown_ms: 1000, enabled: true, clash: "" });
    renderAll(); save();
  };
  $("pause").onclick = async () => showState(await api("/api/pause", { paused: $("pause").textContent === "Pause" }));
  $("reset").onclick = async () => { if (!confirm("Reset all gestures, rules and tuning to the defaults?")) return; cfg = (await api("/api/reset", {})).config; renderAll(); renderTune(); $("saved").textContent = "Defaults restored"; };
  $("quit").onclick = async () => { await api("/api/quit", {}); $("status-text").textContent = "Airpane has stopped"; };
  $("preview").src = "/preview.mjpg";
  poll();
}
init();
