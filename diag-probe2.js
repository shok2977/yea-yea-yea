// Probe: (1) thumb proxy latency/failures, (2) first-request "random page" latency,
// (3) hunt xhamster internal JSON endpoints by scanning JS bundles for /api/ paths
const { xhFetchText, prewarmIps } = require("./services/xh-fetch.js");
const http = require("http");

function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "", err: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, body: "", err: e.message }));
  });
}
async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(label, "->", (Date.now() - t0) + "ms", out);
    return out;
  } catch (e) {
    console.log(label, "-> FAIL", (Date.now() - t0) + "ms", e.message || e);
    return null;
  }
}
(async () => {
  prewarmIps();
  await new Promise((r) => setTimeout(r, 1500));

  // 1. THUMB PROXY: real card thumb URLs from a live category page
  const feed = await httpGet("http://127.0.0.1:3080/api/videos?category=milf&page=1");
  let vids = [];
  try { vids = JSON.parse(feed.body).videos || []; } catch {}
  console.log("milf p1 videos:", vids.length);
  const sampleThumbs = vids.slice(0, 5).map((v) => v.thumb).filter(Boolean);
  for (const t of sampleThumbs) {
    const r = await httpGet("http://127.0.0.1:3080/api/thumb?url=" + encodeURIComponent(t), 20000);
    const looksHtml = r.body.slice(0, 20).includes("<");
    console.log("THUMB:", r.status, "bytes:", r.body.length, r.status !== 200 || looksHtml ? r.body.slice(0, 80).replace(/\n/g, " ") : "binary-ok");
  }

  // 2. COLD page latency: a category never requested recently
  await timed("COLD /api/videos?category=parrot&page=1", () =>
    (async () => {
      const r = await httpGet("http://127.0.0.1:3080/api/videos?category=parrot&page=1", 40000);
      let n = 0;
      try { n = (JSON.parse(r.body).videos || []).length; } catch {}
      return { status: r.status, videos: n };
    })()
  );

  // 3. JS bundle hunt for /api/ endpoints
  try {
    const home = await xhFetchText("https://xhamster.com/newest", { timeoutMs: 9000 });
    const bundleUrls = [...new Set([...home.matchAll(/https:\/\/[\w.-]+xhcdn\.com\/[^"']+?\.js/g)].map((m) => m[0]))].slice(0, 8);
    console.log("bundles found:", bundleUrls.length);
    const apiPaths = new Set();
    for (const b of bundleUrls) {
      try {
        const js = await xhFetchText(b, { timeoutMs: 9000 });
        for (const m of js.matchAll(/["'`]((?:https:\/\/xhamster\.com)?\/api\/front?[^"'`\s]{2,60})["'`]/g)) apiPaths.add(m[1]);
      } catch {}
    }
    console.log("API paths found:", [...apiPaths]);
  } catch (e) { console.log("bundle hunt failed:", e.message); }
})();
