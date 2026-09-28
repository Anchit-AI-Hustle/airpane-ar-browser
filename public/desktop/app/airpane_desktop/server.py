"""Local settings page and API, only reachable from this computer (127.0.0.1)."""
from __future__ import annotations

import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import ACTIONS, DEFAULTS, GESTURES, MODES, POSES, validate

UI = Path(__file__).parent / "ui"


def serve(app, port):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Airpane"

        def log_message(self, *a):
            pass

        def _host_ok(self):
            # Blocks DNS-rebinding: only the loopback names we listen on are accepted.
            host = (self.headers.get("Host") or "").lower()
            p = self.server.server_address[1]
            return host in (f"127.0.0.1:{p}", f"localhost:{p}")

        def _json(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._host_ok():
                return self._json(403, {"error": "forbidden"})
            path = self.path.split("?")[0]
            if path == "/api/state":
                return self._json(200, app.snapshot())
            if path == "/api/config":
                return self._json(200, {"config": app.cfg, "defaults": DEFAULTS, "gestures": GESTURES, "poses": POSES,
                                        "actions": ACTIONS, "modes": MODES, "platform": app.status["platform"]})
            if path == "/preview.mjpg":
                return self._mjpeg()
            if path == "/":
                path = "/index.html"
            f = (UI / path.lstrip("/")).resolve()
            if UI.resolve() not in f.parents or not f.is_file():
                return self._json(404, {"error": "not found"})
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            # A custom header plus JSON means other websites cannot post here (no CORS allowed).
            if not self._host_ok() or self.headers.get("X-Airpane") != "1" or "json" not in (self.headers.get("Content-Type") or ""):
                return self._json(403, {"error": "forbidden"})
            try:
                n = min(int(self.headers.get("Content-Length") or 0), 200_000)
                data = json.loads(self.rfile.read(n) or b"{}")
            except (ValueError, OSError):
                return self._json(400, {"error": "bad json"})
            path = self.path.split("?")[0]
            if path == "/api/config":
                if isinstance(data, dict):
                    data["paused"] = app.engine.paused  # pausing has its own button and gesture
                cfg = app.apply(validate(data))
                return self._json(200, {"config": cfg, "state": app.snapshot()})
            if path == "/api/reset":
                cfg = app.apply(validate(dict(DEFAULTS, paused=app.engine.paused, dry_run=app.cfg["dry_run"])))
                return self._json(200, {"config": cfg})
            if path == "/api/pause":
                app.set_paused(bool(data.get("paused")))
                return self._json(200, app.snapshot())
            if path == "/api/quit":
                self._json(200, {"ok": True})
                threading.Timer(0.2, app.stop).start()
                return
            return self._json(404, {"error": "not found"})

        def _mjpeg(self):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            app.viewers += 1
            try:
                last = None
                while app.running:
                    with app.jpeg_cond:
                        app.jpeg_cond.wait(timeout=1.0)
                        jpg = app.jpeg
                    if jpg is None or jpg is last:
                        continue
                    last = jpg
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                app.viewers -= 1

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd
