# Airpane - AR browser (MVP)

Open any website so it floats in front of you. No app, no glasses.

- **Phone (Camera room):** the back camera shows your room and the page is pinned in it; move the phone and it stays put.
- **Laptop (Hologram):** the webcam tracks your head (MediaPipe face detector) and the scene is drawn from your eye position, so the page hangs in 3D in front of the screen. Mouse fallback if the camera is off.

- **Throw to another screen (cast):** open `/catch` on a TV, laptop or tablet; it shows a code and a QR code. Scan it with the phone (or tap the Cast button and type the code). Then pinch the page, swing and let go (or press, hold and flick it, or tap "Send this page now"): it flies off the phone and lands on the screen at the same scroll position. The phone's hand or the bar above the dock then scrolls, clicks and goes back on the screen; "Bring back" pulls the page back. YouTube / Vimeo links play in the real player on the screen. The link is a direct WebRTC connection (PeerJS broker for discovery), so it works with any browser, iPhone and smart TVs included. Chrome / Edge on a computer can also cast to a Chromecast or second display through the Presentation API (no code needed).

- **Direct mode:** sites that allow embedding load in a real iframe placed in 3D space. Free.
- **Cloud mode:** sites that block embedding open in a cloud Chromium (Hyperbeam). Switches on when `HYPERBEAM_API_KEY` is set in Vercel.

## Run locally
```
npm install
npm run dev          # http://localhost:3000
npm test             # unit tests + Playwright E2E (fake camera with a moving face, phone-to-TV casting)
```

## Env vars (Vercel)
| Name | Purpose |
| --- | --- |
| `HYPERBEAM_API_KEY` | Enables Cloud mode |
| `SESSION_MAX_SECONDS` | Max cloud session length (default 600) |
