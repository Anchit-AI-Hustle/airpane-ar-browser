// Local server that mimics Vercel: static files from public/, /api/* from api/*.js
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const port = +process.env.PORT || 3000;
http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p.startsWith("/api/")) {
    const f = path.join(root, "api", p.slice(5).replace(/[^\w-]/g, "") + ".js");
    if (!fs.existsSync(f) || path.basename(f).startsWith("_")) { res.statusCode = 404; return res.end("Not found"); }
    try { return await require(f)(req, res); } catch (e) { res.statusCode = 500; return res.end(String(e)); }
  }
  let file = path.join(root, "public", p === "/" ? "index.html" : p);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html"); // like Vercel: /control -> /control/index.html
  if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log("dev server on http://localhost:" + port));
