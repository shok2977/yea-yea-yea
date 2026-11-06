// Diag: does xhamster's search-page SSR payload carry tag/keywords per card?
const https = require("https");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: "104.16.3.81",           // DoH-pinned xhamster.com IP
      servername: "xhamster.com",
      path: u.pathname + u.search,
      method: "GET",
      headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" },
      timeout: 20000,
    }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}
function parseInitials(html) {
  const marker = "window.initials";
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const eqIdx = html.indexOf("=", idx + marker.length);
  if (eqIdx === -1) return null;
  const jsonStart = html.indexOf("{", eqIdx);
  if (jsonStart === -1 || jsonStart - eqIdx > 5) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = jsonStart; i < html.length && i < jsonStart + 5000000; i++) {
    const c = html.charCodeAt(i);
    if (esc) { esc = false; continue; }
    if (c === 92 && inStr) { esc = true; continue; }
    if (c === 34) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === 123) depth++;
    if (c === 125) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(html.substring(jsonStart, end + 1)); } catch { return null; }
}
function findVTP(node, depth) {
  if (!node || depth > 5) return null;
  if (Array.isArray(node.videoThumbProps)) return node.videoThumbProps;
  for (const k of Object.keys(node)) {
    if (typeof node[k] === "object" && node[k] !== null) {
      const f = findVTP(node[k], depth + 1);
      if (f) return f;
    }
  }
  return null;
}
(async () => {
  for (const kw of ["face fetish", "bahraini"]) {
    try {
      const r = await fetchText("https://xhamster.com/search/" + encodeURIComponent(kw) + "/1");
      const ini = parseInitials(r.body);
      if (!ini) { console.log("==", kw, "status", r.status, "len", r.body.length, "no initials"); continue; }
      const vp = findVTP(ini, 0) || [];
      console.log("==", kw, "status", r.status, "cards", vp.length);
      if (vp[0]) {
        console.log("card keys:", Object.keys(vp[0]).join(","));
        for (const key of ["keywords","tags","categories","channels","channel","tag","labels","landing"]) {
          if (vp[0][key] !== undefined) console.log(" ", key, "=", JSON.stringify(vp[0][key]).slice(0, 200));
        }
      }
      // how many cards carry non-empty tags?
      let withTags = 0;
      for (const v of vp) {
        const t = [];
        for (const key of ["keywords","tags","categories","channels","channel","tag","labels"]) {
          if (Array.isArray(v[key])) t.push(...v[key]);
          else if (v[key]) t.push(v[key]);
        }
        if (v.landing) t.push("landing:" + (v.landing.name || ""));
        if (t.length) withTags++;
      }
      console.log("cards with any tag-ish field:", withTags, "/", vp.length);
    } catch (e) { console.log(kw, "ERR", e.message); }
    await new Promise((r) => setTimeout(r, 3000));
  }
})();
