// Instant-play check: resolve streams for cards from several feeds, time each
const http = require("http");
function getJson(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
    req.on("timeout", () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });
}
(async () => {
  const feeds = ["newest", "hot", "hentai", "milf"];
  const cards = [];
  for (const f of feeds) {
    const r = await getJson(`http://127.0.0.1:3080/api/videos?category=${f}&page=1`);
    if (Array.isArray(r.videos)) cards.push(...r.videos.slice(0, 4));
  }
  for (const v of cards) {
    const u = encodeURIComponent(v.pageUrl);
    const t0 = Date.now();
    const s = await getJson(`http://127.0.0.1:3080/api/stream-url?url=${u}`);
    console.log(`${String(Date.now() - t0).padStart(6)}ms  ${s.success && s.m3u8Url ? "M3U8-OK" : "FAIL"}  ${(v.title || "").slice(0, 45)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
})();
