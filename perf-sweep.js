// Perf sweep: latency for every key page/API path (cached + cold)
const http = require("http");
function timedGet(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let n = 0;
        try { n = (JSON.parse(buf).videos || []).length; } catch {}
        resolve({ ms: Date.now() - t0, status: res.statusCode, n });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ms: Date.now() - t0, status: 0, n: -1 }); });
    req.on("error", () => resolve({ ms: Date.now() - t0, status: 0, n: -1 }));
  });
}
(async () => {
  const paths = [
    // main feeds (should be cache-instant)
    "/api/videos?category=all&page=1",
    "/api/videos?category=newest&page=1",
    "/api/videos?category=popular&page=1",
    "/api/videos?category=newest&page=2",
    "/api/videos?category=hot&page=1",
    // categories
    "/api/videos?category=hentai&page=1",
    "/api/videos?category=milf&page=1",
    "/api/videos?category=anal&page=1",
    "/api/videos?category=asian&page=2",
    "/api/videos?category=ebony&page=1",
    "/api/videos?category=grandma&page=1",
    // rare (cold!)
    "/api/videos?category=saggytits&page=1",
    "/api/videos?category=valentinesday&page=1",
    // other APIs
    "/api/categories",
    "/api/stats",
    "/api/health",
  ];
  for (const p of paths) {
    const r = await timedGet("http://127.0.0.1:3080" + p);
    const flag = r.ms > 1500 ? " <-- SLOW" : r.status === 0 ? " <-- FAIL" : "";
    console.log(`${String(r.ms).padStart(6)}ms  n=${String(r.n).padStart(3)}  ${p}${flag}`);
  }
})();
