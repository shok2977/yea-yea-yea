// Verify: NO rate limits anymore — burst 260 rapid requests past old caps
const http = require("http");
function fire(path) {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:3080" + path, { timeout: 15000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error", () => resolve(0));
  });
}
(async () => {
  const paths = [];
  for (let i = 0; i < 260; i++) paths.push("/api/suggest?q=test" + (i % 40));
  const t0 = Date.now();
  const codes = await Promise.all(paths.map(fire));
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const counts = {};
  for (const c of codes) counts[c] = (counts[c] || 0) + 1;
  console.log("260 suggest requests in", dt + "s:", JSON.stringify(counts));
  // categories burst past old 120/min cap
  const cats = [];
  const map = require("./categories-map.json");
  const keys = Object.keys(map);
  for (let i = 0; i < 140; i++) cats.push("/api/videos?category=" + keys[i] + "&page=1");
  const t1 = Date.now();
  const codes2 = await Promise.all(cats.map(fire));
  const counts2 = {};
  for (const c of codes2) counts2[c] = (counts2[c] || 0) + 1;
  console.log("140 category requests burst:", JSON.stringify(counts2));
  const h = await fire("/api/health");
  console.log("health:", h);
})();
