# Airpane - AR browser (MVP)

Open any website so it floats in front of you. No app, no glasses.

- **Phone (Camera room):** the back camera shows your room and the page is pinned in it; move the phone and it stays put.
- **Laptop (Hologram):** the webcam tracks your head (MediaPipe face detector) and the scene is drawn from your eye position, so the page hangs in 3D in front of the screen. Mouse fallback if the camera is off.

- **Direct mode:** sites that allow embedding load in a real iframe placed in 3D space. Free.
- **Cloud mode:** sites that block embedding open in a cloud Chromium (Hyperbeam). Switches on when `HYPERBEAM_API_KEY` is set in Vercel.

## Run locally
```
npm install
npm run dev          # http://localhost:3000
npm test             # math + API tests + Playwright E2E (fake camera with a moving face)
```

## Env vars (Vercel)
| Name | Purpose |
| --- | --- |
| `HYPERBEAM_API_KEY` | Enables Cloud mode |
| `SESSION_MAX_SECONDS` | Max cloud session length (default 600) |
