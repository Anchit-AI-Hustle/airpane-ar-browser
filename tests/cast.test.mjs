// Throw to another screen: the messages between the phone and the screen, checked the way
// the screen checks them (anyone with the code can send, so nothing is trusted).
import assert from "node:assert/strict";
import { cleanMsg, videoEmbed, deviceName, httpUrl } from "../public/cast.js";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok  ", name); };

ok("a cast message keeps the page, its place and the swing", () => {
  assert.deepEqual(cleanMsg({ t: "cast", url: "https://en.m.wikipedia.org/wiki/Cat", pos: 0.25, title: "Cat", from: "iPhone", vx: 1.5, vy: -3 }),
    { t: "cast", url: "https://en.m.wikipedia.org/wiki/Cat", pos: 0.25, title: "Cat", from: "iPhone", vx: 1.5, vy: -3 });
});
ok("only http and https pages can be cast", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "chrome://settings", "", 42, null]) assert.equal(cleanMsg({ t: "cast", url }), null, String(url));
  assert.equal(cleanMsg({ t: "cast", url: "https://x.com/" + "a".repeat(3000) }), null, "very long address");
});
ok("numbers are clamped and bad numbers fall back", () => {
  const m = cleanMsg({ t: "cast", url: "https://example.com", pos: 7, vx: 1e9, vy: "nope", title: "x".repeat(500) });
  assert.equal(m.pos, 1); assert.equal(m.vx, 9); assert.equal(m.vy, -1); assert.equal(m.title.length, 200);
  assert.deepEqual(cleanMsg({ t: "scroll", dy: -50 }), { t: "scroll", dy: -2 });
  assert.deepEqual(cleanMsg({ t: "click", x: NaN, y: 2 }), { t: "click", x: 0.5, y: 1 });
});
ok("unknown or malformed messages are dropped", () => {
  for (const m of [null, "cast", 5, {}, { t: 3 }, { t: "eval", code: "x" }, { t: "__proto__" }]) assert.equal(cleanMsg(m), null, JSON.stringify(m));
});
ok("remote-control messages carry nothing extra", () => {
  assert.deepEqual(cleanMsg({ t: "back", url: "https://evil" }), { t: "back" });
  assert.deepEqual(cleanMsg({ t: "recall", extra: 1 }), { t: "recall" });
  assert.deepEqual(cleanMsg({ t: "page", url: "https://example.com/a", pos: 0.5 }), { t: "page", url: "https://example.com/a", pos: 0.5 });
  assert.equal(cleanMsg({ t: "page", url: "javascript:1" }), null);
});
ok("YouTube and Vimeo pages play in the real player on the screen", () => {
  const yt = "https://www.youtube.com/embed/aqz-KE-bpKQ?autoplay=1&playsinline=1";
  for (const u of ["https://www.youtube.com/watch?v=aqz-KE-bpKQ", "https://m.youtube.com/watch?v=aqz-KE-bpKQ&t=10", "https://youtu.be/aqz-KE-bpKQ", "https://www.youtube.com/embed/aqz-KE-bpKQ", "https://www.youtube.com/shorts/aqz-KE-bpKQ"]) assert.equal(videoEmbed(u), yt, u);
  assert.equal(videoEmbed("https://vimeo.com/76979871"), "https://player.vimeo.com/video/76979871?autoplay=1");
  for (const u of ["https://en.m.wikipedia.org/wiki/Cat", "https://www.youtube.com/", "https://www.youtube.com/watch?v=<script>", "https://notyoutube.com/watch?v=aqz-KE-bpKQ", "not a url"]) assert.equal(videoEmbed(u), "", u);
});
ok("devices get a short name", () => {
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "iPhone");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari"), "Android phone");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 12; SM-T830) Safari"), "Android tablet");
  assert.equal(deviceName("Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) SamsungBrowser"), "TV");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 9; AFTMM) Silk"), "TV");
  assert.equal(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "Mac");
  assert.equal(deviceName(""), "Computer");
});
ok("httpUrl normalises good addresses and refuses others", () => {
  assert.equal(httpUrl("https://example.com"), "https://example.com/");
  assert.equal(httpUrl("ftp://example.com"), "");
});
console.log(`\n${n} passed`);
