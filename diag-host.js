// Test: does swapping xhpingcdn -> xhcdn revive 403ing HLS URLs?
const https = require("https");
function raw(url, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers: headers || {}, timeout: 20000, servername: u.hostname }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0 }); });
    req.on("error", () => resolve({ status: 0 }));
    req.end();
  });
}
function getJson(url) {
  return new Promise((resolve) => {
    httpGet(url, (json) => resolve(json));
  });
}
const http = require("http");
function httpGet(url, cb) {
  http.get(url, { timeout: 25000 }, (res) => {
    let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => { try { cb(JSON.parse(b)); } catch { cb({}); } });
  }).on("error", () => cb({}));
}
(async () => {
  const feed = await getJson("http://127.0.0.1:3080/api/videos?category=newest&page=1");
  const v = (feed.videos || [])[0];
  const s = await getJson("http://127.0.0.1:3080/api/stream-url?url=" + encodeURIComponent(v.pageUrl));
  const U = new URL(s.m3u8Url);
  const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" };
  for (const host of [U.hostname, U.hostname.replace("xhpingcdn", "xhcdn")]) {
    const mUrl = "https://" + host + U.pathname + U.search;
    console.log("== host:", host);
    console.log("  master:", (await raw(mUrl, UA)).status);
    // fetch master body via raw with body capture
    const body = await new Promise((resolve) => {
      const r = https.request({ hostname: host, path: U.pathname + U.search, method: "GET", headers: UA, timeout: 20000 }, (res) => {
        let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      r.on("error", () => resolve({ status: 0, body: "" })); r.end();
    });
    if (body.status !== 200) { console.log("  master body FAILED", body.status); continue; }
    const vLine = (body.body.split("\n").find(l => l.trim() && !l.startsWith("#")) || "").trim();
    const vAbs = vLine.startsWith("http") ? vLine : "https://" + host + vLine;
    const vU = new URL(vAbs);
    const vp = await new Promise((resolve) => {
      const r = https.request({ hostname: vU.hostname, path: vU.pathname + vU.search, method: "GET", headers: UA, timeout: 20000 }, (res) => {
        let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      r.on("error", () => resolve({ status: 0, body: "" })); r.end();
    });
    console.log("  variant:", vp.status);
    if (vp.status !== 200) continue;
    const segLines = vp.body.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    const seg = (segLines[0] || "").trim();
    const sU = new URL(seg.startsWith("http") ? seg : new URL(seg, vAbs).href);
    const segAbs = "https://" + sU.hostname + sU.pathname + sU.search;
    console.log("  seg0 (Range 0-2047):", (await raw(segAbs, { ...UA, Range: "bytes=0-2047" })).status);
    break;
  }
})();
