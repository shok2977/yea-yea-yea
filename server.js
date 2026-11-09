/* TubeStream — xhamster-style streaming front end.
 *
 * Design rule (user request): NOTHING is prefetched. No warm queue, no stream
 * pool, no next-page load. Every listing, every search and every video stream is
 * resolved on demand, straight from xhamster's own server payload — exactly the
 * way xhamster's site does it. What we keep is per-request memoisation (a page
 * you already opened re-renders instantly) and a CDN keep-alive client so the
 * HLS hops are fast.
 *
 * Security rule: the browser never learns an upstream URL. Every thumbnail and
 * every playlist/segment is addressed through an opaque, expiring handle minted
 * here (services/secure-url.js), so a caller cannot invent cache keys, cannot
 * make this box fetch arbitrary upstream objects, and cannot reach the CDN
 * directly from the visitor's own IP.
 */
require("dotenv").config();
const express = require("express");
const compression = require("compression");
const path = require("path");

const { cdnRequest, cdnGetBuffer } = require("./services/cdn-http");
const { slugFromPageUrl } = require("./services/xh-core");
const { poolStatus, jarStatus } = require("./services/xh-fetch");
const data = require("./services/xh-data");
const secure = require("./services/secure-url");
const guard = require("./services/guard");
const { rateLimit, concurrent } = guard;
const egress = require("./services/egress");
const auth = require("./services/auth");
const shared = require("./services/shared");
const { hydrateHealth } = require("./services/xh-fetch");

const app = express();
const PORT = Number(process.env.PORT) || 3080;

app.disable("x-powered-by");
app.set("query parser", "simple");   // no nested-object query tricks

// Behind Caddy/Nginx/Cloudflare: trust exactly one proxy hop so req.secure and
// the rate-limit identity are right. Off by default — a spoofed X-Forwarded-For
// must never buy a fresh budget.
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

/* ------------------------------ middleware ==============================
 * CORS is closed by default: the SPA and the player are same-origin, so an open
 * `Access-Control-Allow-Origin: *` only ever served other people's pages that
 * wanted a free proxy. ALLOWED_ORIGINS opts specific sites back in.
 */
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const DOC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/* Proxied bytes are never a document: if someone navigates to one of these URLs
 * directly, it must not be able to run script on this origin. */
const BINARY_CSP = "default-src 'none'; sandbox";

app.use(compression({ threshold: 512 }));

app.use((req, res, next) => {
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Cross-Origin-Resource-Policy", "same-origin");
  if (auth.isHttps(req)) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (!req.path.startsWith("/api/")) res.set("Content-Security-Policy", DOC_CSP);

  const origin = req.headers.origin;
  if (origin) {
    res.set("Vary", "Origin");
    if (ALLOWED_ORIGINS.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Range");
    }
  }

  if (req.method === "OPTIONS") {
    if (origin && ALLOWED_ORIGINS.includes(origin)) return res.sendStatus(204);
    return res.sendStatus(403);
  }
  next();
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (ms > 400 || res.statusCode >= 400) console.log("[HTTP]", req.method, req.originalUrl.slice(0, 200), res.statusCode, ms + "ms");
  });
  next();
});

/* ------------------------------ access gate ------------------------------
 * The site is PUBLIC by default — ACCESS_CODES unset means no gate at all, so
 * any visitor can use it. If an operator later sets ACCESS_CODES, the invite
 * gate turns on (see services/auth.js). Either way the shared cache + adaptive
 * upstream budget, not a login wall, is what protects upstream.
 */
app.use(auth.gate);

function fail(res, e) {
  const status = (e && e.status) || 502;
  if (e && e.retryAfter) res.set("Retry-After", String(Math.max(1, Math.ceil(e.retryAfter / 1000))));
  if (status >= 500) console.warn("[API]", e && e.message ? e.message : e);
  res.status(status).json({ success: false, error: String((e && e.message) || e) });
}

/* ------------------------------ rate limits ------------------------------
 * Each budget is sized for a person browsing (one page = ~3 listings + ~46
 * thumbs) and is far below what a script needs to hurt upstream or the CDN.
 */
/* Visitor limits: generous per-IP ceilings that only exist to protect the box
 * from a runaway scraper, never to throttle real browsing. They are high by
 * default (thousands/min); a legitimate visitor never comes near them.
 * Set RATE_LIMIT_AUTO=0 to restore the old strict caps (90/min listings).
 * Upstream page fetches are paced by the adaptive budget instead — cached
 * responses are unlimited. */
const AUTO = String(process.env.RATE_LIMIT_AUTO || "1") !== "0";
const L = (auto) => (AUTO ? auto * 10 : auto);
const listingLimit = rateLimit({ name: "list", windowMs: 60000, max: L(90) });
const watchLimit = rateLimit({ name: "watch", windowMs: 60000, max: L(60) });
const resolveLimit = rateLimit({ name: "resolve", windowMs: 60000, max: L(30) });
const suggestLimit = rateLimit({ name: "suggest", windowMs: 60000, max: L(30) });
const thumbLimit = rateLimit({ name: "thumb", windowMs: 60000, max: L(900) });
const streamLimit = rateLimit({ name: "stream", windowMs: 60000, max: L(1800) });
const thumbConcurrency = concurrent({ name: "thumb", max: AUTO ? 128 : 24 });
const streamConcurrency = concurrent({ name: "stream", max: AUTO ? 128 : 24 });
const loginLimit = rateLimit({ name: "login", windowMs: 60000, max: 8 });

/* ------------------------------ access gate ------------------------------ */
app.get("/login", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(auth.loginPage(req));
});

app.post(
  "/api/auth/login",
  loginLimit,
  express.urlencoded({ extended: false, limit: "4kb" }),
  auth.loginHandler
);
app.post("/api/auth/logout", auth.logoutHandler);

/* ============================== thumbnails ==============================
 * The browser never talks to the CDN directly: xhpingcdn latency on this route
 * swings 105ms–1.5s, and the keep-alive agent + LRU here bring a whole grid down
 * to one RTT wave. This is response caching, not prefetching.
 */
const THUMB_LRU_MAX = 500;
const THUMB_MAX_BYTES = 4 * 1024 * 1024;
const THUMB_LRU_BYTES = 48 * 1024 * 1024;
const THUMB_TTL = 30 * 60 * 1000;
const thumbLRU = new Map();      // raw upstream url -> { buf, ctype, ts }
const thumbInflight = new Map();
let thumbBytes = 0;

function evictThumb(key) {
  const entry = thumbLRU.get(key);
  if (!entry) return false;
  thumbBytes -= entry.buf.length;
  thumbLRU.delete(key);
  return true;
}

function thumbStore(key, entry) {
  evictThumb(key);
  if (entry.buf.length > THUMB_LRU_BYTES) return;
  while (thumbLRU.size >= THUMB_LRU_MAX || (thumbBytes + entry.buf.length > THUMB_LRU_BYTES && thumbLRU.size)) {
    const oldest = thumbLRU.keys().next().value;
    if (oldest === undefined || !evictThumb(oldest)) break;
  }
  thumbLRU.set(key, entry);
  thumbBytes += entry.buf.length;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of thumbLRU) if (now - v.ts > THUMB_TTL) evictThumb(k);
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
        headers: { Referer: "https://xhamster.com/", Accept: "image/webp,image/apng,image/*,*/*;q=0.8" },
        timeoutMs: 12000,
        maxBytes: THUMB_MAX_BYTES,
      };
      const got = alts.length > 1
        ? await Promise.any([cdnGetBuffer(alts[0], opts, 2), cdnGetBuffer(alts[1], opts, 2)])
        : await cdnGetBuffer(url, opts, 2);
      const ctype = String(got.ctype || "").split(";")[0].trim().toLowerCase() || "image/jpeg";
      // Only images. Upstream must never be able to hand the browser a document
      // from this origin (HTML/SVG/JSON served as a thumbnail = stored XSS).
      if (!ctype.startsWith("image/")) throw new Error("upstream is not an image");
      for (const alt of alts) thumbStore(alt, { buf: got.buf, ctype, ts: Date.now() });
      return { buf: got.buf, ctype };
    } finally {
      thumbInflight.delete(url);
    }
  })();
  thumbInflight.set(url, job);
  return job;
}

app.get("/api/thumb", thumbLimit, thumbConcurrency, async (req, res) => {
  const url = secure.readThumbToken(req.query.t);
  if (!url) return res.status(403).json({ error: "invalid thumb handle" });
  res.set("Content-Security-Policy", BINARY_CSP);
  res.set("Cache-Control", "public, max-age=86400");
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
    // Do not echo upstream internals (hostnames, status codes) to the client.
    res.status(502).json({ error: "thumbnail unavailable" });
  }
});

/* =============================== HLS proxy ===============================
 * playlists are rewritten to point back through /api/stream, which keeps the
 * player on one origin (hls.js needs no CORS dance) and lets repeat plays hit
 * the playlist LRU. Segments stream straight through.
 */
const PLAYLIST_LRU_MAX = 600;
const PLAYLIST_MAX_BYTES = 2 * 1024 * 1024;
const PLAYLIST_LRU_BYTES = 24 * 1024 * 1024;
const PLAYLIST_TTL = 10 * 60 * 1000;
const playlistLRU = new Map();
const playlistInflight = new Map();
let playlistBytes = 0;

function evictPlaylist(key) {
  const entry = playlistLRU.get(key);
  if (!entry) return false;
  playlistBytes -= entry.bytes;
  playlistLRU.delete(key);
  return true;
}

function playlistStore(key, body) {
  const bytes = Buffer.byteLength(body, "utf8");
  evictPlaylist(key);
  if (bytes > PLAYLIST_LRU_BYTES) return body;
  while (playlistLRU.size >= PLAYLIST_LRU_MAX || (playlistBytes + bytes > PLAYLIST_LRU_BYTES && playlistLRU.size)) {
    const oldest = playlistLRU.keys().next().value;
    if (oldest === undefined || !evictPlaylist(oldest)) break;
  }
  playlistLRU.set(key, { body, ts: Date.now(), bytes });
  playlistBytes += bytes;
  return body;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of playlistLRU) if (now - v.ts > PLAYLIST_TTL) evictPlaylist(k);
}, 5 * 60 * 1000).unref();

async function upstreamText(url) {
  const r = await cdnRequest(url, { headers: { Referer: "https://xhamster.com/", Accept: "*/*" }, timeoutMs: 15000 });
  if (r.status !== 200 && r.status !== 206) {
    r.stream.resume();
    throw new Error("playlist http " + r.status);
  }
  const chunks = [];
  let size = 0;
  for await (const v of r.stream) {
    size += v.length;
    if (size > PLAYLIST_MAX_BYTES) {
      r.stream.destroy();
      throw new Error("playlist too large");
    }
    chunks.push(Buffer.from(v));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getPlaylist(url) {
  const hit = playlistLRU.get(url);
  if (hit && Date.now() - hit.ts < PLAYLIST_TTL) return Promise.resolve(hit.body);
  const running = playlistInflight.get(url);
  if (running) return running;
  const job = upstreamText(url)
    .then((body) => playlistStore(url, body))
    .finally(() => playlistInflight.delete(url));
  playlistInflight.set(url, job);
  return job;
}

/* Every URI in a playlist becomes a handle of ours. A URI on a host we refuse to
 * talk to is dropped rather than passed through — a raw CDN URL in a playlist is
 * exactly the leak this design exists to prevent. */
function rewritePlaylistLine(line, baseUrl) {
  const t = line.trim();
  if (!t) return line;
  if (t.startsWith("#")) {
    return t.replace(/URI="([^"]+)"/g, (m, u) => {
      try {
        const proxied = secure.proxyMediaUrl(new URL(u, baseUrl).href);
        return proxied ? 'URI="' + proxied + '"' : "";
      } catch (e) { return m; }
    });
  }
  try {
    return secure.proxyMediaUrl(new URL(t, baseUrl).href);
  } catch (e) { return line; }
}

function rewritePlaylist(body, baseUrl) {
  return body.split("\n").map((l) => rewritePlaylistLine(l, baseUrl)).join("\n");
}

const MEDIA_CT = /^(video\/|audio\/|application\/(octet-stream|mp4|ogg|mp2t|vnd\.apple\.mpegurl|x-mpegurl))/i;

app.get("/api/stream", streamLimit, streamConcurrency, async (req, res) => {
  const url = secure.readMediaToken(req.query.t);
  if (!url) return res.status(403).json({ error: "invalid stream handle" });
  res.set("Content-Security-Policy", BINARY_CSP);

  // Playlists are served whole whatever Range the client sends — some players
  // (Safari native HLS) ask for a playlist with Range, and a partial playlist
  // corrupts playback. Range matters only for media segments.
  if (/\.m3u8(\?|$)/i.test(url)) {
    try {
      const body = await getPlaylist(url);
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Cache-Control", "public, max-age=60");
      return res.send(rewritePlaylist(body, url));
    } catch (e) {
      return res.status(502).json({ error: "playlist unavailable" });
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
  if (!upstream) return res.status(502).json({ error: "stream unavailable" });

  const ctype = String(upstream.headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase();

  // A playlist under a non-.m3u8 name still needs rewriting; a ranged request for
  // one cannot be rewritten safely, so refuse instead of corrupting it.
  if (/mpegurl/i.test(ctype)) {
    // Same rule as the fast path: ignore Range, serve the whole playlist.
    const chunks = [];
    let size = 0;
    try {
      for await (const v of upstream.stream) {
        size += v.length;
        if (size > PLAYLIST_MAX_BYTES) throw new Error("playlist too large");
        chunks.push(Buffer.from(v));
      }
    } catch (e) {
      return res.status(502).json({ error: "playlist unavailable" });
    }
    const body = Buffer.concat(chunks).toString("utf8");
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "public, max-age=60");
    return res.send(rewritePlaylist(body, url));
  }

  /* Never relay a document. `xhamster.com` used to be in the allowlist, which
   * turned /api/stream into same-origin HTML injection for any page on their
   * site (and for anything user-uploaded on their CDN). */
  if (!MEDIA_CT.test(ctype)) {
    upstream.stream.destroy();
    return res.status(415).json({ error: "upstream content type not allowed" });
  }

  res.set("Accept-Ranges", "bytes");
  if (upstream.headers["content-range"]) {
    res.status(206);
    res.set("Content-Range", upstream.headers["content-range"]);
  }
  const cl = upstream.headers["content-length"];
  if (cl) res.set("Content-Length", cl);
  res.set("Content-Type", ctype);
  res.set("Cache-Control", "public, max-age=3600");

  // A closed tab must not leave the upstream socket pulling bytes for nobody.
  res.on("close", () => { try { upstream.stream.destroy(); } catch (e) { /* ignore */ } });
  upstream.stream.pipe(res);
  upstream.stream.on("error", () => { try { res.destroy(); } catch (e) { /* ignore */ } });
});

/* ================================ JSON API ================================ */
const VOLATILE_KEYS = new Set(["thumb", "previewThumb", "sprite", "trailer", "t", "stream"]);
function hashable(value, depth) {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => hashable(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = VOLATILE_KEYS.has(k) && typeof value[k] === "string" ? "" : hashable(value[k], depth + 1);
  }
  return out;
}

function json(res, payload) {
  // Cache-Control: enable browser caching so repeat views hit browser cache,
  // not the server — exactly like a normal browser.
  res.set("Cache-Control", "public, max-age=30, must-revalidate");

  // OUR OWN validator (xHamster sends none). A repeat view then costs one 304
  // instead of the whole JSON body: same page, a few hundred bytes on the wire.
  //
  // The handle fields are re-minted on every response (fresh IV/expiry), so they
  // are masked before hashing — otherwise the ETag would change on every request
  // and no client could ever revalidate. Masking is safe: a 304 tells the client
  // "keep what you have", and a handle stays valid for hours, far longer than any
  // max-age we send.
  const body = JSON.stringify(payload);
  const stable = JSON.stringify(hashable(payload, 0));
  const etag = 'W/"' + require("crypto").createHash("sha1").update(stable).digest("base64url").slice(0, 27) + '"';
  res.set("ETag", etag);
  const inm = (res.req && res.req.headers && res.req.headers["if-none-match"]) || "";
  if (inm && inm.split(",").some((t) => t.trim() === etag)) {
    res.status(304).end();
    return;
  }
  res.type("application/json; charset=utf-8").send(body);
}

/* Cards leave this process with handles, never with CDN URLs. Everything the
 * client needs is in `thumb` / `previewThumb` / `sprite` / `trailer`. */
function exposeCard(v) {
  if (!v || typeof v !== "object") return v;
  return {
    ...v,
    thumb: secure.proxyThumbUrl(v.thumb),
    previewThumb: secure.proxyThumbUrl(v.previewThumb),
    sprite: secure.proxyThumbUrl(v.sprite),
    trailer: secure.proxyMediaUrl(v.trailer),
  };
}

function exposeCards(list) {
  return Array.isArray(list) ? list.map(exposeCard) : [];
}

app.get("/api/feed", listingLimit, async (req, res) => {
  try {
    const result = await data.feed({
      tab: String(req.query.tab || "newest").toLowerCase(),
      page: req.query.page,
      priority: 0,
    });
    json(res, { success: true, ...result, videos: exposeCards(result.videos) });
  } catch (e) { fail(res, e); }
});

app.get("/api/category/:slug", listingLimit, async (req, res) => {
  try {
    const result = await data.category({ slug: req.params.slug, page: req.query.page, priority: 0 });
    json(res, { success: true, ...result, videos: exposeCards(result.videos) });
  } catch (e) { fail(res, e); }
});

app.get("/api/search", listingLimit, async (req, res) => {
  try {
    const result = await data.search({ q: req.query.q, page: req.query.page, priority: 0 });
    json(res, { success: true, ...result, videos: exposeCards(result.videos) });
  } catch (e) { fail(res, e); }
});

app.get("/api/suggest", suggestLimit, async (req, res) => {
  try {
    json(res, { success: true, suggestions: await data.suggest(req.query.q) });
  } catch (e) {
    // Suggestions are additive — the search box works without them.
    json(res, { success: false, suggestions: [] });
  }
});

// The click path: one upstream page → title, views, tags, stream and related
// videos. No cache hit needed, no prefetch — this IS the resolve.
app.get("/api/watch/:slug", watchLimit, async (req, res) => {
  try {
    let result = await data.watch({ slug: req.params.slug });
    // The player is about to ask for this exact master playlist. Loading it here
    // (single-flight, so the player's request joins instead of duplicating) is
    // the same preload xhamster's own page does with <link rel=preload as=fetch>.
    // Only the clicked video's manifest — never a video the user did not open.
    //
    // A cached watch page can hold a stream signature that has since expired.
    // Verify the playlist is alive (4s cap, so a slow upstream cannot wedge the
    // response — a still-running fetch is joined by the player anyway). If it
    // is dead, drop the cached page and refetch once for a fresh signature
    // instead of handing the player a dead link.
    if (result.stream) {
      try {
        await Promise.race([
          getPlaylist(result.stream.url),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
      } catch (e) {
        const slug = result.slug || req.params.slug;
        if (slug && data.forgetWatch(slug)) {
          const fresh = await data.watch({ slug }).catch(() => null);
          if (fresh && fresh.stream) {
            result = fresh;
            getPlaylist(result.stream.url).catch(() => {});
          }
        }
      }
    }

    const streamUrl = result.stream ? secure.proxyMediaUrl(result.stream.url) : "";
    json(res, {
      ...result,
      video: result.video ? { ...result.video, thumb: secure.proxyThumbUrl(result.video.thumb) } : result.video,
      stream: streamUrl ? { ...result.stream, url: streamUrl } : null,
      unsupported: result.unsupported || (!!result.stream && !streamUrl),
      related: exposeCards(result.related),
      success: true,
    });
  } catch (e) { fail(res, e); }
});

// Compatibility: resolve from a full page URL.
app.get("/api/stream-url", resolveLimit, async (req, res) => {
  try {
    const raw = String(req.query.url || "");
    const slug = slugFromPageUrl(raw) || raw.replace(/^.*\/videos\//, "");
    if (!slug) return res.status(400).json({ success: false, error: "url required" });
    const result = await data.watch({ slug });
    const streamUrl = result.stream ? secure.proxyMediaUrl(result.stream.url) : "";
    json(res, {
      success: !!streamUrl,
      unsupported: result.unsupported,
      m3u8Url: streamUrl || null,
      cached: result.cached,
    });
  } catch (e) { fail(res, e); }
});

app.get("/api/categories", (req, res) => {
  json(res, { success: true, ...data.categoryTree() });
});

/* Full internals (mirror health, cookie jar, token bucket) describe exactly when
 * this box is weak, so only a loopback operator gets them. */
function isLoopback(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || "");
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

app.get("/api/stats", (req, res) => {
  const base = {
    success: true,
    uptime: Math.round(process.uptime()),
    cachedThumbs: thumbLRU.size,
    cachedPlaylists: playlistLRU.size,
    stalePages: data.staleSize(),
  };
  if (!isLoopback(req)) return json(res, base);
  json(res, {
    ...base,
    ...data.stats,
    hosts: poolStatus(),
    upstream: jarStatus(),
    budget: guard.budgetStatus(),
    egress: egress.status(),
    auth: { enabled: auth.ENABLED },
  });
});

app.get("/api/health", (req, res) => {
  json(res, {
    status: "ok",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    shared: shared.getMode(),
    budget: guard.budgetStatus(),
    breaker: shared.breakerStatus(),
  });
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
// Cluster state first: with REDIS_URL set, replicas share page cache, the
// adaptive upstream budget and host cooldowns — scaling replicas can then
// only grow capacity, never multiply upstream pressure.
let server;
(async () => {
  await shared.init();
  try { await hydrateHealth(); } catch (e) { /* disk fallback already ran */ }
  server = app.listen(PORT, () => {
    const cats = data.categoryTree();
    console.log("TubeStream listening on http://localhost:" + PORT);
    console.log("[Categories]", cats.total, "in", cats.groups.length, "groups");
    console.log("[Mode] on-demand only — no prefetch, no warm queue; sealed media handles");
    console.log("[Scale] shared state:", shared.getMode(), "— public by default; ACCESS_CODES unset = no invite gate");
    if (auth.ENABLED) console.log("[Auth] invite-only mode — " + "codes configured");
  });
  server.keepAliveTimeout = 70000;
  server.headersTimeout = 72000;
})().catch((e) => {
  console.error("[boot] shared init failed:", e.message);
  process.exit(1);
});

function shutdown(signal) {
  console.log("\n[" + signal + "] shutting down…");
  // Persist the last-good pages so a restart during an upstream block still boots warm.
  try { data.flushToDisk(); } catch (e) { /* best effort */ }
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
