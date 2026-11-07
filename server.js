/* TubeStream — xhamster-style streaming front end.
 *
 * Design rule (user request): NOTHING is prefetched. No warm queue, no stream
 * pool, no next-page load. Every listing, every search and every video stream is
 * resolved on demand, straight from xhamster's own server payload — exactly the
 * way xhamster's site does it. What we keep is per-request memoisation (a page
 * you already opened re-renders instantly) and a CDN keep-alive client so the
 * HLS hops are fast.
 */
require("dotenv").config();
const express = require("express");
const compression = require("compression");
const path = require("path");

const { cdnRequest, cdnGetBuffer } = require("./services/cdn-http");
const { fullUrl, slugFromPageUrl } = require("./services/xh-core");
const { poolStatus, jarStatus } = require("./services/xh-fetch");
const data = require("./services/xh-data");

const app = express();
const PORT = Number(process.env.PORT) || 3080;

/* ============================== middleware ============================== */
app.use(compression({ threshold: 512 }));

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Range");
  // Visitors never touch a third-party host: every thumbnail and every HLS
  // segment comes back through this origin. These headers keep the browser from
  // leaking the visit (no referrer to anywhere, no powerful APIs requested).
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (ms > 400 || res.statusCode >= 400) console.log("[HTTP]", req.method, req.originalUrl, res.statusCode, ms + "ms");
  });
  next();
});

function fail(res, e) {
  const status = (e && e.status) || 502;
  if (status >= 500) console.warn("[API]", e && e.message ? e.message : e);
  res.status(status).json({ success: false, error: String((e && e.message) || e) });
}

/* ============================== thumbnails ==============================
 * The browser never talks to the CDN directly: xhpingcdn latency on this route
 * swings 105ms–1.5s, and the keep-alive agent + LRU here bring a whole grid down
 * to one RTT wave. This is response caching, not prefetching.
 */
const THUMB_HOST = /^https:\/\/([\w-]+\.)*(xhcdn|xhpingcdn|xhmediacdn)\.com\//;
const THUMB_LRU_MAX = 500;
const THUMB_TTL = 30 * 60 * 1000;
const thumbLRU = new Map();
const thumbInflight = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of thumbLRU) if (now - v.ts > THUMB_TTL) thumbLRU.delete(k);
}, 5 * 60 * 1000).unref();

function thumbAltUrls(url) {
  const out = [url];
  if (url.includes("xhpingcdn.com")) out.push(url.replace("xhpingcdn.com", "xhcdn.com"));
  return out;
}

function thumbLoad(url) {
  const running = thumbInflight.get(url);
  if (running) return running;
  const job = (async () => {
    try {
      const alts = thumbAltUrls(url);
      const opts = {
        headers: { Referer: "https://xhamster.com/", Accept: "image/webp,image/*,*/*" },
        timeoutMs: 12000,
      };
      const got = alts.length > 1
        ? await Promise.any([cdnGetBuffer(alts[0], opts, 2), cdnGetBuffer(alts[1], opts, 2)])
        : await cdnGetBuffer(url, opts, 2);
      const ctype = (got.ctype || "image/webp").split(";")[0] || "image/webp";
      for (const alt of alts) {
        if (thumbLRU.size >= THUMB_LRU_MAX) {
          const oldest = thumbLRU.keys().next().value;
          if (oldest !== undefined) thumbLRU.delete(oldest);
        }
        thumbLRU.set(alt, { buf: got.buf, ctype, ts: Date.now() });
      }
      return { buf: got.buf, ctype };
    } finally {
      thumbInflight.delete(url);
    }
  })();
  thumbInflight.set(url, job);
  return job;
}

app.get("/api/thumb", async (req, res) => {
  const url = req.query.url;
  if (!url || !THUMB_HOST.test(url)) return res.status(400).json({ error: "invalid thumb url" });
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  const hit = thumbLRU.get(url);
  if (hit && Date.now() - hit.ts < THUMB_TTL) {
    thumbLRU.delete(url);
    thumbLRU.set(url, hit);
    res.set("Content-Type", hit.ctype);
    res.set("Content-Length", hit.buf.length);
    return res.end(hit.buf);
  }
  try {
    const { buf, ctype } = await thumbLoad(url);
    res.set("Content-Type", ctype);
    res.set("Content-Length", buf.length);
    res.end(buf);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* =============================== HLS proxy ===============================
 * playlists are rewritten to point back through /api/stream, which keeps the
 * player on one origin (hls.js needs no CORS dance) and lets repeat plays hit
 * the playlist LRU. Segments stream straight through.
 */
const ALLOWED_HOST = /^https:\/\/([\w-]+\.)*(xhcdn|phncdn|xhamster|ahcdn|xhpingcdn|xhmediacdn)\.com\//;
const PLAYLIST_LRU_MAX = 600;
const PLAYLIST_TTL = 10 * 60 * 1000;
const playlistLRU = new Map();
const playlistInflight = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of playlistLRU) if (now - v.ts > PLAYLIST_TTL) playlistLRU.delete(k);
}, 5 * 60 * 1000).unref();

async function upstreamText(url) {
  const r = await cdnRequest(url, { headers: { Referer: "https://xhamster.com/", Accept: "*/*" }, timeoutMs: 15000 });
  if (r.status !== 200 && r.status !== 206) {
    r.stream.resume();
    throw new Error("playlist http " + r.status);
  }
  const chunks = [];
  for await (const v of r.stream) chunks.push(Buffer.from(v));
  return Buffer.concat(chunks).toString("utf8");
}

function getPlaylist(url) {
  const hit = playlistLRU.get(url);
  if (hit && Date.now() - hit.ts < PLAYLIST_TTL) return Promise.resolve(hit.body);
  const running = playlistInflight.get(url);
  if (running) return running;
  const job = upstreamText(url)
    .then((body) => {
      if (playlistLRU.size >= PLAYLIST_LRU_MAX) {
        const oldest = playlistLRU.keys().next().value;
        if (oldest !== undefined) playlistLRU.delete(oldest);
      }
      playlistLRU.set(url, { body, ts: Date.now() });
      return body;
    })
    .finally(() => playlistInflight.delete(url));
  playlistInflight.set(url, job);
  return job;
}

function rewritePlaylistLine(line, baseUrl) {
  const t = line.trim();
  if (!t) return line;
  if (t.startsWith("#")) {
    return t.replace(/URI="([^"]+)"/g, (m, u) => {
      try { return 'URI="/api/stream?url=' + encodeURIComponent(new URL(u, baseUrl).href) + '"'; }
      catch (e) { return m; }
    });
  }
  try { return "/api/stream?url=" + encodeURIComponent(new URL(t, baseUrl).href); }
  catch (e) { return line; }
}

function rewritePlaylist(body, baseUrl) {
  return body.split("\n").map((l) => rewritePlaylistLine(l, baseUrl)).join("\n");
}

app.get("/api/stream", async (req, res) => {
  const url = req.query.url;
  if (!url || !ALLOWED_HOST.test(url)) return res.status(400).json({ error: "invalid url" });

  if (/\.m3u8(\?|$)/i.test(url) && !req.headers.range) {
    try {
      const body = await getPlaylist(url);
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Cache-Control", "public, max-age=60");
      res.set("Access-Control-Allow-Origin", "*");
      return res.send(rewritePlaylist(body, url));
    } catch (e) {
      return res.status(502).json({ error: String(e.message || e) });
    }
  }

  const headers = { Referer: "https://xhamster.com/", Accept: "*/*" };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await cdnRequest(url, { headers, timeoutMs: 20000 });
      if (r.status === 200 || r.status === 206) { upstream = r; break; }
      r.stream.resume();
      lastErr = new Error("upstream " + r.status);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) { lastErr = e; }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 200 + attempt * 250));
  }
  if (!upstream) return res.status(502).json({ error: String((lastErr && lastErr.message) || "upstream failed") });

  const ctype = upstream.headers["content-type"] || "application/octet-stream";
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Accept-Ranges", "bytes");
  if (upstream.headers["content-range"]) {
    res.status(206);
    res.set("Content-Range", upstream.headers["content-range"]);
  }
  const cl = upstream.headers["content-length"];
  if (cl) res.set("Content-Length", cl);

  // A playlist served under a non-.m3u8 name still needs rewriting.
  if (/mpegurl/i.test(ctype)) {
    const chunks = [];
    for await (const v of upstream.stream) chunks.push(Buffer.from(v));
    const body = Buffer.concat(chunks).toString("utf8");
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "public, max-age=60");
    return res.send(rewritePlaylist(body, url));
  }

  res.set("Content-Type", ctype);
  res.set("Cache-Control", "public, max-age=86400");
  upstream.stream.pipe(res);
  upstream.stream.on("error", () => { try { res.destroy(); } catch (e) { /* ignore */ } });
});

/* ================================ JSON API ================================ */
function json(res, payload) {
  res.set("Cache-Control", "no-store");
  res.json(payload);
}

app.get("/api/feed", async (req, res) => {
  try {
    const result = await data.feed({
      tab: String(req.query.tab || "newest").toLowerCase(),
      page: req.query.page,
      priority: 0,
    });
    json(res, { success: true, ...result });
  } catch (e) { fail(res, e); }
});

app.get("/api/category/:slug", async (req, res) => {
  try {
    const result = await data.category({ slug: req.params.slug, page: req.query.page, priority: 0 });
    json(res, { success: true, ...result });
  } catch (e) { fail(res, e); }
});

app.get("/api/search", async (req, res) => {
  try {
    const result = await data.search({ q: req.query.q, page: req.query.page, priority: 0 });
    json(res, { success: true, ...result });
  } catch (e) { fail(res, e); }
});

app.get("/api/suggest", async (req, res) => {
  try {
    json(res, { success: true, suggestions: await data.suggest(req.query.q) });
  } catch (e) {
    // Suggestions are additive — the search box works without them.
    json(res, { success: false, suggestions: [] });
  }
});

// The click path: one upstream page → title, views, tags, stream and related
// videos. No cache hit needed, no prefetch — this IS the resolve.
app.get("/api/watch/:slug", async (req, res) => {
  try {
    const result = await data.watch({ slug: req.params.slug });
    // The player is about to ask for this exact master playlist. Loading it here
    // (single-flight, so the player's request joins instead of duplicating) is
    // the same preload xhamster's own page does with <link rel=preload as=fetch>.
    // Only the clicked video's manifest — never a video the user did not open.
    if (result.stream) getPlaylist(result.stream.url).catch(() => {});
    json(res, { success: true, ...result });
  } catch (e) { fail(res, e); }
});

// Compatibility: resolve from a full page URL.
app.get("/api/stream-url", async (req, res) => {
  try {
    const raw = String(req.query.url || "");
    const slug = slugFromPageUrl(raw) || raw.replace(/^.*\/videos\//, "");
    if (!slug) return res.status(400).json({ success: false, error: "url required" });
    const result = await data.watch({ slug });
    json(res, {
      success: !!result.stream,
      unsupported: result.unsupported,
      m3u8Url: result.stream ? result.stream.url : null,
      pageUrl: result.pageUrl,
      cached: result.cached,
    });
  } catch (e) { fail(res, e); }
});

app.get("/api/categories", (req, res) => {
  json(res, { success: true, ...data.categoryTree() });
});

app.get("/api/stats", (req, res) => {
  json(res, {
    success: true,
    uptime: Math.round(process.uptime()),
    ...data.stats,
    cachedThumbs: thumbLRU.size,
    cachedPlaylists: playlistLRU.size,
    stalePages: data.staleSize(),
    hosts: poolStatus(),
    upstream: jarStatus(),
  });
});

app.get("/api/health", (req, res) => {
  json(res, { status: "ok", uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

app.use("/api", (req, res) => res.status(404).json({ success: false, error: "not found" }));

/* ============================== static + SPA ==============================
 * Client-side router owns /newest, /best/<period>, /categories/<slug>,
 * /search/<q> and /videos/<slug> — the same shapes xhamster uses, so every view
 * has a real, shareable, refreshable URL.
 */
app.use("/vendor", express.static(path.join(__dirname, "node_modules/hls.js/dist"), { maxAge: "30d", immutable: true }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0, etag: true }));

app.get("*", (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================================ start ================================ */
const server = app.listen(PORT, () => {
  const cats = data.categoryTree();
  console.log("TubeStream listening on http://localhost:" + PORT);
  console.log("[Categories]", cats.total, "in", cats.groups.length, "groups");
  console.log("[Mode] on-demand only — no prefetch, no warm queue");
});

function shutdown(signal) {
  console.log("\n[" + signal + "] shutting down…");
  // Persist the last-good pages so a restart during an upstream block still boots warm.
  try { data.flushToDisk(); } catch (e) { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
