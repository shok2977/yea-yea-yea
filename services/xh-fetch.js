/* xh-fetch.js — direct xHamster fetch over a DoH-pinned mirror pool.
 *
 * Two problems solved here:
 *
 * 1) DNS. In this environment the ISP (Jio) hijacks DNS for xhamster.com
 *    (→ 49.44.79.236 block page), but TLS/SNI routing to the real Cloudflare IPs
 *    still works. We resolve real IPs over DoH (1.1.1.1, then 8.8.8.8 — both
 *    literal IPs, so no DNS needed for the resolver itself) and pin them inside
 *    an https.Agent via a custom `lookup`. SNI stays the real hostname, the
 *    connection goes to the real edge. Measured 0.9–1.5 s per page vs 3–9 s+
 *    through a text relay.
 *
 * 2) A single hostname is a single point of failure. xHamster runs its own
 *    anti-block domain fleet — the numbered .com/.desi mirrors they rotate
 *    whenever a country blocks a domain (Germany blocked de.xhamster.com, they
 *    opened deu.xhamster.com). Every host in that fleet serves the identical
 *    SSR payload (`window.initials`), so a host swap needs zero parser changes.
 *    We treat that fleet as our redundancy: sticky last-good host, per-host
 *    health, exponential-ish cooldown, and failover on 403/429/5xx/timeout.
 *
 * Honest scope: this raises resilience a lot, it does NOT make blocking
 * impossible. Their WAF still sees one ASN, one TLS fingerprint and one request
 * rhythm; rate limiting there is per IPv4 address or per IPv6 /64, so swapping
 * mirror hostnames does not buy fresh limit buckets by itself.
 */
const https = require("https");
const dns = require("dns");
const crypto = require("crypto");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const egress = require("./egress");
const shared = require("./shared");

const XH_HOST = "xhamster.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/* Chrome on Windows only, with just the major version varying. Mixing an Edge UA
 * with `sec-ch-ua: "Google Chrome"`, or a macOS platform string with a Windows
 * UA, is a one-request bot tell — the header set has to agree with itself, and
 * an inconsistent set is exactly what a WAF scores highest. */
const UA_VARIANTS = ["124", "125", "126", "127", "128"].map(
  (v) => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + v + ".0.0.0 Safari/537.36"
);

function getRandomUA() {
  return UA_VARIANTS[Math.floor(Math.random() * UA_VARIANTS.length)];
}

/* xHamster's own domain fleet. Ordered: canonical first, then the mirrors their
 * own users get redirected to when a region blocks the main domain. */
/* Any hostname in the family is allowed for DoH pinning and redirect-following. */
const HOST_RE = /(^|\.)(xhamster\d*\.(?:com|desi|one|net|best)|xhopen\.com|xhspot\.com|xhtotal\.com|xhaccess\.com|xhday\.com|xhvid\.com|xhms\.pro)$/i;

function isPoolHost(h) {
  return HOST_RE.test(String(h || ""));
}

/* HOST_POOL is overridable so an operator can pin a working mirror without a
 * code change (e.g. XH_HOSTS=xhamster.desi,xhopen.com). */
const HOST_POOL = (process.env.XH_HOSTS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(isPoolHost);
if (!HOST_POOL.length) {
  // Order is evidence-based: the first three answered with the identical
  // `window.initials` payload from here; the rest are network-dependent
  // fallbacks kept last so a dead one never costs a timeout before a live one.
  HOST_POOL.push("xhamster.com", "xhamster.desi", "xhamster3.com", "xhamster2.com", "xhopen.com", "xhspot.com");
}

/* ------------------------------ DoH resolver ------------------------------ */
const DOH_ENDPOINTS = [
  "https://1.1.1.1/dns-query?name=<host>&type=A",   // Cloudflare dns-json
  "https://8.8.8.8/resolve?name=<host>&type=A",     // Google DNS JSON fallback
  "https://dns.quad9.net/dns-query?name=<host>&type=A", // Quad9 DNS JSON
  "https://dns.opendns.com/dns-query?name=<host>&type=A",   // OpenDNS DNS JSON
];
const DNS_TTL = 5 * 60 * 1000;

const dnsState = new Map();   // host -> { ips, ts, idx }
const resolving = new Map();  // host -> Promise

function dohQuery(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.get(endpoint, {
      headers: { Accept: "application/dns-json" },
      timeout: 4000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("doh http " + res.statusCode)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
          if (ips.length) resolve(ips); else reject(new Error("doh: no A records"));
        } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("doh timeout")));
    req.on("error", reject);
  });
}

async function resolveHost(host, force) {
  const cached = dnsState.get(host);
  if (!force && cached && cached.ips.length && Date.now() - cached.ts < DNS_TTL) return cached.ips;
  if (resolving.has(host)) return resolving.get(host);

  const job = (async () => {
    let lastErr;
    for (const tpl of DOH_ENDPOINTS) {
      try {
        const ips = await dohQuery(tpl.replace("<host>", encodeURIComponent(host)));
        const prev = dnsState.get(host);
        dnsState.set(host, { ips, ts: Date.now(), idx: (prev ? prev.idx + (force ? 1 : 0) : 0) });
        console.log("[xhFetch] DoH", host, "->", ips.join(", "));
        persistHealth();   // remember the last real edge IPs for the next boot
        return ips;
      } catch (e) { lastErr = e; }
    }
    // Every DoH resolver unreachable (a network that blocks 1.1.1.1/8.8.8.8 is
    // normal on the same ISPs that hijack this domain). Fall back to the last
    // known-good edge IPs instead of the system resolver, which is precisely the
    // one that returns the block page.
    const pin = dnsState.get(host);
    if (pin && pin.ips && pin.ips.length) {
      console.warn("[xhFetch] DoH unavailable for", host, "— reusing last known-good edge IPs");
      return pin.ips;
    }
    throw lastErr || new Error("doh failed for " + host);
  })().finally(() => resolving.delete(host));

  resolving.set(host, job);
  return job;
}

/* Node 20+ also calls lookup with opts.all:true and expects [{address, family}]. */
function pinnedLookup(hostname, opts, cb) {
  if (!isPoolHost(hostname)) return dns.lookup(hostname, opts, cb);
  resolveHost(hostname, false)
    .then((ips) => {
      const st = dnsState.get(hostname);
      const ip = ips[((st && st.idx) || 0) % ips.length];
      if (opts && opts.all) return cb(null, [{ address: ip, family: 4 }]);
      cb(null, ip, 4);
    })
    .catch(() => dns.lookup(hostname, opts, cb));
}

const xhAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 12,
  maxFreeSockets: 6,
  keepAliveMsecs: 60 * 1000,
  lookup: pinnedLookup,
});

/* ------------------------- upstream governor ------------------------------
 * The whole point of this app being invisible is that N users must never become
 * N upstream requests. Upstream sees at most MAX_INFLIGHT sockets and at most
 * RATE_PER_SEC page fetches — the same shape one person browsing produces, no
 * matter whether ten people or ten thousand are on the site. User clicks jump
 * the queue ahead of background work, but they are still rate-capped: a traffic
 * spike must never turn into a burst on their side.
 */
const MAX_INFLIGHT = 4;
const RATE_PER_SEC = 6;
const RATE_BURST = 6;

let tokens = RATE_BURST;
let lastRefill = Date.now();
let inflightCount = 0;
const waiters = [];
let pumpTimer = null;

function refillTokens() {
  const now = Date.now();
  const add = ((now - lastRefill) / 1000) * RATE_PER_SEC;
  if (add > 0) {
    tokens = Math.min(RATE_BURST, tokens + add);
    lastRefill = now;
  }
}

function pumpQueue() {
  refillTokens();
  while (waiters.length && inflightCount < MAX_INFLIGHT && tokens >= 1) {
    const job = waiters.shift();
    if (Date.now() > job.deadline) { job.drop(new Error("upstream queue timeout")); continue; }
    tokens -= 1;
    inflightCount += 1;
    let released = false;
    job.grant(() => {
      if (released) return;
      released = true;
      inflightCount -= 1;
      pumpQueue();
    });
  }
  if (waiters.length && !pumpTimer) {
    pumpTimer = setTimeout(() => { pumpTimer = null; pumpQueue(); }, 40);
  }
}

function acquireSlot(priority, deadline) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const job = {
      priority,
      deadline,
      grant: (release) => { if (timer) clearTimeout(timer); resolve(release); },
      drop: (err) => { if (timer) clearTimeout(timer); reject(err); },
    };

    // A request that waits this long is not worth serving anyway.
    timer = setTimeout(() => {
      const i = waiters.indexOf(job);
      if (i !== -1) { waiters.splice(i, 1); job.drop(new Error("upstream queue timeout")); }
    }, Math.max(0, deadline - Date.now()));

    if (priority === 0) {
      // User is waiting: go in front of every background job.
      const i = waiters.findIndex((w) => w.priority > 0);
      if (i === -1) waiters.push(job); else waiters.splice(i, 0, job);
    } else {
      waiters.push(job);
    }
    pumpQueue();
  });
}

/* ------------------------------ cookie jar ---------------------------------
 * A scraper that opens every request with no cookies is a scraper. Holding the
 * session cookies xHamster hands out (age gate, consent, session) makes repeat
 * fetches look like one browser coming back, which is both more honest to their
 * CDN and cheaper: the warmed session skips the interstitial.
 */
const COOKIE_MAX = 40;
const cookies = new Map();

function cookieHeader() {
  if (!cookies.size) return "";
  const parts = [];
  for (const [k, v] of cookies) parts.push(k + "=" + v);
  return parts.join("; ");
}

function storeCookies(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const line of list) {
    const first = String(line).split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;
    if (!value || /^deleted$/i.test(value)) { cookies.delete(name); continue; }
    cookies.set(name, value);
    if (cookies.size > COOKIE_MAX) {
      const oldest = cookies.keys().next().value;
      if (oldest !== undefined) cookies.delete(oldest);
    }
  }
}

function decodeBody(buf, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf).toString("utf8");
    if (enc.includes("gzip")) return zlib.gunzipSync(buf).toString("utf8");
    if (enc.includes("deflate")) return zlib.inflateSync(buf).toString("utf8");
  } catch (e) {
    // A truncated/odd encoding should not kill the fetch — fall through.
  }
  return buf.toString("utf8");
}

/* ----------------------------- host health --------------------------------
 * Cooldowns are short for transport errors (a flaky edge recovers in seconds)
 * and long for 403/429 (that is a decision, not a glitch). They grow
 * geometrically with repeated failures and carry ±35 % jitter, so a retry never
 * lands on the exact second their limiter reopened. A synchronised retry loop is
 * the one pattern that turns a soft throttle into a hard block.
 */
const health = new Map();     // host -> { fails, cooldownUntil, lastOk, lastErr }
let lastGoodHost = "";
const COOLDOWN_MAX_MS = 30 * 60 * 1000;

/* --------------------------- durable quiet state ---------------------------
 * A crash loop is worse than a scraper: three quick restarts re-hit the host
 * that just refused us, and that escalation is what gets a network blocked. So
 * cooldowns and the global pause survive the process.
 */
const STATE_DIR = path.join(__dirname, "..", ".cache");
const STATE_FILE = path.join(STATE_DIR, "upstream-health.json");
let persistTimer = null;

function persistHealth() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const hosts = {};
    const now = Date.now();
    for (const [host, h] of health) {
      if ((h.cooldownUntil || 0) > now) {
        hosts[host] = { cooldownUntil: h.cooldownUntil, fails: h.fails || 1, lastErr: h.lastErr || "" };
      }
    }
    const dnsPins = {};
    for (const [host, st] of dnsState) {
      if (st && Array.isArray(st.ips) && st.ips.length) dnsPins[host] = { ips: st.ips, ts: st.ts || 0 };
    }
    const breakerUntil = shared.breakerStatus().until;
    const payload = { hosts, dnsPins, globalPauseUntil: Math.max(globalPauseUntil, breakerUntil), savedAt: now };
    // Cluster: replicas share cooldowns so one replica's block cools the host
    // for everyone instead of each replica re-learning it the hard way.
    shared.healthSet(payload);
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = STATE_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) { /* best effort — never block a fetch on disk */ }
  }, 500);
  if (persistTimer.unref) persistTimer.unref();
}

async function hydrateHealth() {
  let raw = null;
  try {
    raw = await shared.healthGet();   // cluster state wins when present
  } catch (e) { raw = null; }
  if (!raw) {
    try {
      if (fs.existsSync(STATE_FILE)) raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch (e) { raw = null; }
  }
  if (!raw) return;
  try {
    const now = Date.now();
    let restored = 0;
    for (const host of Object.keys((raw && raw.hosts) || {})) {
      const h = raw.hosts[host];
      if (!isPoolHost(host) || !h) continue;
      if ((h.cooldownUntil || 0) <= now) continue;
      health.set(host, { fails: h.fails || 1, cooldownUntil: h.cooldownUntil, lastErr: h.lastErr || "restored" });
      restored++;
    }
    for (const host of Object.keys((raw && raw.dnsPins) || {})) {
      const pin = raw.dnsPins[host];
      if (!isPoolHost(host) || !pin || !Array.isArray(pin.ips) || !pin.ips.length) continue;
      if (dnsState.has(host)) continue;
      const ips = pin.ips.filter((ip) => typeof ip === "string" && /^[0-9a-fA-F:.]+$/.test(ip));
      if (ips.length) dnsState.set(host, { ips, ts: 0, idx: 0 });   // ts 0 = stale, DoH still preferred
    }
    if (raw && raw.globalPauseUntil > now) globalPauseUntil = raw.globalPauseUntil;
    if (restored) console.log("[xhFetch] restored " + restored + " host cooldown(s) from last run");
  } catch (e) { /* a corrupt state file must never block boot */ }
}

/* --------------------------- global circuit breaker -------------------------
 * Per-host cooldown answers "this mirror is tired". This answers "they are
 * refusing everyone": after three refusals in a row we stop talking to the whole
 * fleet for two minutes and let the page cache carry the site. Going quiet is
 * the only response that makes an escalation less likely rather than more.
 */
let strikes = 0;
let globalPauseUntil = 0;
const GLOBAL_STRIKES = 3;
const GLOBAL_PAUSE_MS = 120 * 1000;

function noteRefusal() {
  // A refusal is the signal that the upstream limit is lower than we thought:
  // the adaptive budget shrinks toward its base (cluster-wide).
  shared.budgetRefusal();
  if (Date.now() < globalPauseUntil) return;
  strikes += 1;
  if (strikes < GLOBAL_STRIKES) return;
  strikes = 0;
  // Fleet-wide, not just this process: one replica noticing the block is enough
  // to make every replica stop asking, so N replicas cost 3 refusals, not 3N.
  const trip = shared.breakerTrip("upstream refused");
  globalPauseUntil = Math.max(globalPauseUntil, trip.until);
  console.warn(
    "[xhFetch] refused " + GLOBAL_STRIKES + "x — pausing upstream for " +
    Math.round((trip.until - Date.now()) / 1000) + "s (fleet-wide, level " + trip.level + ")"
  );
  persistHealth();
}

function jitter(ms) {
  const spread = Math.round(ms * 0.35);
  return Math.max(1000, ms - spread + Math.round(Math.random() * spread * 2));
}

function cooldownFor(host, err) {
  const fails = (((health.get(host) || {}).fails) || 0) + 1;
  const sc = err && err.status;
  const base = sc === 403 ? 120000 : sc === 429 ? 180000 : sc >= 500 ? 30000 : 15000;
  const grown = Math.min(COOLDOWN_MAX_MS, base * Math.pow(2, Math.min(fails - 1, 4)));
  // Retry-After is an explicit instruction: never come back earlier than it.
  const told = err && err.retryAfter ? Math.min(err.retryAfter, COOLDOWN_MAX_MS) : 0;
  return jitter(Math.max(grown, told));
}

function markOk(host) {
  shared.budgetSuccess();   // success grows the adaptive upstream budget
  // They answered us: close the breaker everywhere so the fleet resumes.
  if (globalPauseUntil || shared.breakerStatus().active) {
    globalPauseUntil = 0;
    shared.breakerReset();
  }
  const h = health.get(host) || { fails: 0 };
  const wasCooling = (h.cooldownUntil || 0) > 0;
  h.fails = 0;
  h.cooldownUntil = 0;
  h.lastOk = Date.now();
  health.set(host, h);
  strikes = 0;
  if (wasCooling) persistHealth();
  if (lastGoodHost !== host) {
    if (lastGoodHost) console.log("[xhFetch] host switch", lastGoodHost, "->", host);
    lastGoodHost = host;
  }
}

function markBad(host, cooldownMs, reason) {
  const h = health.get(host) || { fails: 0 };
  h.fails += 1;
  h.cooldownUntil = Math.max(h.cooldownUntil || 0, Date.now() + cooldownMs);
  h.lastErr = String(reason || "");
  health.set(host, h);
  if (lastGoodHost === host) lastGoodHost = "";
  console.warn("[xhFetch] host down", host, "-", h.lastErr, "cooldown", Math.round(cooldownMs / 1000) + "s");
  persistHealth();
}

/** Sticky last-good first, then every host not currently cooling down. */
function candidates() {
  const now = Date.now();
  const fresh = HOST_POOL.filter((h) => ((health.get(h) || {}).cooldownUntil || 0) <= now);
  const order = [];
  if (lastGoodHost && fresh.includes(lastGoodHost)) order.push(lastGoodHost);
  for (const h of fresh) if (h !== lastGoodHost) order.push(h);
  // Everything cooling down? Try anyway — a stale cooldown is not a hard answer.
  return order.length ? order : HOST_POOL.slice();
}

/* Attempt one host, preferring a rotating egress proxy when configured.
 * A proxy that fails at the transport level is retired and the *same host* is
 * retried directly: the mirror may be perfectly healthy, and cooling it down
 * would poison the only address that still works. An HTTP status from upstream
 * is a real answer, so it propagates and the caller rotates as before. */
async function attemptWithEgress(host, pathAndQuery, headers, timeoutMs, redirects) {
  const pick = egress.enabled("page") ? egress.agentFor("page") : null;
  if (!pick) {
    return { got: await attemptOnce(host, pathAndQuery, headers, timeoutMs, redirects, null), pick: null };
  }
  try {
    const got = await attemptOnce(host, pathAndQuery, headers, timeoutMs, redirects, pick.agent);
    egress.report(pick.entry, true);
    return { got, pick };
  } catch (e) {
    const sc = e && e.status;
    egress.report(pick.entry, false, sc ? "http " + sc : ((e && e.message) || "error"));
    if (sc) throw e;
    const got = await attemptOnce(host, pathAndQuery, headers, timeoutMs, redirects, null);
    return { got, pick: null };
  }
}

/* ---------- Global soft pacing for background hits ---------- */
const BG_GAP_MS = 1200;           // ≥1 background hit / 1.2 s — burst-safe
let bgChain = Promise.resolve();
let lastBgHit = 0;

function pace(priority) {
  if (priority === 0) return Promise.resolve();   // user clicks: never wait
  bgChain = bgChain.then(async () => {
    const gap = BG_GAP_MS + Math.floor(Math.random() * 400);
    const wait = Math.max(0, lastBgHit + gap - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastBgHit = Date.now();
  }).catch(() => {});
  return bgChain;
}

/* ------------------------------ one attempt ------------------------------- */
function parseRetryAfter(v) {
  if (!v) return 0;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function attemptOnce(host, pathAndQuery, headers, timeoutMs, redirects, agent) {
  const target = "https://" + host + pathAndQuery;
  const left = redirects == null ? 3 : redirects;

  const jar = cookieHeader();
  const sendHeaders = jar
    ? Object.assign({}, headers, { Cookie: headers.Cookie ? headers.Cookie + "; " + jar : jar })
    : headers;

  return new Promise((resolve, reject) => {
    const req = https.request(target, { agent: agent || xhAgent, method: "GET", headers: sendHeaders, timeout: timeoutMs }, (res) => {
      const sc = res.statusCode || 0;
      if (res.headers["set-cookie"]) storeCookies(res.headers["set-cookie"]);

      if (sc >= 301 && sc <= 308 && res.headers.location && left > 0) {
        res.resume();
        let nextHref;
        try { nextHref = new URL(res.headers.location, target); } catch (e) { return reject(e); }
        const nextHost = nextHref.hostname;
        if (!isPoolHost(nextHost)) {
          const err = new Error("redirect out of family: " + nextHost);
          err.status = 403;
          return reject(err);
        }
        return resolve(attemptOnce(nextHost, nextHref.pathname + nextHref.search, headers, timeoutMs, left - 1, agent));
      }
      // 304 Not Modified (RFC 9110 §15.4.5): we asked "has this changed?" and
      // the answer is "no". No body arrives, nothing needs parsing — the
      // cheapest possible upstream exchange, and the one every real browser and
      // CDN makes. This is why conditional requests are the backbone of polite
      // crawling: re-validation costs a few hundred bytes.
      if (sc === 304) {
        res.resume();
        return resolve({
          body: "",
          host,
          notModified: true,
          etag: String(res.headers.etag || ""),
          lastModified: String(res.headers["last-modified"] || ""),
          cacheControl: String(res.headers["cache-control"] || ""),
        });
      }
      if (sc !== 200) {
        res.resume();
        const err = new Error("xh http " + sc);
        err.status = sc;
        const wait = parseRetryAfter(res.headers["retry-after"]);
        if (wait) err.retryAfter = wait;
        return reject(err);
      }

      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > 12 * 1024 * 1024) return req.destroy(new Error("body too large"));
        chunks.push(c);
      });
      res.on("end", () => resolve({
        body: decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]),
        host,
        notModified: false,
        etag: String(res.headers.etag || ""),
        lastModified: String(res.headers["last-modified"] || ""),
        cacheControl: String(res.headers["cache-control"] || ""),
      }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("xh timeout " + timeoutMs + "ms")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET a page from the xHamster fleet.
 *
 * @param {string} url   any URL whose hostname belongs to the fleet; the host is
 *                       replaced with whichever mirror is currently healthy.
 * @param {object} opts  { timeoutMs, budgetMs, priority, headers, validate,
 *                         validators, meta }
 *                       validate(body) -> bool; a mirror that answers 200 but
 *                       ships a block page is treated as down.
 *                       validators { etag, lastModified } turns the request into
 *                       a conditional GET, so an unchanged page comes back 304.
 *                       meta: true resolves { notModified, body, etag,
 *                       lastModified } instead of a bare string.
 * @returns {Promise<string|object>} the body, or the meta object
 */
async function xhFetchText(url, opts) {
  const o = opts || {};
  const perTry = o.timeoutMs || 6500;
  const deadline = Date.now() + (o.budgetMs || perTry + 4000);
  const priority = o.priority === 0 ? 0 : 1;
  const validate = typeof o.validate === "function" ? o.validate : null;
  // Header set mirrors Chrome 125 on Windows. A bare `User-Agent` with two
  // headers is the cheapest bot tell there is; these are the headers a real
  // navigation actually carries. We add slight variance so every request
  // doesn't have identical fingerprints.
  const ua = getRandomUA();
  const uaMajor = ua.match(/Chrome\/(\d+)/)?.[1] || "125";
  const secUa = `"Chromium";v="${uaMajor}", "Not.A/Brand";v="24", "Google Chrome";v="${uaMajor}"`;
  const headers = Object.assign({
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": ["en-US,en;q=0.9", "en-GB,en;q=0.9", "en-US,en;q=0.8"][Math.floor(Math.random() * 3)],
    "Accept-Encoding": "gzip, deflate, br",
    "sec-ch-ua": secUa,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',   // must agree with the UA above
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": ["none", "same-origin"][Math.floor(Math.random() * 2)],
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    Connection: "keep-alive",
  }, o.headers || {});

  // Conditional request headers. If-None-Match wins over If-Modified-Since
  // because an ETag is content-exact and a date is only second-granular.
  const validators = o.validators || null;
  if (validators) {
    if (validators.etag) headers["If-None-Match"] = validators.etag;
    else if (validators.lastModified) headers["If-Modified-Since"] = validators.lastModified;
  }
  const meta = !!o.meta;

  let base;
  try { base = new URL(url); } catch (e) { throw new Error("bad upstream url"); }
  const pathAndQuery = base.pathname + base.search;

  // Circuit breaker tripped (locally or by another replica): serve from cache
  // and stay silent. Asking again 200 ms later is what an impatient scraper
  // does — and what turns a rate limit into a ban.
  if (Date.now() < globalPauseUntil || (await shared.breakerActive())) {
    const err = new Error("upstream cooling down — serving cache only");
    err.status = 503;
    err.globalPause = true;
    err.directFailed = true;
    throw err;
  }

  let lastErr = null;
  let tried = 0;

  for (const host of candidates()) {
    if (tried >= 3) break;
    const left = deadline - Date.now();
    if (left < 900) break;
    tried++;

    await pace(priority);
    const timeoutMs = Math.min(perTry, Math.max(1000, left));

    let release;
    try {
      // Global governor: user-facing fetches jump the queue but still obey the
      // hard rate cap, so a traffic spike never becomes an upstream burst.
      release = await acquireSlot(priority, deadline);
    } catch (e) {
      lastErr = e;
      break;
    }

    try {
      const attempt = await attemptWithEgress(host, pathAndQuery, headers, timeoutMs, 3);
      const got = attempt.got;
      if (got.notModified) {
        markOk(got.host);
        return meta
          ? {
              notModified: true,
              body: "",
              etag: got.etag || (validators && validators.etag) || "",
              lastModified: got.lastModified || (validators && validators.lastModified) || "",
              cacheControl: got.cacheControl || "",
            }
          : "";
      }
      if (validate && !validate(got.body)) {
        egress.report(attempt.pick && attempt.pick.entry, false, "invalid payload");
        markBad(got.host, 60000, "invalid payload");
        lastErr = new Error("invalid payload from " + got.host);
        continue;
      }
      markOk(got.host);
      return meta
        ? {
            notModified: false,
            body: got.body,
            etag: got.etag || "",
            lastModified: got.lastModified || "",
            cacheControl: got.cacheControl || "",
          }
        : got.body;
    } catch (e) {
      lastErr = e;
      const sc = e && e.status;
      const st = dnsState.get(host);
      if (st) st.idx++;                      // next try dials the other edge IP

      if (sc === 404) continue;              // this mirror simply lacks the path
      if (sc === 403 || sc === 429) noteRefusal();
      markBad(host, cooldownFor(host, e), sc ? "http " + sc : ((e && e.message) || "error"));

      // A refusal means stop asking, not try the next host immediately.
      if (Date.now() < globalPauseUntil) break;
    } finally {
      if (release) release();
    }
  }

  const err = lastErr || new Error("xh fetch failed");
  err.directFailed = true;
  throw err;
}

/* ---------- /api/front/search/suggest (CONFIRMED, report §6a) ---------- */
const SUGGEST_URL = "https://" + XH_HOST + "/api/front/search/suggest?searchValue=<q>&searchScope=common&orientation=0";
let suggestCsrf = crypto.randomBytes(16).toString("hex");

/* Typing is the highest-frequency upstream call in the whole app, and it used to
 * bypass background pacing entirely. One upstream suggest per 600ms, no matter
 * how many people are typing; the local cache absorbs almost every keystroke. */
const SUGGEST_GAP_MS = 600;
let suggestChain = Promise.resolve();
let lastSuggestAt = 0;

function paceSuggest() {
  suggestChain = suggestChain.then(async () => {
    const wait = Math.max(0, lastSuggestAt + SUGGEST_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSuggestAt = Date.now();
  }).catch(() => {});
  return suggestChain;
}

async function xhSuggest(q) {
  const clean = String(q || "").trim().slice(0, 50);
  if (clean.length < 2) return [];
  const url = SUGGEST_URL.replace("<q>", encodeURIComponent(clean));
  await paceSuggest();
  const body = await xhFetchText(url, {
    timeoutMs: 5000,
    priority: 0,                                  // user is typing — serve instantly
    headers: {
      "Cookie": "x_csrf_token=" + suggestCsrf,
      "x-csrf-token": suggestCsrf,                // double-submit: cookie + header same value
      "x-requested-with": "XMLHttpRequest",
      "Accept": "application/json, text/plain, */*",
      // This is an XHR from their own page, not a navigation — say so.
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      Referer: "https://" + XH_HOST + "/",
    },
  });
  const arr = JSON.parse(body);
  if (!Array.isArray(arr)) throw new Error("suggest: unexpected shape");
  return arr.slice(0, 8).map((it) => ({
    text: it.plainText || (it.text || "").replace(/<\/?b>/g, ""),
    kind: it.type2 || "search",
    link: it.link || "",
    count: typeof it.count === "number" ? it.count : null,
    avatar: (it.avatar && it.avatar.url) || it.avatar || "",
  })).filter((s) => s.text);
}

/* ---------- introspection ---------- */
function poolStatus() {
  const now = Date.now();
  return HOST_POOL.map((host) => {
    const h = health.get(host) || {};
    return {
      host,
      available: (h.cooldownUntil || 0) <= now,
      active: host === lastGoodHost,
      fails: h.fails || 0,
      cooldownMs: Math.max(0, (h.cooldownUntil || 0) - now),
      lastOk: h.lastOk || 0,
      lastErr: h.lastErr || "",
    };
  });
}

const resolveIps = (force) => resolveHost(XH_HOST, force);
const prewarmIps = () => resolveHost(XH_HOST, false).catch(() => {});

hydrateHealth();   // fire-and-forget for local mode; server re-runs after shared.init()

module.exports = {
  xhFetchText,
  xhSuggest,
  hydrateHealth,
  prewarmIps,
  resolveIps,
  poolStatus,
  jarStatus: () => ({
    cookies: cookies.size,
    inflight: inflightCount,
    queued: waiters.length,
    tokens: Math.round(tokens * 10) / 10,
    quietForMs: Math.max(0, globalPauseUntil - Date.now()),
    strikes,
    breaker: shared.breakerStatus(),
  }),
  HOST_POOL,
  UA,
};
