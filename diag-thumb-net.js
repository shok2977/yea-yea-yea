// Thumb CDN timing: xhcdn vs xhpingcdn + DNS check
const dns = require("dns").promises;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const t0global = Date.now();

// fresh thumb URLs (fetched live from feed)
const http = require("http");
function localGet(u) {
  return new Promise((resolve) => {
    http.get(u, { timeout: 20000 }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b).videos || []); } catch { resolve([]); } });
    }).on("error", () => resolve([])).on("timeout", function () { this.destroy(); resolve([]); });
  });
}
async function timedFetch(label, url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://xhamster.com/" }, signal: AbortSignal.timeout(15000) });
    const buf = await r.arrayBuffer();
    console.log(label, "status", r.status, "bytes", buf.byteLength, (Date.now() - t0) + "ms", r.url.slice(8, 40));
  } catch (e) { console.log(label, "FAIL", (Date.now() - t0) + "ms", e.message); }
}
(async () => {
  for (const h of ["ic-vt-nss.xhcdn.com", "ic-vt-nss.xhpingcdn.com", "thumb-vt-nss.xhcdn.com"]) {
    try { const a = await dns.lookup(h); console.log("DNS", h, "->", a.address); }
    catch (e) { console.log("DNS", h, "FAIL", e.message); }
  }
  const vids = await localGet("http://127.0.0.1:3080/api/videos?category=asian&page=1");
  const thumbs = vids.map((v) => v.thumb).filter(Boolean).slice(0, 12);
  const xcdn = [], ping = [];
  for (const t of thumbs) { if (/xhpingcdn/.test(t)) ping.push(t); else if (/xhcdn/.test(t)) xcdn.push(t); }
  console.log("split: xhcdn:", xcdn.length, "xhpingcdn:", ping.length);
  // individual timing
  for (const t of xcdn.slice(0, 4)) await timedFetch("xhcdn   ", t);
  for (const t of ping.slice(0, 4)) await timedFetch("xhping  ", t);
  // host swap test: rewrite xhpingcdn -> xhcdn and time
  for (const t of ping.slice(4, 6) || []) await timedFetch("ping->cdn swap", t.replace("xhpingcdn.com", "xhcdn.com"));
  /// concurrency: 12 parallel mixed
  const all = thumbs.slice(0, 12);
  const t1 = Date.now();
  await Promise.all(all.map((t) => fetch(t, { headers: { "User-Agent": UA, Referer: "https://xhamster.com/" }, signal: AbortSignal.timeout(15000) }).then((r) => r.arrayBuffer()).catch(() => null)));
  console.log("12-parallel batch:", (Date.now() - t1) + "ms");
})();
