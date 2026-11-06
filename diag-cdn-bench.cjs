/* diag-cdn-bench.cjs — is the local proxy actually faster than the CDN edge?
 * Compares, for THUMBS and for HLS SEGMENTS:
 *   proxy  = http://127.0.0.1:3080/... (our Node hop)
 *   direct = CDN URL (what xhamster's own player does)
 * Run: node diag-cdn-bench.cjs [category]
 */
const BASE = "http://127.0.0.1:3080";

async function listing(cat) {
  const r = await fetch(BASE + "/api/videos?category=" + encodeURIComponent(cat) + "&page=1");
  const j = await r.json();
  return j.videos || [];
}

async function bench(label, urls, mk) {
  const t0 = Date.now();
  const res = await Promise.all(urls.map(async (u) => {
    const t = Date.now();
    try {
      const r = await fetch(mk(u));
      const b = await r.arrayBuffer();
      return { ok: r.ok, ms: Date.now() - t, n: b.byteLength };
    } catch (e) { return { ok: false, ms: Date.now() - t, n: 0 }; }
  }));
  res.sort((a, b) => a.ms - b.ms);
  const ok = res.filter((r) => r.ok);
  console.log(
    label.padEnd(10),
    "wall", String(Date.now() - t0).padStart(5) + "ms",
    "ok", ok.length + "/" + res.length,
    "p50", String(res[Math.floor(res.length / 2)].ms).padStart(4) + "ms",
    "p90", String(res[Math.floor(res.length * 0.9)].ms).padStart(4) + "ms",
    "max", String(res[res.length - 1].ms).padStart(4) + "ms",
    "bytes", ok.reduce((s, r) => s + r.n, 0)
  );
}

async function resolveOne(pageUrl) {
  const r = await fetch(BASE + "/api/stream-url?url=" + encodeURIComponent(pageUrl) + "&refresh=1");
  const j = await r.json();
  return j.m3u8Url;
}

async function segmentUrls(master) {
  const masterBody = await (await fetch(master)).text();
  const lvl = masterBody.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const lvlUrl = new URL(lvl, master).href;
  const lvlBody = await (await fetch(lvlUrl)).text();
  return lvlBody.split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !/\.m3u8/.test(l))
    .slice(0, 8).map((l) => new URL(l, lvlUrl).href);
}

(async () => {
  const cat = process.argv[2] || "newest";
  const videos = await listing(cat);
  // Take a tail slice — least likely to be in the server's thumb LRU already
  const thumbs = videos.slice(-24).map((v) => v.thumb).filter(Boolean);
  console.log("category:", cat, "| cards:", videos.length, "| bench thumbs:", thumbs.length);

  await bench("THUMB dir", thumbs, (u) => u);
  await bench("THUMB prx", thumbs, (u) => BASE + "/api/thumb?url=" + encodeURIComponent(u));

  const target = videos.find((v) => v.pageUrl);
  if (!target) return console.log("no video to resolve");
  const master = await resolveOne(target.pageUrl);
  if (!master) return console.log("resolve failed");
  const segs = await segmentUrls(master);
  console.log("segments:", segs.length, "from", master.split("/").slice(2, 4).join("/"));
  await bench("SEG dir", segs, (u) => u);
  await bench("SEG prx", segs, (u) => BASE + "/api/stream?url=" + encodeURIComponent(u));
})();
