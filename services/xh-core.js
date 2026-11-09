/* xh-core.js — the "xhamster API" layer.
 *
 * There is no public listing JSON endpoint (proven in xhamster-hidden-api-report.md
 * §6b/§10a: /api/front/videos, /newest.json, /api/v2/videos … all 404). The real
 * API is the SSR payload each page ships in `window.initials` — 46 cards per
 * listing page plus pagination, and the full video model + player sources on a
 * video page. So we fetch the page once, directly (DoH-pinned, report §3), and
 * parse that payload. That is the same data xhamster's own SPA uses.
 *
 * Nothing in here prefetches or warms anything: every call is one upstream page.
 */
const { execFile } = require("child_process");
const { xhFetchText } = require("./xh-fetch");
const { unmask, looksHexMasked } = require("./xh-decrypt");

const SITE = "https://xhamster.com";
const RELAY_BASE = "https://r.jina.ai/";
/* Third-party render relay. Disabled by default: it is handed the exact URL the
 * visitor asked for (search terms included), it makes the request from its own
 * address, and it cannot be trusted to keep either secret. XH_RELAY=1 opts in. */
const RELAY_ENABLED = process.env.XH_RELAY === "1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/* ---------- helpers ---------- */
function fullUrl(pageUrl) {
  if (!pageUrl) return "";
  if (/^https?:\/\//i.test(pageUrl)) return pageUrl;
  return SITE + (pageUrl.startsWith("/") ? pageUrl : "/" + pageUrl);
}

// SSR payload must be present. Video pages additionally need either a stream or
// the VR marker (VR ships no HLS at all — detecting it early retires the click
// instead of waiting out a timeout).
function isValidHtml(html) {
  return typeof html === "string" && html.length > 5000 && html.includes("window.initials");
}

function curlText(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      args,
      { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(new Error("curl: " + (err.message || err))) : resolve(stdout))
    );
  });
}

/* ---------- page fetch: direct first, relay only as fallback ---------- */
async function fetchViaRelay(url, timeoutSec) {
  const html = await curlText(
    ["-s", "--max-time", String(timeoutSec || 9), "-H", "X-Respond-With: html", RELAY_BASE + url],
    (timeoutSec || 9) * 1000 + 2000
  );
  if (!isValidHtml(html)) throw new Error("relay: invalid render");
  return html;
}

/**
 * Fetch one xhamster page and return its HTML.
 * priority 0 = the user is waiting (click / search), 1 = page-level background.
 */
async function fetchPage(url, opts) {
  const priority = opts && opts.priority === 0 ? 0 : 1;
  const timeoutMs = (opts && opts.timeoutMs) || 7000;
  const meta = !!(opts && opts.meta);
  const validators = (opts && opts.validators) || null;
  // meta callers get { notModified, html, etag, lastModified } so the data layer
  // can keep HTTP validators and revalidate instead of re-downloading.
  const shape = (html, res) => (meta
    ? {
        notModified: false, html,
        etag: (res && res.etag) || "",
        lastModified: (res && res.lastModified) || "",
        cacheControl: (res && res.cacheControl) || "",
      }
    : html);

  const started = Date.now();

  // 1) Direct DoH-pinned connection through the mirror pool (0.9–1.5s vs relay
  // 3–9s). `validate` lets the pool reject a 200 that is really a block page and
  // fail over to the next host instead of handing garbage to the parser.
  // Transient ECONNRESET / 520 happen on the edge, so try twice before paying
  // the mirror's ~3.5s — one extra 1.2s attempt is cheaper than a relay render.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await xhFetchText(url, { timeoutMs, priority, validate: isValidHtml, validators, meta });
      // 304: our parsed copy is still current. Nothing downloaded, nothing parsed.
      if (meta && res && res.notModified) {
        return {
          notModified: true,
          html: null,
          etag: res.etag || (validators && validators.etag) || "",
          lastModified: res.lastModified || (validators && validators.lastModified) || "",
          cacheControl: res.cacheControl || "",
        };
      }
      const html = meta ? res.body : res;
      if (isValidHtml(html)) {
        const ms = Date.now() - started;
        if (ms > 2000) console.log("[xh] direct slow", ms + "ms", url.slice(-60));
        return shape(html, res);
      }
      console.warn("[xh] direct invalid payload", url.slice(-60));
      break;
    } catch (e) {
      console.warn("[xh] direct attempt", attempt + 1, "failed:", e.message, url.slice(-60));
      // The pool already walked its whole mirror list inside this call; retrying
      // from here would multiply the wait by the number of hosts for nothing.
      if (e && e.directFailed) break;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
  }

  // 2) Third-party render relay — opt-in only. Off by default so a blocked
  // upstream degrades to the stale cache instead of leaking what was asked for.
  if (!RELAY_ENABLED) {
    throw Object.assign(new Error("upstream blocked (third-party relay disabled)"), { status: 502 });
  }

  // 3) Relay, then one sequential retry (transient 502/520 happen upstream).
  try {
    const html = await fetchViaRelay(url, 9);
    console.log("[xh] served via relay in", Date.now() - started + "ms", url.slice(-60));
    return shape(html, null);
  } catch (e) {
    return shape(await fetchViaRelay(url, 10), null);
  }
}

/* ---------- window.initials parser ---------- */
function parseInitials(html) {
  if (typeof html !== "string") return null;
  const marker = "window.initials";
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const eqIdx = html.indexOf("=", idx + marker.length);
  if (eqIdx === -1) return null;
  const start = html.indexOf("{", eqIdx);
  if (start === -1 || start - eqIdx > 5) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length && i < start + 5000000; i++) {
    const c = html.charCodeAt(i);
    if (esc) { esc = false; continue; }
    if (c === 92 && inStr) { esc = true; continue; }
    if (c === 34) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/* ---------- stream extraction ---------- */
// Primary: the SSR <link rel="preload" as="fetch"> that carries the master m3u8.
// Fallback: xplayerSettings.sources.hls.h264 (hex-masked → unmask locally, ~0ms).
function extractStream(html) {
  const linkPatterns = [
    /<link\b[^>]*href="(https?:\/\/[^"]+?\.m3u8[^"]*)"[^>]*as="fetch"[^>]*>/i,
    /<link\b[^>]*as="fetch"[^>]*href="(https?:\/\/[^"]+?\.m3u8[^"]*)"[^>]*>/i,
    /<link\b[^>]*href="(https?:\/\/[^"]+?\.m3u8[^"]*)"[^>]*>/i,
  ];
  for (const pat of linkPatterns) {
    const m = pat.exec(html);
    if (m && m[1]) return { url: m[1], source: "preload" };
  }
  const initials = parseInitials(html);
  if (initials) {
    const ps = initials.xplayerSettings || {};
    const vm = initials.videoModel || {};
    const hls = ps.sources && ps.sources.hls && (ps.sources.hls.h264 || ps.sources.hls);
    if (hls) {
      const cands = Array.isArray(hls)
        ? hls.flatMap((g) => [g && g.url, g && g.fallback])
        : [hls.url, hls.fallback];
      for (const cand of cands) {
        if (!cand) continue;
        const masked = looksHexMasked(cand);
        const real = masked ? unmask(cand) : cand;
        if (real && /\.m3u8/i.test(real)) return { url: real, source: masked ? "decrypted" : "initials" };
      }
    }
    if (vm.hlsUrl) return { url: vm.hlsUrl, source: "videoModel" };
    if (Array.isArray(vm.sources)) {
      for (const s of vm.sources) if (s && s.url && /\.m3u8/i.test(s.url)) return { url: s.url, source: "videoModel" };
    }
  }
  return null;
}

/* ---------- card parsing ---------- */
function formatDuration(seconds) {
  if (!seconds || typeof seconds !== "number") return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}

function slugFromPageUrl(pageUrl) {
  const u = fullUrl(pageUrl);
  const m = /\/videos\/([^/?#]+)/i.exec(u);
  return m ? m[1] : "";
}

function cardFromThumbProps(v) {
  const pageUrl = fullUrl(v.pageURL || v.pageUrl || "");
  if (!pageUrl) return null;
  if (v.isVR) return null;            // no HLS manifest at all → never show it
  const thumb = v.thumbURL || v.imageURL || "";
  return {
    id: String(v.id || slugFromPageUrl(pageUrl)),
    numericId: typeof v.id === "number" ? v.id : parseInt(v.id, 10) || null,
    slug: slugFromPageUrl(pageUrl),
    title: String(v.title || "").replace(/&amp;/g, "&").trim(),
    pageUrl,
    thumb,
    duration: formatDuration(v.duration),
    durationSec: typeof v.duration === "number" ? v.duration : null,
    views: typeof v.views === "number" ? v.views : null,
    created: typeof v.created === "number" ? v.created : null,
    previewThumb: v.previewThumbURL || "",
    trailer: v.trailerURL || v.trailerFallbackUrl || "",
    sprite: v.spriteURL || "",
    channel: (v.landing && (v.landing.name || v.landing.label)) || "",
  };
}

function findVideoThumbProps(node, depth) {
  if (!node || typeof node !== "object" || depth > 5) return null;
  if (Array.isArray(node.videoThumbProps)) return node.videoThumbProps;
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (child && typeof child === "object") {
      const found = findVideoThumbProps(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// paginationProps sits at a different place on every page type (inside
// layoutPage for feeds, under the category component on category pages), so find
// the first object that actually carries lastPageNumber.
function findPagination(node, depth) {
  if (!node || typeof node !== "object" || depth > 5) return null;
  if (node.paginationProps && typeof node.paginationProps === "object") return node.paginationProps;
  // Search pages use a different shape: { active, maxPage, maxPages, pageLinkTemplate }
  if (node.pagination && typeof node.pagination === "object" &&
      (node.pagination.maxPages || node.pagination.pageLinkTemplate)) return node.pagination;
  if (typeof node.lastPageNumber === "number") return node;
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (child && typeof child === "object") {
      const found = findPagination(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Parse a listing page (feed / category / search) into cards + pagination. */
function parseListing(html) {
  const initials = parseInitials(html);
  if (!initials) return { cards: [], page: 1, lastPage: 1, total: 0 };
  const lp = initials.layoutPage || {};
  const listProps = lp.videoListProps || initials.popularVideoListComponent || {};
  let props = listProps.videoThumbProps;
  if (!Array.isArray(props)) props = findVideoThumbProps(initials, 0) || [];
  const cards = props.map(cardFromThumbProps).filter(Boolean);

  const pag = findPagination(initials, 0) || {};
  const current = Number(pag.currentPageNumber || pag.active) || 1;
  const last = Number(pag.lastPageNumber) || Number(pag.maxPages) || Number(pag.maxPage) || 0;
  return {
    cards,
    page: current,
    // lastPageNumber is absent on some page types; that means the listing is
    // short (a single page of results), not that we should invent pages.
    lastPage: last > 0 ? last : Math.max(current, 1),
    total: Number(listProps.totalCount || lp.totalCount) || cards.length,
  };
}

/* ---------- video page (single fetch = metadata + stream + related) ---------- */
function pickNumber() {
  for (const v of arguments) if (typeof v === "number" && isFinite(v)) return v;
  return null;
}

function parseVideoPage(html) {
  const initials = parseInitials(html) || {};
  const vm = initials.videoModel || {};
  const ps = initials.xplayerSettings || {};
  const stream = extractStream(html);

  // VR / progressive-only: sources.standard exists but sources.hls is absent.
  const unsupported = !stream && (!!vm.isVR || !!(ps.sources && ps.sources.standard && !ps.sources.hls));

  const author = vm.author || {};
  const tags = [];
  const pushTag = (t) => {
    const name = typeof t === "string" ? t : (t && (t.name || t.title || t.label || t.text));
    if (name && !tags.includes(name)) tags.push(String(name));
  };
  // videoTagsComponent carries the real tag/category/pornstar list
  // (videoModel itself has no categories/tags fields).
  const tagComp = initials.videoTagsComponent || {};
  const authorName = String(author.name || "").toLowerCase();
  let category = "";
  (tagComp.tags || []).forEach((t) => {
    if (!t) return;
    if (t.isUser || t.isChannel) return;                       // uploader, shown separately
    if (/\/users\/profiles\//.test(t.url || "")) return;       // uploader alias
    if (authorName && String(t.name || "").toLowerCase() === authorName) return;
    if (!category && t.isCategory) category = t.name || t.nameEn || "";
    pushTag(t.name || t.nameEn);
  });
  (vm.categories || []).forEach(pushTag);
  (vm.tags || []).forEach(pushTag);

  const related = (initials.relatedVideosComponent && initials.relatedVideosComponent.videoThumbProps) ||
    findVideoThumbProps(initials.relatedVideosComponent || {}, 0) || [];

  return {
    video: {
      id: String(vm.id || ""),
      title: String(vm.title || "").replace(/&amp;/g, "&").trim(),
      duration: formatDuration(vm.duration),
      durationSec: typeof vm.duration === "number" ? vm.duration : null,
      views: pickNumber(vm.views, vm.viewsCount, vm.ratingCount),
      rating: pickNumber(vm.rating, vm.ratingValue),
      created: pickNumber(vm.created, vm.createdAt, vm.uploadDate),
      thumb: vm.thumbURL || vm.posterURL || vm.imageURL || "",
      author: author.name || author.username || vm.authorName || (vm.channelModel && vm.channelModel.name) || "",
      authorUrl: author.pageURL || author.url || "",
      category: category || "",
      tags: tags.slice(0, 20),
    },
    stream: stream ? { url: stream.url, source: stream.source } : null,
    unsupported,
    related: (Array.isArray(related) ? related : []).map(cardFromThumbProps).filter(Boolean),
  };
}

module.exports = {
  SITE,
  UA,
  fullUrl,
  fetchPage,
  parseInitials,
  parseListing,
  parseVideoPage,
  extractStream,
  cardFromThumbProps,
  formatDuration,
  slugFromPageUrl,
};
