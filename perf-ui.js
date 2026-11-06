// Real-UI latency: thumbnails (what user sees on every card) + HLS segments (playback)
const http = require("http");
function timedFetch(url, opts = {}, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(url, { ...opts, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ms: Date.now() - t0, status: res.statusCode, bytes: (res.headers['content-length']||0) }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ ms: Date.now() - t0, status: 0, bytes: 0 }); });
    req.on("error", () => resolve({ ms: Date.now() - t0, status: 0, bytes: 0 }));
  });
}
function getJson(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 25000 }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    }).on("error", () => resolve({}));
  });
}
(async () => {
  const feed = await getJson("http://127.0.0.1:3080/api/videos?category=popular&page=1");
  const vids = (feed.videos || []).slice(0, 6);
  // 1) THUMBS — 6 thumbnails in parallel (like a real card grid)
  const t0 = Date.now();
  const th = await Promise.all(vids.map(v => timedFetch(`http://127.0.0.1:3080/api/thumb?url=${encodeURIComponent(v.thumb || (v.preview || ""))}`)));
  console.log("THUMBS parallel total:", Date.now() - t0, "ms");
  th.forEach((r, i) => console.log(`  thumb#${i + 1}: ${r.ms}ms status=${r.status} bytes=${r.bytes}`));
  console.log("  cold thumb times:", th.map(r => r.ms).join(","));
  // again (LRU warm)
  const t1 = Date.now();
  const th2 = await Promise.all(vids.slice(0, 3).map(v => timedFetch(`http://127.0.0.1:3080/api/thumb?url=${encodeURIComponent(v.thumb || "")}`)));
  console.log("THUMBS warm total:", Date.now() - t1, "ms ->", th2.map(r => r.ms).join(","));
  // 2) HLS — resolve stream then fetch master playlist + a segment via proxy
  const v = vids[0];
  const s = await getJson("http://127.0.0.1:3080/api/stream-url?url=" + encodeURIComponent(v.pageUrl));
  if (!s.m3u8Url) { console.log("no m3u8", s); return; }
  console.log("m3u8Url host:", new URL(s.m3u8Url).host);
  // master playlist through server proxy if available: /api/stream?url=
  const mp = await timedFetch("http://127.0.0.1:3080/api/stream?url=" + encodeURIComponent(s.m3u8Url), {}, 20000);
  console.log("master playlist via /api/stream:", mp.ms, "ms status=", mp.status);
  // variant playlist
  const mt0 = Date.now();
  const mpBody = await new Promise((resolve) => {
    http.get("http://127.0.0.1:3080/api/stream?url=" + encodeURIComponent(s.m3u8Url), { timeout: 20000 }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
    }).on("error", () => resolve(""));
  });
  const variantLine = (mpBody.split("\n").find(l => l.trim() && !l.startsWith("#")) || "").trim();
  console.log("variant line:", variantLine.slice(0, 100), "(" + (Date.now() - mt0) + "ms)");
  if (variantLine) {
    const vAbs = variantLine.startsWith("http") ? variantLine : new URL(variantLine, s.m3u8Url).href;
    const varPl = await new Promise((resolve) => {
      http.get("http://127.0.0.1:3080/api/stream?url=" + encodeURIComponent(vAbs), { timeout: 20000 }, (res) => {
        let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
      }).on("error", () => resolve(""));
    });
    const segLines = varPl.split("\n").filter(l => l.trim() && !l.startsWith("#")).slice(0, 3);
    const st0 = Date.now();
    const segs = await Promise.all(segLines.slice(0, 2).map(seg => {
      const segAbs = seg.startsWith("http") ? seg : new URL(seg, vAbs).href;
      return timedFetch("http://127.0.0.1:3080/api/stream?url=" + encodeURIComponent(segAbs), {}, 20000);
    }));
    console.log("segments parallel (first 2):", Date.now() - st0, "ms", segs.map(r => `${r.ms}ms/${r.status}`,).join(" "));
  }
})();
