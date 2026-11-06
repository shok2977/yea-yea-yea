// Sweep: probe /api/feed?category=<key>&page=N for a diverse sample of categories
const http = require("http");
function getJson(url, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, raw: buf.slice(0, 200) }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
  });
}
function slugOf(pageUrl) {
  try { return decodeURIComponent(new URL(pageUrl).pathname.split("/").pop().replace(/\.[a-z0-9]+$/i, "")); }
  catch { return ""; }
}
// word variants the server probably uses for verification — we use category key + simple variants
function variantsFor(key, catMap) {
  const v = [key.toLowerCase()];
  const info = catMap && catMap[key];
  if (info && info.slug) v.push(String(info.slug).replace(/-/g, " ").toLowerCase());
  return [...new Set(v)];
}
(async () => {
  const catMap = require("./categories-map.json");
  const keys = Object.keys(catMap);
  // Diverse sample: every 37th key + some risky ones
  const risky = ["milf","teen","anal","asian","ebony","hentai","grandma","pissing","creampie","amputee","asianladyboy","bbwgay","matureswallows"];
  const sample = [...new Set(risky.concat(keys.filter((_, i) => i % 37 === 0)))];
  const report = [];
  for (const key of sample) {
    if (key === "all") continue;
    const cat = catMap[key];
    const variants = variantsFor(key, catMap);
    const pages = [1, 2, 3];
    const out = { key, variants, pages: [] };
    for (const p of pages) {
      const r = await getJson(`http://127.0.0.1:3080/api/videos?category=${encodeURIComponent(key)}&page=${p}`);
      const vids = (r.json && r.json.videos) || [];
      let non = 0, examples = [];
      for (const v of vids) {
        const hay = `${v.title || ""} ${slugOf(v.pageUrl || "")}`.toLowerCase();
        if (!variants.some((w) => hay.includes(w))) {
          non++;
          if (examples.length < 3) examples.push(v.title || v.pageUrl);
        }
      }
      out.pages.push({ p, n: vids.length, non, status: r.status, examples });
      if (vids.length < 20) break; // skip deeper pages for small cats
    }
    report.push(out);
    const line = out.pages.map(c => `p${c.p}: n=${c.n} non=${c.non}`).join(" | ");
    console.log(`${out.key.padEnd(16)} ${line}`);
  }
  const bad = report.filter(r => r.pages.some(c => c.p === 1 && (c.non > 0 || c.n === 0)));
  console.log("\n=== CATS FAILING P1 ===");
  for (const b of bad) console.log(b.key, JSON.stringify(b.pages.map(({p,n,non,examples}) => ({p,n,non,examples}))));
  require("fs").writeFileSync("sweep-all-results.json", JSON.stringify(report, null, 1));
})();
