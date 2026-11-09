/* TubeStream client — xhamster-style routing, on-demand data.
 *
 * Rule: the client never asks the server to resolve anything it is not about to
 * show. No warm calls, no next-page loading, no hover resolution. A click is a
 * navigation; the destination view fetches exactly what it renders.
 */
(function () {
  "use strict";

  /* ------------------------------ dom ------------------------------ */
  const $ = (id) => document.getElementById(id);
  const main = $("main");
  const sidebarBody = $("sidebarBody");
  const searchForm = $("searchForm");
  const searchInput = $("searchInput");
  const searchClear = $("searchClear");
  const suggestBox = $("suggestBox");
  const menuBtn = $("menuBtn");
  const themeBtn = $("themeBtn");
  const toTop = $("toTop");

  /* ------------------------------ state ------------------------------ */
  const FEED_TABS = [
    { tab: "newest", label: "Newest", href: "/newest" },
    { tab: "hot", label: "Trending today", href: "/best/daily" },
    { tab: "popular", label: "Best week", href: "/best/weekly" },
    { tab: "top", label: "Best month", href: "/best/monthly" },
    { tab: "mostviewed", label: "Most viewed", href: "/most-viewed" },
  ];
  const PERIOD_TO_TAB = { daily: "hot", today: "hot", weekly: "popular", monthly: "top", "most-viewed": "mostviewed" };
  const TAB_TO_PERIOD = { hot: "daily", popular: "weekly", top: "monthly", mostviewed: "most-viewed" };
  const FEED_LABEL = { newest: "Newest", hot: "Trending today", popular: "Best of the week", top: "Best of the month", mostviewed: "Most viewed" };

  let categories = null;          // { groups, total }
  let viewController = null;      // aborts the current view's requests
  let hlsInstance = null;         // active hls.js player
  let route = { name: "home" };

  /* ------------------------------ helpers ------------------------------ */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function num(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  /* Thumbnails arrive as same-origin /api/thumb handles minted by the server.
   * The browser must never load (or fall back to) the raw CDN URL: that would
   * put the visitor's own IP in front of xHamster's CDN, which is how a user —
   * not just this server — gets identified and blocked. */
  function thumbSrc(u) {
    return u || "";
  }
  function fmtViews(n) {
    if (!n && n !== 0) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B views";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K views";
    return n + " views";
  }
  function timeAgo(unix) {
    if (!unix) return "";
    const secs = Math.floor(Date.now() / 1000) - (unix > 1e12 ? Math.floor(unix / 1000) : unix);
    if (secs < 60) return "just now";
    const m = Math.floor(secs / 60);
    if (m < 60) return m + " min ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " hour" + (h > 1 ? "s" : "") + " ago";
    const d = Math.floor(h / 24);
    if (d < 30) return d + " day" + (d > 1 ? "s" : "") + " ago";
    const mo = Math.floor(d / 30);
    if (mo < 12) return mo + " month" + (mo > 1 ? "s" : "") + " ago";
    return Math.floor(mo / 12) + " year" + (mo >= 24 ? "s" : "") + " ago";
  }
  function prettyLabel(slug) {
    return String(slug || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  async function api(path, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    try {
      const res = await fetch(path, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      // Invite session expired: send the tab to the gate instead of rendering
      // "Request failed (401)" over an empty grid.
      if (res.status === 401) {
        location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
        throw new Error("Sign in required");
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || "Request failed (" + res.status + ")");
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------ routing ------------------------------ */
  function parseRoute() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (!parts.length) return { name: "home" };
    const [a, b, c] = parts;
    if (a === "newest") return { name: "feed", tab: "newest", page: num(b) || 1 };
    if (a === "best") return { name: "feed", tab: PERIOD_TO_TAB[b] || "popular", period: b || "weekly", page: num(c) || 1 };
    if (a === "most-viewed") return { name: "feed", tab: "mostviewed", page: num(b) || 1 };
    if (a === "categories") return { name: "category", slug: (b || "").toLowerCase(), page: num(c) || 1 };
    if (a === "search") return { name: "search", q: decodeURIComponent(b || ""), page: num(c) || 1 };
    if (a === "videos") return { name: "watch", slug: b || "" };
    if (a === "tag") return { name: "search", q: decodeURIComponent(b || ""), page: num(c) || 1 };
    return { name: "home" };
  }

  function hrefFor(r, page) {
    switch (r.name) {
      case "feed":
        if (r.tab === "newest") return page > 1 ? "/newest/" + page : "/newest";
        if (r.tab === "mostviewed") return page > 1 ? "/most-viewed/" + page : "/most-viewed";
        return "/best/" + (TAB_TO_PERIOD[r.tab] || "weekly") + (page > 1 ? "/" + page : "");
      case "category":
        return "/categories/" + encodeURIComponent(r.slug) + (page > 1 ? "/" + page : "");
      case "search":
        return "/search/" + encodeURIComponent(r.q) + (page > 1 ? "/" + page : "");
      case "watch":
        return "/videos/" + r.slug;
      default:
        return page > 1 ? "/?page=" + page : "/";
    }
  }

  function navigate(url, opts) {
    const replace = !!(opts && opts.replace);
    if (url === location.pathname + location.search) return;
    try {
      if (replace) history.replaceState({}, "", url);
      else history.pushState({}, "", url);
    } catch (e) { location.href = url; return; }
    render(true);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-link]");
    if (!a) return;
    if (a.target === "_blank" || e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(a.getAttribute("href"));
  });

  window.addEventListener("popstate", () => render(true));

  /* ------------------------------ render ------------------------------ */
  async function render(scrollTop) {
    route = parseRoute();
    if (viewController) viewController.abort();
    viewController = new AbortController();
    const signal = viewController.signal;

    markNav();
    // Leaving a watch page must tear down the player, or the old hls instance
    // keeps buffering a video element that no longer exists.
    if (route.name !== "watch") destroyHls();
    if (scrollTop) window.scrollTo({ top: 0, behavior: "auto" });

    try {
      if (route.name === "home") await renderHome(signal);
      else if (route.name === "feed") await renderFeed(route, signal);
      else if (route.name === "category") await renderCategory(route, signal);
      else if (route.name === "search") await renderSearch(route, signal);
      else if (route.name === "watch") await renderWatch(route, signal);
    } catch (e) {
      if (signal.aborted || (e && e.name === "AbortError")) return;
      destroyHls();
      main.innerHTML =
        '<div class="state"><h3>Something went wrong</h3><p>' + esc(e.message) +
        '</p><button class="btn primary" id="retryView">Try again</button></div>';
      const retry = $("retryView");
      if (retry) retry.addEventListener("click", () => render(false));
    }
  }

  /* ------------------------------ cards ------------------------------ */
  function cardHTML(v) {
    const href = "/videos/" + encodeURIComponent(v.slug || v.id || "");
    const meta = [];
    if (v.views) meta.push(esc(fmtViews(v.views)));
    if (v.created) meta.push(esc(timeAgo(v.created)));
    if (!meta.length && v.channel) meta.push(esc(v.channel));
    return (
      '<a class="card" href="' + href + '" data-link>' +
        '<div class="thumb">' +
          (v.thumb
            ? '<img loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" src="' + esc(thumbSrc(v.thumb)) + '">'
            : '<div class="thumb-fallback">▶</div>') +
          '<div class="play-pip"><span>▶</span></div>' +
          (v.duration ? '<span class="badge dur">' + esc(v.duration) + "</span>" : "") +
          (v.views ? '<span class="badge views">' + esc(fmtViews(v.views)) + "</span>" : "") +
        "</div>" +
        '<div class="card-title">' + esc(v.title) + "</div>" +
        (meta.length ? '<div class="card-meta">' + meta.join('<span class="dot"></span>') + "</div>" : "") +
      "</a>"
    );
  }

  function hydrateThumbs(root) {
    root.querySelectorAll(".thumb img").forEach((img) => {
      const done = () => img.classList.add("loaded");
      if (img.complete && img.naturalWidth) done();
      else img.addEventListener("load", done, { once: true });
      img.addEventListener("error", function onErr() {
        img.removeEventListener("error", onErr);
        img.style.display = "none";
        const wrap = img.parentElement;
        if (wrap && !wrap.querySelector(".thumb-fallback")) {
          const ph = document.createElement("div");
          ph.className = "thumb-fallback";
          ph.textContent = "▶";
          wrap.appendChild(ph);
        }
      });
    });
  }

  function mountGrid(container, videos) {
    if (!videos.length) {
      container.innerHTML = '<div class="state"><h3>No videos here</h3><p>Try another category or search.</p></div>';
      return;
    }
    container.innerHTML = '<div class="grid">' + videos.map(cardHTML).join("") + "</div>";
    hydrateThumbs(container);
  }

  function skeletonGrid(count) {
    let html = '<div class="grid">';
    for (let i = 0; i < count; i++) {
      html += '<div class="skel-card"><div class="skel-thumb"></div><div class="skel-line"></div><div class="skel-line short"></div></div>';
    }
    return html + "</div>";
  }

  /* ------------------------------ pagination ------------------------------ */
  function pagerHTML(r, page, lastPage) {
    if (!lastPage || lastPage <= 1) return "";
    const from = Math.max(1, Math.min(page - 2, lastPage - 4));
    const to = Math.min(lastPage, from + 4);
    let html = '<div class="pager">';
    html += '<button class="pager-btn" data-page="' + (page - 1) + '"' + (page <= 1 ? " disabled" : "") + ">‹ Prev</button>";
    if (from > 1) {
      html += '<button class="pager-num" data-page="1">1</button>';
      if (from > 2) html += '<span class="pager-dots">…</span>';
    }
    for (let p = from; p <= to; p++) {
      html += '<button class="pager-num' + (p === page ? " active" : "") + '" data-page="' + p + '">' + p + "</button>";
    }
    if (to < lastPage) {
      if (to < lastPage - 1) html += '<span class="pager-dots">…</span>';
      html += '<button class="pager-num" data-page="' + lastPage + '">' + lastPage + "</button>";
    }
    html += '<button class="pager-btn" data-page="' + (page + 1) + '"' + (page >= lastPage ? " disabled" : "") + ">Next ›</button>";
    return html + "</div>";
  }

  function wirePager(r) {
    const pager = main.querySelector(".pager");
    if (!pager) return;
    pager.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-page]");
      if (!btn || btn.disabled) return;
      const page = num(btn.getAttribute("data-page")) || 1;
      navigate(hrefFor(r, page));
    });
  }

  /* ------------------------------ views ------------------------------ */
  async function renderHome(signal) {
    document.title = "TubeStream — Free HD Videos";
    const rows = [
      { tab: "hot", label: "Trending today" },
      { tab: "newest", label: "Newest" },
      { tab: "popular", label: "Best of the week" },
    ];

    main.innerHTML =
      '<div class="view-head"><h1 class="view-title">Watch free HD videos</h1></div>' +
      '<div id="homeRows">' +
      rows.map((r, i) =>
        '<section class="row" data-row="' + i + '"><div class="row-head"><h2 class="row-title">' + esc(r.label) + "</h2></div>" + skeletonGrid(6) + "</section>"
      ).join("") +
      "</div>";

    const wrap = $("homeRows");
    let loaded = 0;

    // Each section renders the moment its own listing arrives — no combined
    // endpoint waiting for the slowest row.
    await Promise.all(rows.map(async (r, i) => {
      const sec = wrap.querySelector('[data-row="' + i + '"]');
      try {
        const d = await api("/api/feed?tab=" + encodeURIComponent(r.tab) + "&page=1", signal);
        if (signal.aborted || !sec || !sec.parentElement) return;
        const videos = (d.videos || []).slice(0, 12);
        if (!videos.length) { sec.remove(); return; }
        sec.innerHTML =
          '<div class="row-head"><h2 class="row-title">' + esc(d.label || r.label) + "</h2>" +
          '<a class="row-link" href="' + hrefFor({ name: "feed", tab: r.tab }, 1) + '" data-link>See all →</a></div>' +
          '<div class="grid">' + videos.map(cardHTML).join("") + "</div>";
        hydrateThumbs(sec);
        loaded++;
      } catch (e) {
        if (!signal.aborted && sec) sec.remove();
      }
    }));

    if (!signal.aborted && !loaded) {
      main.innerHTML = '<div class="state"><h3>Feed unavailable</h3><p>The source did not return any videos. Try again in a moment.</p>' +
        '<button class="btn primary" id="homeRetry">Reload</button></div>';
      const btn = $("homeRetry");
      if (btn) btn.addEventListener("click", () => render(false));
    }
  }

  async function renderFeed(r, signal) {
    const label = FEED_LABEL[r.tab] || "Newest";
    document.title = label + (r.page > 1 ? " — page " + r.page : "") + " — TubeStream";
    main.innerHTML =
      '<div class="view-head"><h1 class="view-title">' + esc(label) + "</h1></div>" +
      chipsHTML("/newest", r.tab) +
      skeletonGrid(12);

    const data = await api("/api/feed?tab=" + encodeURIComponent(r.tab) + "&page=" + r.page, signal);
    if (signal.aborted) return;

    main.innerHTML =
      '<div class="view-head"><h1 class="view-title">' + esc(data.label || label) + "</h1>" +
      (data.total ? '<span class="view-sub">' + esc(fmtViews(data.total).replace("views", "videos")) + "</span>" : "") + "</div>" +
      chipsHTML("/newest", r.tab) +
      '<div id="results"></div>' +
      pagerHTML(r, r.page, data.lastPage);
    mountGrid($("results"), data.videos || []);
    wirePager(r);
  }

  async function renderCategory(r, signal) {
    if (!categories) loadCategories();
    const label = findCategoryLabel(r.slug) || prettyLabel(r.slug);
    document.title = label + (r.page > 1 ? " — page " + r.page : "") + " — TubeStream";
    main.innerHTML =
      '<div class="view-head"><h1 class="view-title">' + esc(label) + "</h1></div>" + skeletonGrid(12);

    const data = await api("/api/category/" + encodeURIComponent(r.slug) + "?page=" + r.page, signal);
    if (signal.aborted) return;

    main.innerHTML =
      '<div class="crumbs"><a href="/" data-link>Home</a><span>›</span><span>Categories</span><span>›</span><span>' + esc(data.label || label) + "</span></div>" +
      '<div class="view-head"><h1 class="view-title">' + esc(data.label || label) + "</h1></div>" +
      '<div id="results"></div>' +
      pagerHTML(r, r.page, data.lastPage);
    mountGrid($("results"), data.videos || []);
    wirePager(r);
  }

  async function renderSearch(r, signal) {
    const q = r.q || "";
    document.title = "Search: " + q + " — TubeStream";
    if (searchInput.value !== q) searchInput.value = q;
    searchClear.classList.toggle("hidden", !q);
    main.innerHTML =
      '<div class="crumbs"><a href="/" data-link>Home</a><span>›</span><span>Search</span></div>' +
      '<div class="view-head"><h1 class="view-title">Search results for <span class="accent">' + esc(q) + "</span></h1></div>" +
      skeletonGrid(12);

    const data = await api("/api/search?q=" + encodeURIComponent(q) + "&page=" + r.page, signal);
    if (signal.aborted) return;

    if (!(data.videos || []).length) {
      main.innerHTML =
        '<div class="crumbs"><a href="/" data-link>Home</a><span>›</span><span>Search</span></div>' +
        '<div class="view-head"><h1 class="view-title">Search results for <span class="accent">' + esc(q) + "</span></h1></div>" +
        '<div class="state"><h3>Nothing found</h3><p>No videos matched “' + esc(q) + '”. Try a shorter or different keyword.</p></div>';
      return;
    }

    main.innerHTML =
      '<div class="crumbs"><a href="/" data-link>Home</a><span>›</span><span>Search</span></div>' +
      '<div class="view-head"><h1 class="view-title">Search results for <span class="accent">' + esc(q) + "</span></h1></div>" +
      '<div id="results"></div>' +
      pagerHTML(r, r.page, data.lastPage);
    mountGrid($("results"), data.videos);
    wirePager(r);
  }

  async function renderWatch(r, signal) {
    document.title = "Loading… — TubeStream";
    // Load the player library in parallel with the stream resolve instead of
    // after it — one serial hop less on the very first click.
    if (!(window.Hls && window.Hls.isSupported())) loadHlsJs().catch(() => {});
    main.innerHTML =
      '<div class="watch">' +
        '<div class="crumbs"><a href="/" data-link>Home</a><span>›</span><span id="crumbCat">Video</span></div>' +
        '<div class="player-wrap">' +
          '<video id="player" controls playsinline preload="metadata" poster=""></video>' +
          '<div class="player-msg" id="playerMsg"><div class="spinner"></div><div id="playerMsgText">Starting stream…</div>' +
          '<div class="msg-sub">Fetching directly from the source</div></div>' +
        "</div>" +
        '<div class="watch-head"><h1 class="watch-title" id="watchTitle">Loading…</h1>' +
        '<div class="watch-stats" id="watchStats"></div></div>' +
        '<div class="watch-actions" id="watchActions"></div>' +
        '<div class="tags" id="watchTags"></div>' +
        '<h2 class="section-title">Related videos</h2>' +
        '<div id="related">' + skeletonGrid(6) + "</div>" +
      "</div>";

    const data = await api("/api/watch/" + encodeURIComponent(r.slug), signal);
    if (signal.aborted) return;

    const v = data.video || {};
    const title = v.title || "Untitled video";
    document.title = title + " — TubeStream";

    $("watchTitle").textContent = title;
    const catName = v.category || (v.tags && v.tags[0]) || "";
    if (catName) {
      const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      $("crumbCat").innerHTML = '<a href="/categories/' + encodeURIComponent(slug) + '" data-link>' + esc(prettyLabel(catName)) + "</a>";
    } else {
      $("crumbCat").textContent = "Video";
    }

    const stats = [];
    if (v.views) stats.push(esc(fmtViews(v.views)));
    if (v.created) stats.push(esc(timeAgo(v.created)));
    if (v.duration) stats.push(esc(v.duration));
    if (v.author) stats.push(esc(v.author));
    $("watchStats").innerHTML = stats.join('<span class="sep"></span>');

    // No outbound link to the source site: clicking it would hand the visitor's
    // IP (and their interest in this video) straight back to xHamster, which is
    // the one thing this front end exists to prevent.
    $("watchActions").innerHTML = '<button class="btn primary" id="copyBtn">Copy link</button>';
    const copyBtn = $("copyBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(location.href);
          copyBtn.textContent = "Copied ✓";
          setTimeout(() => { copyBtn.textContent = "Copy link"; }, 1600);
        } catch (e) { /* clipboard blocked */ }
      });
    }

    if (v.tags && v.tags.length) {
      $("watchTags").innerHTML = v.tags
        .slice(0, 12)
        .map((t) => '<a class="tag" href="/search/' + encodeURIComponent(t) + '" data-link>' + esc(t) + "</a>")
        .join("");
    }

    const related = $("related");
    if (data.related && data.related.length) {
      related.innerHTML = '<div class="grid">' + data.related.map(cardHTML).join("") + "</div>";
      hydrateThumbs(related);
    } else {
      related.innerHTML = '<div class="state"><p>No related videos.</p></div>';
    }

    const msg = $("playerMsg");
    const msgText = $("playerMsgText");

    if (data.unsupported || !data.stream) {
      msg.innerHTML = "<div><strong>This video has no playable stream.</strong><div class=\"msg-sub\">It may be VR-only or source-restricted. Pick another video.</div></div>";
      return;
    }

    if (v.thumb) $("player").poster = thumbSrc(v.thumb);

    try {
      await playStream($("player"), data.stream.url, signal);
      msg.classList.add("hidden");
    } catch (e) {
      if (signal.aborted) return;
      // One retry with a freshly minted handle. The ?fresh=1 URL is not in the
      // service worker's cache (exact-URL match), so this goes to the server,
      // which re-verifies the playlist and, if the cached stream signature is
      // dead, refetches the page for a live one.
      try {
        const slug = data.slug || location.pathname.split("/").filter(Boolean).pop() || "";
        const fresh = await api("/api/watch/" + encodeURIComponent(slug) + "?fresh=1", signal);
        if (fresh && fresh.stream && fresh.stream.url !== data.stream.url) {
          await playStream($("player"), fresh.stream.url, signal);
          msg.classList.add("hidden");
          return;
        }
      } catch (e2) { /* fall through to the error message */ }
      if (signal.aborted) return;
      msg.classList.remove("hidden");
      msgText.textContent = "Could not start this stream.";
    }
  }

  /* ------------------------------ player ------------------------------ */
  let hlsLoader = null;
  function loadHlsJs() {
    if (typeof window.Hls !== "undefined") return Promise.resolve(window.Hls);
    if (hlsLoader) return hlsLoader;
    hlsLoader = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/vendor/hls.min.js";
      s.async = true;
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error("player unavailable")));
      s.onerror = () => reject(new Error("player failed to load"));
      document.head.appendChild(s);
    }).catch((e) => { hlsLoader = null; throw e; });
    return hlsLoader;
  }

  function destroyHls() {
    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (e) { /* ignore */ }
      hlsInstance = null;
    }
  }

  /* ------------------------------ playback ------------------------------
   * `url` is always a same-origin /api/stream handle minted by the server. The
   * player never sees the real CDN URL: a direct request would reveal the
   * visitor's IP to xHamster's edge and let it be throttled or blocked per
   * address, and it would make every viewer traceable back to this site.
   */
  async function playStream(video, url, signal) {
    destroyHls();
    if (signal && signal.aborted) return;
    if (!url) throw new Error("stream unavailable");
    try {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        await attachNative(video, url, signal);
      } else {
        await attachHls(video, url, signal);
      }
    } catch (e) {
      destroyHls();
      try { video.removeAttribute("src"); video.load(); } catch (err) { /* ignore */ }
      throw e;
    }
  }

  // Native HLS (Safari/iOS) needs no library at all.
  function attachNative(video, src, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", ok);
        video.removeEventListener("error", bad);
        fn(arg);
      };
      const ok = () => done(resolve);
      const bad = () => done(reject, new Error("native playback failed"));
      const timer = setTimeout(() => {
        if (video.readyState >= 1) done(resolve);
        else done(reject, new Error("native playback timeout"));
      }, 12000);
      video.addEventListener("loadedmetadata", ok);
      video.addEventListener("error", bad);
      video.src = src;
      video.play().catch(() => { /* autoplay policy — controls are visible */ });
    });
  }

  async function attachHls(video, src, signal) {
    const Hls = await loadHlsJs();
    if (signal && signal.aborted) return;
    if (!Hls.isSupported()) throw new Error("HLS is not supported in this browser");

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      startFragPrefetch: false,      // play exactly what the player asks for
      testBandwidth: false,
      startLevel: 0,                 // start on the lightest level → first frame ASAP
      capLevelToPlayerSize: true,    // never pull 4K into a small box
      maxBufferLength: 24,
      backBufferLength: 30,
    });
    hlsInstance = hls;

    // The sources go up to 2160p; climbing there costs bandwidth with no visible
    // gain. Cap the ladder at 720p (levels[] is reliably populated by the time a
    // level playlist has loaded).
    const capLevels = () => {
      try {
        const levels = hls.levels || [];
        let cap = -1;
        levels.forEach((l, i) => {
          if (l.height && l.height <= 720 && (cap < 0 || l.height > levels[cap].height)) cap = i;
        });
        if (cap >= 0) hls.autoLevelCapping = cap;
      } catch (err) { /* best-effort */ }
    };

    return new Promise((resolve, reject) => {
      let started = false;
      let recovered = false;
      const timer = setTimeout(() => {
        if (started) return;
        started = true;
        reject(new Error("stream start timeout"));
      }, 12000);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (started) return;
        started = true;
        clearTimeout(timer);
        capLevels();
        video.play().catch(() => { /* autoplay policy — controls are visible */ });
        resolve();
      });
      hls.on(Hls.Events.LEVEL_LOADED, capLevels);
      hls.on(Hls.Events.ERROR, (_evt, info) => {
        if (!info || !info.fatal) return;

        // Nothing played yet: this source is unreachable from here — let the
        // caller try the next one (direct → proxy).
        if (!started) {
          started = true;
          clearTimeout(timer);
          reject(new Error("source unreachable"));
          return;
        }

        if (!recovered && (info.type === Hls.ErrorTypes.NETWORK_ERROR || info.type === Hls.ErrorTypes.MEDIA_ERROR)) {
          recovered = true;
          if (info.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else hls.recoverMediaError();
          return;
        }
        const msg = $("playerMsg");
        const txt = $("playerMsgText");
        if (msg && txt) {
          msg.classList.remove("hidden");
          txt.textContent = "Playback failed — this video may be unavailable.";
        }
      });

      hls.loadSource(src);
      hls.attachMedia(video);
    });
  }

  /* ------------------------------ sidebar ------------------------------ */
  async function loadCategories() {
    try {
      categories = await api("/api/categories");
    } catch (e) {
      categories = { groups: [], total: 0 };
    }
    renderSidebar();
  }

  function findCategoryLabel(slug) {
    if (!categories) return "";
    for (const g of categories.groups) {
      for (const it of g.items) if (it.slug === slug) return it.label;
    }
    return "";
  }

  function renderSidebar() {
    if (!sidebarBody) return;
    const feeds = FEED_TABS.map((t) => '<a class="sidebar-link" href="' + t.href + '" data-link>' + esc(t.label) + "</a>").join("");
    let html = '<div class="sidebar-group"><div class="sidebar-title">Feeds</div>' +
      '<a class="sidebar-link" href="/" data-link>Home</a>' + feeds + "</div>";
    for (const g of (categories && categories.groups) || []) {
      html += '<div class="sidebar-group"><div class="sidebar-title">' + esc(g.name) + "</div>" +
        g.items.slice(0, 80).map((it) => '<a class="sidebar-link" href="/categories/' + encodeURIComponent(it.slug) + '" data-link>' + esc(it.label) + "</a>").join("") +
        "</div>";
    }
    sidebarBody.innerHTML = html;
    markNav();
  }

  function markNav() {
    document.querySelectorAll(".topnav-link").forEach((a) => {
      const href = a.getAttribute("href");
      const active = (href === "/" && route.name === "home") ||
        (href !== "/" && location.pathname.startsWith(href));
      a.classList.toggle("active", active);
    });
    if (!sidebarBody) return;
    sidebarBody.querySelectorAll(".sidebar-link").forEach((a) => {
      const href = a.getAttribute("href");
      const active = href === location.pathname || (href !== "/" && location.pathname.startsWith(href + "/"));
      a.classList.toggle("active", active);
    });
  }

  function chipsHTML(base, active) {
    return '<div class="chips">' + FEED_TABS.map((t) => (
      '<a class="chip' + (t.tab === active ? " active" : "") + '" href="' + t.href + '" data-link>' + esc(t.label) + "</a>"
    )).join("") + "</div>";
  }

  /* ------------------------------ search box ------------------------------ */
  let suggestTimer = null;
  let suggestSeq = 0;
  let suggestItems = [];

  function hideSuggest() {
    suggestBox.classList.add("hidden");
    suggestBox.innerHTML = "";
    suggestItems = [];
  }

  function renderSuggest(items) {
    suggestItems = items;
    if (!items.length) { hideSuggest(); return; }
    suggestBox.innerHTML = items
      .slice(0, 8)
      .map((it, i) => '<div class="suggest-item" data-i="' + i + '" role="option">' +
        '<span class="sug-text">' + esc(it.text || "") + "</span>" +
        '<span class="sug-kind">' + esc(it.kind || "") + "</span></div>")
      .join("");
    suggestBox.classList.remove("hidden");
  }

  function submitSearch(q) {
    const clean = String(q || "").trim();
    if (!clean) return;
    hideSuggest();
    searchInput.blur();
    navigate("/search/" + encodeURIComponent(clean));
  }

  if (searchForm) {
    searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      submitSearch(searchInput.value);
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim();
      searchClear.classList.toggle("hidden", !q);
      clearTimeout(suggestTimer);
      if (q.length < 2) { hideSuggest(); return; }
      const seq = ++suggestSeq;
      suggestTimer = setTimeout(async () => {
        try {
          const data = await api("/api/suggest?q=" + encodeURIComponent(q));
          if (seq !== suggestSeq) return;
          renderSuggest(data.suggestions || []);
        } catch (e) { /* suggestions are optional */ }
      }, 240);
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { hideSuggest(); searchInput.blur(); }
      if (e.key === "Enter") { e.preventDefault(); submitSearch(searchInput.value); }
    });

    searchInput.addEventListener("focus", () => {
      if (suggestItems.length) suggestBox.classList.remove("hidden");
    });

    searchInput.addEventListener("blur", () => {
      setTimeout(hideSuggest, 160);
    });
  }

  if (searchClear) {
    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      searchClear.classList.add("hidden");
      hideSuggest();
      searchInput.focus();
    });
  }

  if (suggestBox) {
    suggestBox.addEventListener("mousedown", (e) => {
      const item = e.target.closest(".suggest-item");
      if (!item) return;
      e.preventDefault();
      const hit = suggestItems[Number(item.getAttribute("data-i"))];
      if (hit) submitSearch(hit.text);
    });
  }

  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
      e.preventDefault();
      searchInput.focus();
    }
  });

  /* ------------------------------ chrome ------------------------------ */
  const THEME_KEY = "ts-theme";
  const SIDEBAR_KEY = "ts-sidebar";

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }
  }

  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (e) { /* ignore */ }

  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next);
    });
  }

  function applySidebar(hidden) {
    document.body.classList.toggle("sidebar-hidden", hidden);
    try { localStorage.setItem(SIDEBAR_KEY, hidden ? "hidden" : "shown"); } catch (e) { /* ignore */ }
  }

  try {
    if (localStorage.getItem(SIDEBAR_KEY) === "hidden") document.body.classList.add("sidebar-hidden");
  } catch (e) { /* ignore */ }

  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      if (window.matchMedia("(max-width: 860px)").matches) {
        document.body.classList.toggle("sidebar-open");
      } else {
        applySidebar(!document.body.classList.contains("sidebar-hidden"));
      }
    });
  }

  if (toTop) {
    window.addEventListener("scroll", () => {
      toTop.classList.toggle("show", window.scrollY > 700);
    }, { passive: true });
    toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  /* ------------------------------ boot ------------------------------ */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  loadCategories();
  render(false);
})();
