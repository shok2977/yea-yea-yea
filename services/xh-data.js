/* xh-data.js — on-demand data layer.
 *
 * Every function here performs ONE upstream page fetch when asked, and memoises
 * the parsed result for a short TTL. Nothing is resolved ahead of a request:
 * no warm queue, no pool building, no next-page prefetch. The only sharing is
 * single-flight dedupe (two callers asking for the same page at the same moment
 * get one upstream fetch), which is what xhamster's own SPA does.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fetchPage, parseListing, parseVideoPage, SITE } = require("./xh-core");
const { xhSuggest } = require("./xh-fetch");
const { takeUpstream } = require("./guard");
const shared = require("./shared");

const LISTING_TTL_MS = 3 * 60 * 1000;   // listings change constantly
// Stream tokens stay valid for hours (the `end=` epoch in the m3u8 URL), so a
// 45-minute window means re-opening a video — by any number of users — costs
// upstream nothing. Higher TTL here = fewer requests to their servers.
const WATCH_TTL_MS = 45 * 60 * 1000;
const STREAM_REPLAY_TTL_MS = 2 * 60 * 60 * 1000;  // < token lifetime (~4h)
const SUGGEST_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 400;

const cache = new Map();      // key -> { ts, ttl, value }
const inflight = new Map();   // key -> Promise

/* Last-known-good copy of every page we have ever served. If upstream starts
 * refusing us (403/429/block page) the site keeps rendering the previous render
 * instead of turning into an error screen. This is the difference between "our
 * scraper broke" and "our site broke". */
const stale = new Map();      // key -> { ts, value }
const STALE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_STALE = 400;

/* The in-memory stale map dies with the process — which is exactly the moment
 * you need it most (crash/restart while upstream is refusing us). So every page
 * we serve is also snapshotted to disk and re-hydrated on boot: after a restart
 * with every mirror unreachable, the site still renders what it last knew.
 */
const CACHE_DIR = path.join(__dirname, "..", ".cache");
const PAGE_CACHE_FILE = path.join(CACHE_DIR, "page-cache.json");
const DISK_MAX_ENTRIES = 120;
const DISK_MAX_BYTES = 8 * 1024 * 1024;
const FLUSH_DEBOUNCE_MS = 2500;

const stats = {
  listingHits: 0, listingMisses: 0, watchHits: 0, watchMisses: 0,
  upstreamPages: 0, staleServes: 0, swrServes: 0, refreshFailures: 0,
  revalidated: 0, unchanged: 0,
};

function remember(key, value, ttlMs, staleTtlMs, validators) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const now = Date.now();
  const etag = (validators && validators.etag) || "";
  const lastModified = (validators && validators.lastModified) || "";
  const hash = (validators && validators.hash) || "";
  const cacheControl = (validators && validators.cacheControl) || "";
  cache.set(key, { ts: now, ttl: ttlMs, value });
  if (stale.size >= MAX_STALE) {
    const oldest = stale.keys().next().value;
    if (oldest !== undefined) stale.delete(oldest);
  }
  stale.delete(key);
  // etag/lastModified ride along with the entry: they are what turns the next
  // refresh into a conditional GET (304, no body) instead of a full download.
  stale.set(key, { ts: now, value, staleTtl: staleTtlMs || STALE_TTL_MS, etag, lastModified, hash, cacheControl });
  // Cluster L2: replicas share this entry. Fire-and-forget, never blocks.
  shared.pageSet(key, {
    ts: now, ttl: ttlMs, value, staleTtl: staleTtlMs || STALE_TTL_MS, etag, lastModified, hash, cacheControl,
  });
  scheduleFlush();
}

function entryStaleTtl(entry) {
  return (entry && entry.staleTtl) || STALE_TTL_MS;
}

function staleEntry(key) {
  const hit = stale.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > entryStaleTtl(hit)) { stale.delete(key); return null; }
  return hit;
}

function recallStale(key) {
  const hit = staleEntry(key);
  return hit ? hit.value : null;
}

/** Stale entry (with HTTP validators) from the cluster L2, if this replica does
 *  not hold one itself. */
async function staleEntryShared(key) {
  const e = await shared.pageStaleGet(key, true);
  return e && e.value
    ? { ts: 0, value: e.value, etag: e.etag, lastModified: e.lastModified, hash: e.hash }
    : null;
}

/* xHamster sends neither ETag nor Last-Modified (verified live), so conditional
 * GETs cannot save bytes there. These two helpers are the equivalent we control:
 * a content hash (did the bytes change?) and the page's own Cache-Control
 * max-age (how long may we hold it?) instead of a hard-coded guess. */
function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

const MAX_TTL_MS = 30 * 60 * 1000;
function ttlFor(res, fallback) {
  const cc = String((res && res.cacheControl) || "");
  const m = cc.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  if (!m) return fallback;
  const ms = Number(m[1]) * 1000;
  return ms > 0 ? Math.min(MAX_TTL_MS, ms) : fallback;
}

/* ---------- durable snapshot (survives restart while upstream is blocked) ---------- */
let flushTimer = null;
let flushing = false;

function hydrateFromDisk() {
  try {
    if (!fs.existsSync(PAGE_CACHE_FILE)) return;
    const raw = fs.readFileSync(PAGE_CACHE_FILE, "utf8");
    if (!raw || raw.length > DISK_MAX_BYTES) return;
    const obj = JSON.parse(raw);
    const now = Date.now();
    let loaded = 0;
    for (const key of Object.keys(obj || {})) {
      const entry = obj[key];
      if (!entry || !entry.value || !entry.ts) continue;
      const ttl = (entry.staleTtl || STALE_TTL_MS);
      if (now - entry.ts > ttl) continue;
      stale.set(key, {
        ts: entry.ts, value: entry.value, staleTtl: ttl,
        etag: entry.etag || "", lastModified: entry.lastModified || "", hash: entry.hash || "",
      });
      loaded++;
    }
    if (loaded) console.log("[data] hydrated " + loaded + " cached pages from disk");
  } catch (e) {
    console.warn("[data] page cache read failed:", e.message);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushToDisk, FLUSH_DEBOUNCE_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function flushToDisk() {
  flushTimer = null;
  if (flushing) { scheduleFlush(); return; }
  flushing = true;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const now = Date.now();
    const keys = [...stale.keys()].slice(-DISK_MAX_ENTRIES);
    const out = {};
    for (const key of keys) {
      const entry = stale.get(key);
      if (!entry || now - entry.ts > entryStaleTtl(entry)) continue;
      out[key] = entry;
    }
    const json = JSON.stringify(out);
    if (json.length > DISK_MAX_BYTES) return;
    const tmp = PAGE_CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, PAGE_CACHE_FILE);   // atomic: never a half-written cache
  } catch (e) {
    console.warn("[data] page cache write failed:", e.message);
  } finally {
    flushing = false;
  }
}

function recall(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > hit.ttl) { cache.delete(key); return null; }
  cache.delete(key);          // refresh recency
  cache.set(key, hit);
  return hit.value;
}

/** L2 fresh lookup (cluster). Returns a value or null; populates L1. */
async function recallShared(key) {
  const v = await shared.pageGet(key);
  if (!v) return null;
  // Rehydrate L1 so later hits on this replica are local.
  cache.set(key, { ts: Date.now(), ttl: 60 * 1000, value: v });
  return v;
}

/** L2 stale lookup (cluster). */
async function recallStaleShared(key) {
  return shared.pageStaleGet(key);
}

async function singleFlight(key, work) {
  const running = inflight.get(key);
  if (running) return running;
  const p = work().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ---------- feed tabs (mirror xhamster's own URLs) ----------
 * Only paths that answer 200 on the direct connection are listed here
 * (/best/year, /best/longest and /best/today 404 upstream on this edge).
 */
const FEEDS = {
  newest:     { label: "Newest",           base: "/newest" },
  hot:        { label: "Trending today",   base: "/best/daily" },
  popular:    { label: "Best of the week", base: "/best/weekly" },
  top:        { label: "Best of the month", base: "/best/monthly" },
  mostviewed: { label: "Most viewed",      base: "/most-viewed" },
};

const PERIODS = {
  daily: "hot", today: "hot", week: "popular", weekly: "popular",
  month: "top", monthly: "top", "most-viewed": "mostviewed",
};

function pagePath(base, page) {
  return page > 1 ? base + "/" + page : base;
}

function clampPage(page) {
  const n = parseInt(page, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 1;
}

/* ---------- categories ---------- */
let categoryMap = null;        // slug -> { slug, url, label }
let categoryByKey = null;      // our short key -> info

function loadCategories() {
  if (categoryMap) return categoryMap;
  categoryMap = {};
  categoryByKey = {};
  try {
    const file = path.join(__dirname, "..", "categories-map.json");
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [key, info] of Object.entries(raw)) {
        const slug = (info && info.slug) || key;
        const label = (info && info.label) || key.replace(/-/g, " ");
        categoryMap[slug] = { slug, label, url: (info && info.url) || SITE + "/categories/" + slug };
        categoryByKey[key] = categoryMap[slug];
      }
    }
  } catch (e) {
    console.warn("[Categories] load failed:", e.message);
  }
  return categoryMap;
}

function categoryInfo(slug) {
  const map = loadCategories();
  return map[slug] || { slug, label: slug.replace(/-/g, " "), url: SITE + "/categories/" + slug };
}

// Groups for the sidebar — same slug-keyword heuristic the site used before,
// but computed once and never touching the network.
const GROUPS = [
  ["Types", ["amateur", "homemade", "hardcore", "softcore", "hentai", "cartoon", "retro", "vintage", "webcam", "animation", "3d", "gonzo", "pov", "compilation", "jav", "erotic", "joi"]],
  ["Actions", ["anal", "blowjob", "cumshot", "handjob", "massage", "masturbation", "threesome", "gangbang", "orgy", "doggystyle", "cowgirl", "missionary", "riding", "facial", "deepthroat", "creampie", "squirting", "striptease", "footjob", "fingering", "cunnilingus", "69", "oral", "titfuck", "fisting"]],
  ["Body", ["big-ass", "big-tits", "big-cock", "small-tits", "hairy", "chubby", "petite", "bbw", "skinny", "muscular", "tattoo", "piercing", "nipples", "tits", "legs", "nude", "beauty", "flexible", "pawg", "fake-tits"]],
  ["Ethnicity", ["asian", "latina", "black", "european", "arab", "desi", "japanese", "korean", "indian", "german", "french", "russian", "brazilian", "thai", "african", "american", "interracial", "mexican", "filipina", "turkish", "chinese", "vietnamese", "indonesian", "pakistani", "bangladeshi", "nepali", "persian", "italian", "spanish", "british", "polish", "czech"]],
  ["Age", ["milf", "teen", "mature", "granny", "cougar", "old-young", "young", "old-man"]],
  ["Hair", ["blonde", "brunette", "redhead", "colored-hair", "long-hair", "short-hair"]],
  ["Fetish", ["bdsm", "bondage", "domination", "femdom", "fetish", "humiliation", "oiled", "pissing", "spanking", "chastity", "sissy", "submissive", "foot-worship", "face-fetish", "latex", "smoking", "wrestling"]],
  ["Clothing", ["lingerie", "stockings", "uniform", "bikini", "leather", "high-heels", "nylon", "fishnet", "pantyhose", "panties", "thong", "bra", "gloves", "masked"]],
  ["Scenarios", ["cosplay", "boss", "teacher", "nurse", "maid", "babysitter", "secretary", "doctor", "police", "cheating", "cuckold", "casting", "celebrity", "parody", "neighbor", "stranger", "stuck", "twins", "nun", "cheerleader", "gamer-girl", "girlfriend", "housewife", "voyeur", "public-nudity", "romantic", "swingers"]],
  ["Location", ["outdoor", "public", "bathroom", "beach", "car", "hotel", "kitchen", "office", "pool", "shower", "gym", "forest", "prison", "taxi", "bus", "train", "sauna", "hospital", "college", "camping"]],
];

let treeCache = null;
function categoryTree() {
  if (treeCache) return treeCache;
  const map = loadCategories();
  const slugs = Object.keys(map);
  const used = new Set();
  const groups = [];
  for (const [name, keywords] of GROUPS) {
    const items = [];
    for (const slug of slugs) {
      if (used.has(slug)) continue;
      if (!keywords.some((kw) => slug === kw || slug.includes(kw))) continue;
      items.push({ slug, label: map[slug].label });
      used.add(slug);
    }
    if (items.length) groups.push({ name, items });
  }
  const rest = slugs.filter((s) => !used.has(s)).map((s) => ({ slug: s, label: map[s].label }));
  if (rest.length) groups.push({ name: "All categories", items: rest });
  treeCache = { groups, total: slugs.length };
  return treeCache;
}

/* ---------- listings ---------- */
/* One upstream fetch + parse. Only ever called inside singleFlight(), so any
 * number of visitors asking for the same page at the same moment still costs
 * exactly one upstream request. */
async function fetchListing({ url, cacheKey, page, priority }) {
    stats.listingMisses++;
    const prevEntry = staleEntry(cacheKey) || (await staleEntryShared(cacheKey));
    // Adaptive cluster budget on cache-missing page fetches. The budget starts
    // low and grows while upstream answers; when it runs dry the data layer
    // serves its stale copy (or a clean 503) instead of spending a request
    // that could push our egress into a block.
    if (!(await takeUpstream())) {
      if (prevEntry) { stats.staleServes++; return { ...prevEntry.value, cached: true, stale: true, busy: true }; }
      throw Object.assign(new Error("busy — upstream budget exhausted, retry shortly"), { status: 503, retryAfter: 5000 });
    }
    stats.upstreamPages++;
    try {
      // Conditional GET: if we already parsed this page, ask whether it changed.
      // 304 = no body, no parse, and upstream barely sees the request.
      const res = await fetchPage(url, {
        priority: priority === 0 ? 0 : 1,
        meta: true,
        validators: prevEntry ? { etag: prevEntry.etag, lastModified: prevEntry.lastModified } : null,
      });
      if (res.notModified && prevEntry) {
        remember(cacheKey, prevEntry.value, LISTING_TTL_MS, undefined, {
          etag: res.etag || prevEntry.etag,
          lastModified: res.lastModified || prevEntry.lastModified,
          hash: prevEntry.hash,
          cacheControl: res.cacheControl,
        });
        stats.revalidated++;
        return { ...prevEntry.value, cached: true, revalidated: true };
      }
      const html = res.html || "";
      const meta = {
        etag: res.etag,
        lastModified: res.lastModified,
        hash: sha1(html),
        cacheControl: res.cacheControl,
      };
      // Identical bytes to what we already parsed: refresh the clock and hand
      // back the parsed copy — no second parse, no cache rewrite storm.
      if (prevEntry && prevEntry.hash && prevEntry.hash === meta.hash) {
        remember(cacheKey, prevEntry.value, ttlFor(res, LISTING_TTL_MS), undefined, meta);
        stats.unchanged++;
        return { ...prevEntry.value, cached: true, unchanged: true };
      }
      const parsed = parseListing(html);
      const value = {
        videos: parsed.cards,
        page,
        lastPage: Math.max(parsed.lastPage, page),
        total: parsed.total,
      };
      if (value.videos.length) {
        remember(cacheKey, value, ttlFor(res, LISTING_TTL_MS), undefined, meta);
      }
      return { ...value, cached: false };
    } catch (e) {
      const prev = recallStale(cacheKey) || (await recallStaleShared(cacheKey));
      if (!prev) throw e;
      stats.staleServes++;
      console.warn("[data] upstream failed for", cacheKey, "— serving stale:", e.message);
      return { ...prev, cached: true, stale: true };
    }
}

async function listing({ url, key, page, priority }) {
  const cacheKey = key + ":" + page;
  const hit = recall(cacheKey) || (await recallShared(cacheKey));
  if (hit) { stats.listingHits++; return { ...hit, cached: true }; }

  /* Stale-while-revalidate. A page we have served before is returned
   * immediately and refreshed in the background, so a traffic spike never turns
   * into a queue of visitors waiting on upstream — and never into a burst of
   * upstream calls either (the refresh is single-flight, one per page).
   * While the breaker is open, takeUpstream() refuses, so the refresh quietly
   * does nothing and the cached copy keeps serving: no retries, no new refusals. */
  const prev = recallStale(cacheKey) || (await recallStaleShared(cacheKey));
  if (prev) {
    stats.swrServes++;
    singleFlight(cacheKey, () => fetchListing({ url, cacheKey, page, priority }))
      .catch(() => { stats.refreshFailures++; });
    return { ...prev, cached: true, stale: true, refreshing: true };
  }

  return singleFlight(cacheKey, () => fetchListing({ url, cacheKey, page, priority }));
}

function feed({ tab, page, priority }) {
  const key = FEEDS[tab] ? tab : "newest";
  const p = clampPage(page);
  return listing({ url: SITE + pagePath(FEEDS[key].base, p), key: "feed:" + key, page: p, priority })
    .then((r) => ({ ...r, tab: key, label: FEEDS[key].label }));
}

function category({ slug, page, priority }) {
  const clean = String(slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!clean) throw Object.assign(new Error("invalid category"), { status: 400 });
  const p = clampPage(page);
  const info = categoryInfo(clean);
  return listing({ url: SITE + "/categories/" + clean + (p > 1 ? "/" + p : ""), key: "cat:" + clean, page: p, priority })
    .then((r) => ({ ...r, slug: clean, label: info.label }));
}

function search({ q, page, priority }) {
  const keyword = String(q || "").trim().slice(0, 80);
  if (!keyword) throw Object.assign(new Error("q required"), { status: 400 });
  const p = clampPage(page);
  // Search pagination is query-based upstream (?page=N), unlike feeds/categories
  // which use path segments.
  return listing({
    url: SITE + "/search/" + encodeURIComponent(keyword) + (p > 1 ? "?page=" + p : ""),
    // Hash the query into the cache key: the on-disk snapshot must never become
    // a plaintext log of everything anyone searched for on this server.
    key: "search:" + crypto.createHash("sha1").update(keyword.toLowerCase()).digest("hex").slice(0, 24),
    page: p,
    priority,
  }).then((r) => ({ ...r, q: keyword }));
}

/* Drop one watch page from every cache layer (fresh, stale, L2). The cached
 * stream URL is a signed token: when it expires, /api/watch busts the entry
 * and the next watch() fetches a fresh signature. */
function forgetWatch(slug) {
  const clean = String(slug || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(clean) || clean.includes("..")) return false;
  const key = "watch:" + clean;
  cache.delete(key);
  stale.delete(key);
  shared.pageDel(key);
  return true;
}

/* ---------- watch (the click path) ---------- */
async function watch({ slug }) {
  const clean = String(slug || "").trim();
  // Reject rather than silently rewrite: the old sanitiser kept dots, so ".."
  // became a different upstream path (`/videos/..` normalises to `/`) than the
  // one the caller asked for, and arbitrary junk still cost an upstream fetch.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(clean) || clean.includes("..")) {
    throw Object.assign(new Error("invalid video"), { status: 400 });
  }
  const cacheKey = "watch:" + clean;
  const hit = recall(cacheKey) || (await recallShared(cacheKey));
  if (hit) { stats.watchHits++; return { ...hit, cached: true }; }

  // Same stale-while-revalidate rule as listings: the player opens instantly on
  // the last known stream and the page is refreshed in the background.
  const prev = recallStale(cacheKey) || (await recallStaleShared(cacheKey));
  if (prev) {
    stats.swrServes++;
    singleFlight(cacheKey, () => fetchWatch(clean, cacheKey)).catch(() => { stats.refreshFailures++; });
    return { ...prev, cached: true, stale: true, refreshing: true };
  }

  return singleFlight(cacheKey, () => fetchWatch(clean, cacheKey));
}

/* One upstream watch fetch + parse; single-flight and budget-gated like listings. */
async function fetchWatch(clean, cacheKey) {
    stats.watchMisses++;
    const prevEntry = staleEntry(cacheKey) || (await staleEntryShared(cacheKey));
    if (!(await takeUpstream())) {
      if (prevEntry) { stats.staleServes++; return { ...prevEntry.value, cached: true, stale: true, busy: true }; }
      throw Object.assign(new Error("busy — upstream budget exhausted, retry shortly"), { status: 503, retryAfter: 5000 });
    }
    stats.upstreamPages++;
    let res;
    try {
      res = await fetchPage(SITE + "/videos/" + clean, {
        priority: 0,
        meta: true,
        validators: prevEntry ? { etag: prevEntry.etag, lastModified: prevEntry.lastModified } : null,
      });
    } catch (e) {
      const prev = recallStale(cacheKey) || (await recallStaleShared(cacheKey));
      if (!prev) throw e;
      stats.staleServes++;
      console.warn("[data] upstream failed for", cacheKey, "— serving stale:", e.message);
      return { ...prev, cached: true, stale: true };
    }
    // 304: the stream page is unchanged, so the signed playlist we already hold
    // is still good. Extend its replay window instead of re-downloading it.
    if (res.notModified && prevEntry) {
      remember(cacheKey, prevEntry.value, WATCH_TTL_MS, STREAM_REPLAY_TTL_MS, {
        etag: res.etag || prevEntry.etag,
        lastModified: res.lastModified || prevEntry.lastModified,
        hash: prevEntry.hash,
        cacheControl: res.cacheControl,
      });
      stats.revalidated++;
      return { ...prevEntry.value, cached: true, revalidated: true };
    }
    const html = res.html || "";
    const meta = {
      etag: res.etag,
      lastModified: res.lastModified,
      hash: sha1(html),
      cacheControl: res.cacheControl,
    };
    if (prevEntry && prevEntry.hash && prevEntry.hash === meta.hash) {
      remember(cacheKey, prevEntry.value, ttlFor(res, WATCH_TTL_MS), STREAM_REPLAY_TTL_MS, meta);
      stats.unchanged++;
      return { ...prevEntry.value, cached: true, unchanged: true };
    }
    const parsed = parseVideoPage(html);
    // A page that parsed to nothing is a missing/removed video, not a stream we
    // can show — answer 404 so the client can say so plainly.
    if (!parsed.stream && !parsed.unsupported && !parsed.video.title) {
      throw Object.assign(new Error("video not found"), { status: 404 });
    }
    const value = {
      slug: clean,
      pageUrl: SITE + "/videos/" + clean,
      video: parsed.video,
      stream: parsed.stream,
      related: parsed.related.slice(0, 24),
      unsupported: parsed.unsupported,
    };
    // Cache only real results. The stream URL is a signed token that outlives a
    // few hours but not six, so a watch entry may only be replayed while its
    // signature is still valid — otherwise a blocked upstream would serve a dead
    // player instead of an honest error.
    if (value.stream || value.unsupported) {
      remember(cacheKey, value, WATCH_TTL_MS, STREAM_REPLAY_TTL_MS, meta);
    }
    return { ...value, cached: false };
}

/* ---------- suggestions ---------- */
const suggestCache = new Map();
const suggestInflight = new Map();

async function suggest(q) {
  const clean = String(q || "").trim().slice(0, 50);
  if (clean.length < 2) return [];
  const key = clean.toLowerCase();
  const hit = suggestCache.get(key);
  if (hit && Date.now() - hit.ts < SUGGEST_TTL_MS) return hit.items;
  // Two people typing the same prefix at the same moment must be one upstream
  // call, not two.
  const running = suggestInflight.get(key);
  if (running) return running;
  // Suggestions are the least valuable upstream call: never spend the last of
  // the budget, and never spend any of it while cooldown is active.
  if (!(await takeUpstream())) return [];
  const job = xhSuggest(clean)
    .then((items) => {
      suggestCache.set(key, { ts: Date.now(), items });
      if (suggestCache.size > 150) {
        const oldest = suggestCache.keys().next().value;
        if (oldest !== undefined) suggestCache.delete(oldest);
      }
      return items;
    })
    .finally(() => suggestInflight.delete(key));
  suggestInflight.set(key, job);
  return job;
}

hydrateFromDisk();

module.exports = {
  FEEDS,
  PERIODS,
  feed,
  category,
  search,
  watch,
  forgetWatch,
  suggest,
  categoryTree,
  categoryInfo,
  stats,
  staleSize: () => stale.size,
  flushToDisk,
  STALE_TTL_MS,
};
