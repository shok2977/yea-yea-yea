// Verification sweep: category accuracy + warm click + rate limits
const B = "http://127.0.0.1:3080";
const get = (u) => fetch(B + u).then((r) => r.json());

(async () => {
  // ---- 1) CATEGORY ACCURACY (the hentai case user reported) ----
  let t = Date.now();
  const r1 = await get("/api/videos?category=hentai&page=1");
  const titles = r1.videos.map((v) => (v.title || "").toLowerCase());
  const relevant = titles.filter((x) => /hentai|anime|cartoon|japanese|uncensored|ecchi|elf|heroine|game/.test(x)).length;
  console.log("[1] HENTAI category:", r1.count, "videos in", (Date.now() - t) + "ms — relevant:", relevant + "/" + r1.count, "(" + Math.round(relevant / r1.count * 100) + "%)");
  console.log("    first 8:", JSON.stringify(titles.slice(0, 8), null, 0));

  // ---- 2) WARM CLICK (random page → instant play) ----
  t = Date.now();
  const r2 = await get("/api/videos?feed=all&page=1");
  const all = r2.videos || [];
  const withStream = all.filter((v) => v.stream).length;
  console.log("[2] Home feed:", all.length, "cards in", (Date.now() - t) + "ms —", withStream, "pre-resolved (warm)");

  // click a warm card
  const warmCard = all.find((v) => v.stream);
  if (warmCard) {
    t = Date.now();
    const u = warmCard.pageUrl.startsWith("http") ? warmCard.pageUrl : "https://xhamster.com" + warmCard.pageUrl;
    const r3 = await get("/api/stream-url?url=" + encodeURIComponent(u));
    console.log("[3] Warm click resolve:", r3.success ? "OK" : "FAIL", "in", (Date.now() - t) + "ms");
  }

  // ---- 3) SECOND PAGE of a random category should also serve warm cards ----
  t = Date.now();
  const r4 = await get("/api/videos?category=newest&page=2");
  const nn = (r4.videos || []).filter((v) => v.stream).length;
  console.log("[4] newest page 2:", (r4.videos || []).length, "cards in", (Date.now() - t) + "ms —", nn, "warm");

  // ---- 4) burst rate test: 40 rapid requests must not 429 ----
  let four29 = 0;
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    fetch(B + "/api/videos?category=all&page=1&r=" + i).then((r) => { if (r.status === 429) four29++; })
  ));
  console.log("[5] 40-request burst → 429 count:", four29);
})().catch((e) => console.log("ERR", e.message));
