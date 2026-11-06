/*
 * TubeStream service worker — v10
 * Only static assets and thumbnails are cached. Every API call and every
 * navigation goes to the network so the view you open is always the live one.
 */
const STATIC_CACHE = "ts-static-v10";
const THUMB_CACHE = "ts-thumbs-v10";
const THUMB_TTL = 24 * 3600 * 1000;

const STATIC_ASSETS = ["/style.css", "/app.js", "/vendor/hls.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== STATIC_CACHE && k !== THUMB_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HLS segments/playlists: pass through untouched (Range requests must not be
  // replayed from a cache — partial 206 bodies corrupt playback).
  if (url.pathname === "/api/stream") return;

  // Everything under /api: network only.
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/thumb") e.respondWith(thumbCacheFirst(req));
    return;
  }

  // Navigations: always network (the SPA owns all routes).
  if (req.mode === "navigate") return;

  // Static assets: cache-first, refreshed in the background.
  if (STATIC_ASSETS.includes(url.pathname) || url.pathname.startsWith("/vendor/")) {
    e.respondWith(staleWhileRevalidate(req));
  }
});

async function thumbCacheFirst(req) {
  const cache = await caches.open(THUMB_CACHE);
  const hit = await cache.match(req);
  if (hit) {
    const at = Number(hit.headers.get("sw-cached-at") || 0);
    if (!at || Date.now() - at < THUMB_TTL) return hit;
    cache.delete(req);
  }
  try {
    const res = await fetch(req);
    if (res.ok) {
      const headers = new Headers(res.headers);
      headers.set("sw-cached-at", String(Date.now()));
      const body = await res.blob();
      cache.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers }));
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  } catch (err) {
    return (await cache.match(req)) || new Response("", { status: 504, statusText: "Offline" });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit || Response.error());
  return hit || network;
}
