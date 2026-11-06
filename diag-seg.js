// Diagnose 502: what upstream status does a segment fetch actually get?
const http = require("http");
function getJson(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 25000 }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    }).on("error", () => resolve({}));
  });
}
function raw(url, headers, asBuffer) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers: headers || {}, timeout: 20000 }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, ct: res.headers["content-type"] }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, ct: "" }); });
    req.on("error", () => resolve({ status: 0, ct: "" }));
    req.end();
  });
}
(async () => {
  // fresh resolve
  const feed = await getJson("http://127.0.0.1:3080/api/videos?category=popular&page=1");
  const v = (feed.videos || [])[0];
  const s = await getJson("http://127.0.0.1:3080/api/stream-url?url=" + encodeURIComponent(v.pageUrl));
  console.log("m3u8:", (s.m3u8Url || "NONE").slice(0, 90));
  // master playlist through proxy
  function proxyText(url) {
    return new Promise((resolve) => {
      http.get(url, { timeout: 20000 }, (res) => {
        let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }).on("error", () => resolve({ status: 0, body: "" }));
    });
  }
  const mp = await proxyText("http://127.0.0.1:3080/api/stream?url=" + encodeURIComponent(s.m3u8Url));
  const vLine = (mp.body.split("\n").find(l => l.trim() && !l.startsWith("#")) || "").trim();
  const vAbs = vLine.startsWith("http") ? vLine : new URL(vLine, s.m3u8Url).href;
  const vp = await proxyText("http://127.0.0.1:3080/api/stream?url=" + encodeURIComponent(vAbs));
  const segLines = vp.body.split("\n").filter(l => l.trim() && !l.startsWith("#"));
  const seg = (segLines[0] || "").trim();
  const segAbs = seg.startsWith("http") ? seg : new URL(seg, vAbs).href;
  console.log("segment:", segAbs.slice(0, 110));
  // 1) through proxy — print full error body on failure
  const r1 = await proxyText("http://127.0.0.1:3080/api/stream?url=" + encodeURIComponent(segAbs));
  console.log("proxy segment:", r1.status, r1.status !== 200 ? r1.body.slice(0, 120) : "OK");
  // 2) DIRECT node fetch with proxy-like headers
  const d = await raw(segAbs, { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", Referer: "https://xhamster.com/", Accept: "*/*" });
  console.log("direct segment:", d.status, d.ct);
  // 3) direct with ZERO headers
  const d2 = await raw(segAbs, {});
  console.log("direct no-headers:", d2.status, d2.ct);
})();
