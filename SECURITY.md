# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately through
GitHub: **Security → Report a vulnerability** on this repository
(<https://github.com/Anchit-AI-Hustle/airpane-ar-browser/security/advisories/new>).

Include what you found, how to reproduce it, and what someone could do with it. You'll get a
reply within a few days. Please give a reasonable time to fix it before sharing details.

## What's in scope

- The website, <https://airpane.anchit-tandon.com>, and its `/api/*` functions
- The screen page (`/catch`) and the link between devices
- The Airpane Desktop installer and app in `desktop/`

Not in scope: rate limits of third-party services (PeerJS, MediaPipe, YouTube), and denial of
service by sending lots of traffic.

## How Airpane handles your data

- Camera frames are processed on your own device by MediaPipe and are never uploaded.
- Pages you open are fetched through Airpane's own functions only to show them; nothing is stored.
  If Cloud mode is switched on, sites that refuse to be shown inside other apps open in a
  Hyperbeam cloud browser instead, so that browsing goes through Hyperbeam.
- Devices talk to each other directly (WebRTC). The public PeerJS server only introduces them.
