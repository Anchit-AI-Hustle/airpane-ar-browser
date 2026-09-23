# Airpane - AR browser (MVP)

Open any website so it floats in front of you through the phone camera. No app, no headset.

- **Direct mode:** sites that allow embedding load in a real iframe placed in 3D space. Free.
- **Cloud mode:** sites that block embedding open in a cloud Chromium (Hyperbeam). Switches on when `HYPERBEAM_API_KEY` is set in Vercel.

## Run locally
```
npm install
npm run dev          # http://localhost:3000
npm test             # API tests + Playwright E2E (fake camera)
```

## Env vars (Vercel)
| Name | Purpose |
| --- | --- |
| `HYPERBEAM_API_KEY` | Enables Cloud mode |
| `SESSION_MAX_SECONDS` | Max cloud session length (default 600) |
