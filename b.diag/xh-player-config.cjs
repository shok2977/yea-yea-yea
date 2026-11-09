const { xhFetchText } = require("../services/xh-fetch.js");
function parse(h) {
  const mk = "window.initials";
  const i = h.indexOf(mk);
  const eq = h.indexOf("=", i + mk.length);
  const js = h.indexOf("{", eq);
  let d = 0, inS = false, esc = false;
  for (let k = js; k < h.length; k++) {
    const c = h.charCodeAt(k);
    if (esc) { esc = false; continue; }
    if (c === 92 && inS) { esc = true; continue; }
    if (c === 34) { inS = !inS; continue; }
    if (inS) continue;
    if (c === 123) d++;
    if (c === 125) { d--; if (!d) return JSON.parse(h.slice(js, k + 1)); }
  }
}
(async () => {
  const url = process.argv[2] || "https://xhamster.com/videos/hot-indian-desi-bhabhi-devar-sex-with-hardcore-style-video-xhPXHe0";
  const h = await xhFetchText(url, { timeoutMs: 8000, priority: 0 });
  const o = parse(h) || {};
  const ps = o.xplayerSettings || {};
  console.log("hlsConfig:", JSON.stringify(ps.hlsConfig, null, 1));
  console.log("preload:", JSON.stringify(ps.preload));
  console.log("userSettings:", JSON.stringify(ps.userSettings).slice(0, 600));
  console.log("videoInfo:", JSON.stringify(ps.videoInfo).slice(0, 600));
})();
