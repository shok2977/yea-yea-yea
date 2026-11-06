// Parallel /api/thumb throughput through the server (fresh URLs, LRU miss)
const http = require("http");
function localGet(u) {
  return new Promise((resolve) => {
    http.get(u, { timeout: 20000 }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b).videos || []); } catch { resolve([]); } });
    }).on("error", () => resolve([])).on("timeout", function () { this.destroy(); resolve([]); });
  });
}
(async () => {
  // use a category not rendered yet so LRU is cold for those URLs
  const vids = await localGet("http://127.0.0.1:3080/api/videos?category=latina&page=2");
  const thumbs = vids.map((v) => v.thumb).filter(Boolean).slice(0, 12);
  console.log("test with", thumbs.length, "thumbs");

  // warm the upstream synchronously? No — that would fill LRU. Fire parallel thumb requests.
  const t0 = Date.now();
  const results = await Promise.all(thumbs.map((t) => new Promise((res) => {
    const s = Date.now();
    http.get("http://127.0.0.1:3080/api/thumb?url=" + encodeURIComponent(t), { timeout: 20000 }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => res({ status: r.statusCode, ms: Date.now() - s, bytes: Buffer.concat(chunks).length }));
    }).on("error", (e) => res({ status: 0, ms: Date.now() - s, err: e.message }))
      .on("timeout", function () { this.destroy(); res({ status: 0, ms: Date.now() - s, err: "timeout" }); });
  })));
  const total = Date.now() - t0;
  results.sort((a, b) => b.ms - a.ms);
  console.log("SERVER-parallel wall:", total + "ms");
  console.log("slowest 6:", results.slice(0, 6).map((r) => r.status + "/" + r.ms + "ms/" + r.bytes + "B"));
  console.log("failures:", results.filter((r) => r.status !== 200).length);
})();
