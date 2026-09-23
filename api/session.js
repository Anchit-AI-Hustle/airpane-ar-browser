// GET  /api/session           -> { enabled }  (is Cloud mode configured?)
// POST /api/session {url,w,h} -> { embed_url, admin_token, session_id }
// Starts a short-lived cloud Chromium (Hyperbeam) for sites that block framing.
const { send, readJson, assertPublicUrl, isBlockedForCloud } = require("./_lib");

const ENGINE = "https://engine.hyperbeam.com/v0/vm";
const clamp = (n, lo, hi, d) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, Math.round(+n))) : d);

module.exports = async (req, res) => {
  const key = process.env.HYPERBEAM_API_KEY;
  if (req.method === "GET") return send(res, 200, { enabled: Boolean(key) });
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  if (!key) return send(res, 503, { error: "Cloud mode is not configured" });

  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: "Bad JSON" }); }

  let url;
  try { url = (await assertPublicUrl(String(body.url || ""))).href; }
  catch (e) { return send(res, 400, { error: e.message }); }
  if (isBlockedForCloud(url)) {
    return send(res, 403, { error: "Banking and payment sites are blocked in Cloud mode for your safety" });
  }

  const payload = {
    start_url: url,
    kiosk: true,
    width: clamp(body.w, 360, 1920, 1280),
    height: clamp(body.h, 360, 1080, 800),
    touch_gestures: { swipe: true, pinch: true },
    timeout: {
      absolute: clamp(process.env.SESSION_MAX_SECONDS, 60, 3600, 600),
      inactive: 120,
      offline: 30,
    },
  };

  try {
    const r = await fetch(ENGINE, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: data.message || `Cloud engine error ${r.status}` });
    return send(res, 200, {
      embed_url: data.embed_url,
      admin_token: data.admin_token,
      session_id: data.session_id,
      max_seconds: payload.timeout.absolute,
    });
  } catch {
    return send(res, 504, { error: "Cloud engine timed out" });
  }
};
