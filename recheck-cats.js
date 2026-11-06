// Recheck after fix: previously-junk categories + main feeds
const http = require("http");
function getJson(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ videos: [] }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ videos: [] }); });
    req.on("error", () => resolve({ videos: [] }));
  });
}
function slugOf(pageUrl) {
  try { return decodeURIComponent(new URL(pageUrl).pathname.split("/").pop().replace(/\.[a-z0-9]+$/i, "")); }
  catch { return ""; }
}
// word-boundary regex like the server's verification
function buildRe(phrase) {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^a-z])" + esc + "($|[^a-z])", "i");
}
(async () => {
  const catMap = require("./categories-map.json");
  const bad = ["18yearold","bahraini","facefetish","mauritanian","solomonisland","valentinesday","bodypaint","saggytits","matureswallows","milf","hentai","anal","asian","cheating","hardcore","grandma"];
  for (const k of bad) {
    const info = catMap[k];
    const phrases = [k.toLowerCase()];
    if (info && info.slug) phrases.push(String(info.slug).replace(/-/g, " ").toLowerCase());
    const res = buildRe(phrases[0]).test("") ? [] : null; // placeholder to keep structure
    const r1 = await getJson(`http://127.0.0.1:3080/api/videos?category=${k}&page=1`);
    const vid1 = r1.videos || [];
    let non1 = 0, ex1 = [];
    for (const v of vid1) {
      const hay = `${v.title || ""} ${slugOf(v.pageUrl || "")}`.toLowerCase();
      if (!phrases.some((p) => buildRe(p).test(hay))) {
        non1++;
        if (ex1.length < 2) ex1.push(v.title || v.pageUrl);
      }
    }
    console.log(k.padEnd(15), `p1: n=${String(vid1.length).padStart(3)} non=${String(non1).padStart(2)}`, non1 ? JSON.stringify(ex1) : "OK");
  }
  // MAIN FEEDS — no keyword check, just counts
  for (const k of ["newest", "popular", "hot", "top", "hd", "longest"]) {
    const r1 = await getJson(`http://127.0.0.1:3080/api/videos?category=${k}&page=1`);
    const r2 = await getJson(`http://127.0.0.1:3080/api/videos?category=${k}&page=2`);
    console.log("MAIN", k.padEnd(15), `p1: n=${(r1.videos || []).length}  p2: n=${(r2.videos || []).length}`);
  }
})();
