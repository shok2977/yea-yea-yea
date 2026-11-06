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
const { fetchPage, parseListing, parseVideoPage, SITE } = require("./xh-core");
const { xhSuggest } = require("./xh-fetch");

const LISTING_TTL_MS = 3 * 60 * 1000;   // listings change constantly
const WATCH_TTL_MS = 15 * 60 * 1000;    // stream tokens live for hours
const SUGGEST_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 400;

const cache = new Map();      // key -> { ts, value }
const inflight = new Map();   // key -> Promise

const stats = { listingHits: 0, listingMisses: 0, watchHits: 0, watchMisses: 0, upstreamPages: 0 };

function remember(key, value, ttlMs) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), ttl: ttlMs, value });
}

function recall(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > hit.ttl) { cache.delete(key); return null; }
  cache.delete(key);          // refresh recency
  cache.set(key, hit);
  return hit.value;
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
async function listing({ url, key, page, priority }) {
  const cacheKey = key + ":" + page;
  const hit = recall(cacheKey);
  if (hit) { stats.listingHits++; return { ...hit, cached: true }; }

  return singleFlight(cacheKey, async () => {
    stats.listingMisses++;
    stats.upstreamPages++;
    const html = await fetchPage(url, { priority: priority === 0 ? 0 : 1 });
    const parsed = parseListing(html);
    const value = {
      videos: parsed.cards,
      page,
      lastPage: Math.max(parsed.lastPage, page),
      total: parsed.total,
    };
    if (value.videos.length) remember(cacheKey, value, LISTING_TTL_MS);
    return { ...value, cached: false };
  });
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
    key: "search:" + keyword.toLowerCase(),
    page: p,
    priority,
  }).then((r) => ({ ...r, q: keyword }));
}

/* ---------- watch (the click path) ---------- */
async function watch({ slug }) {
  const clean = String(slug || "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!clean) throw Object.assign(new Error("invalid video"), { status: 400 });
  const cacheKey = "watch:" + clean;
  const hit = recall(cacheKey);
  if (hit) { stats.watchHits++; return { ...hit, cached: true }; }

  return singleFlight(cacheKey, async () => {
    stats.watchMisses++;
    stats.upstreamPages++;
    const html = await fetchPage(SITE + "/videos/" + clean, { priority: 0 });
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
    // Cache only real results; a video's stream token stays valid for hours so
    // re-opening it (or the browser retrying) is instant.
    if (value.stream || value.unsupported) remember(cacheKey, value, WATCH_TTL_MS);
    return { ...value, cached: false };
  });
}

/* ---------- suggestions ---------- */
const suggestCache = new Map();
async function suggest(q) {
  const clean = String(q || "").trim().slice(0, 50);
  if (clean.length < 2) return [];
  const key = clean.toLowerCase();
  const hit = suggestCache.get(key);
  if (hit && Date.now() - hit.ts < SUGGEST_TTL_MS) return hit.items;
  const items = await xhSuggest(clean);
  suggestCache.set(key, { ts: Date.now(), items });
  if (suggestCache.size > 150) {
    const oldest = suggestCache.keys().next().value;
    if (oldest !== undefined) suggestCache.delete(oldest);
  }
  return items;
}

module.exports = {
  FEEDS,
  PERIODS,
  feed,
  category,
  search,
  watch,
  suggest,
  categoryTree,
  categoryInfo,
  stats,
};
