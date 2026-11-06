// Segment 403 matrix: header combos x host alias, DoH-pinned IPs
const https = require("https");
const http = require("http");
function httpGet(url, cb) { http.get(url, { timeout: 25000 }, (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => { try { cb(JSON.parse(b)); } catch { cb({}); } }); }).on("error", () => cb({})); }
function pinnedRaw(url, headers, ipHint) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const ips = ["104.16.4.81", "104.16.3.81"];
    let i = 0;
    const tryReq = () => {
      const h = ipHint || ips[i % ips.length];
      const req = https.request({ hostname: u.hostname, servername: u.hostname, path: u.pathname + u.search, method: "GET", headers, timeout: 15000, ...(h ? { host: u.hostname } : {}), ...(h ? { localAddress: undefined } : {}), ...( { lookup: undefined } ) , socketPath: undefined, createConnection: (opts, cb2) => {
        const net = require("tls");
        return net.connect({ host: h, port: 443, servername: u.hostname }, cb2 ? undefined : undefined);
      } }, (res) => {
        res.resume(); res.on("end", () => resolve({ status: res.statusCode }));
      });
      req.on("timeout", () => { req.destroy(); (i++, i < 4 ? tryReq() : resolve({ status: 0 })); });
      req.on("error", () => { i++; i < 4 ? tryReq() : resolve({ status: 0 }); });
      req.end();
    };
    tryReq();
  });
}
(async () => {
  const feed = await new Promise((resolve) => httpGet("http://127.0.0.1:3080/api/videos?category=newest&page=1", resolve));
  const v = (feed.videos || [])[0];
  const s = await new Promise((resolve) => httpGet("http://127.0.0.1:3080/api/stream-url?url=" + encodeURIComponent(v.pageUrl), resolve));
  const U = new URL(s.m3u8Url);
  console.log("m3u8 host:", U.hostname);
  // fetch variant playlist DIRECT (pinned) to get real segment URL
  const vpBody = await new Promise((resolve) => {
    const req = https.request({ hostname: U.hostname, servername: U.hostname, path: U.pathname + U.search, method: "GET", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" }, timeout: 20000, createConnection: (opts) => require("tls").connect({ ...opts, host: "104.16.4.81" }) }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", () => resolve({ status: 0, body: "" })); req.end();
  });
  console.log("variant(pinned):", vpBody.status);
  if (vpBody.status !== 200) return;
  const segLines = vpBody.body.split("\n").filter(l => l.trim() && !l.startsWith("#"));
  const seg0 = (segLines[0] || "").trim();
  const sU = new URL(seg0.startsWith("http") ? seg0 : new URL(seg0, s.m3u8Url).href);
  console.log("segment:", (sU.hostname + sU.pathname).slice(0, 80));
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
  const combos = [
    ["UA+Ref", { "User-Agent": UA, Referer: "https://xhamster.com/" }],
    ["UA only", { "User-Agent": UA }],
    ["none", {}],
    ["UA+Ref+Range", { "User-Agent": UA, Referer: "https://xhamster.com/", Range: "bytes=0-2047" }],
    ["UA+Ref+Origin", { "User-Agent": UA, Referer: "https://xhamster.com/", Origin: "https://xhamster.com" }],
  ];
  for (const [name, h] of combos) {
    const st = await pinnedRaw("https://" + sU.hostname + sU.pathname + sU.search, h);
    console.log(`${name.padEnd(16)} -> ${st.status}`);
  }
  // host alias swap
  const alt = sU.hostname.replace("xhpingcdn", "xhcdn");
  const stAlt = await pinnedRaw("https://" + alt + sU.pathname + sU.search, { "User-Agent": UA, Referer: "https://xhamster.com/" });
  console.log("alias xhcdn      ->", stAlt.status);
})();
