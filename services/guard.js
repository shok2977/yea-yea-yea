/* guard.js — per-client request caps.
 *
 * The upstream governor in xh-fetch.js limits the *aggregate* rate the way one
 * person browsing looks. That is not enough on its own: a single caller looping
 * `/api/search?q=…` could occupy every upstream slot for everyone else, and a
 * caller looping `/api/thumb` could make this machine pull unlimited objects
 * from xHamster's CDN — the egress pattern their edge reacts to with a 403 for
 * our IP (which breaks the site for every visitor at once).
 *
 * So each endpoint also gets a small, cheap per-client budget. Identities come
 * from the socket address, not from a header, unless TRUST_PROXY=1 is set
 * explicitly (behind a known reverse proxy). Spoofing X-Forwarded-For must never
 * buy a fresh budget by default.
 */

const WINDOW_SWEEP_MS = 60 * 1000;
const MAX_TRACKED_CLIENTS = 50000;

function clientIp(req) {
  if (process.env.TRUST_PROXY === "1") {
    const xf = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
    if (xf) return xf;
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/** Quota identity: the signed-in invite fingerprint when the gate is on, else
 * the socket address. One invite therefore shares one budget, no matter how many
 * sessions or devices it opens. */
function identity(req) {
  if (req && req.userId) return "u:" + req.userId;
  return "ip:" + clientIp(req);
}

/* ------------------------------- rate limit ------------------------------- */
const hits = new Map();   // name|client -> { n, reset }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
}, WINDOW_SWEEP_MS).unref();

function rateLimit(opts) {
  const windowMs = (opts && opts.windowMs) || 60000;
  const max = (opts && opts.max) || 60;
  const name = (opts && opts.name) || "rl";
  return function rateLimiter(req, res, next) {
    if (hits.size > MAX_TRACKED_CLIENTS) {
      const now = Date.now();
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
      // Still huge means a distributed flood; fail open on memory, not on policy.
      if (hits.size > MAX_TRACKED_CLIENTS) hits.clear();
    }
    const key = name + "|" + identity(req);
    const now = Date.now();
    let slot = hits.get(key);
    if (!slot || slot.reset <= now) {
      slot = { n: 0, reset: now + windowMs };
      hits.set(key, slot);
    }
    slot.n += 1;
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(Math.max(0, max - slot.n)));
    if (slot.n > max) {
      const retry = Math.max(1, Math.ceil((slot.reset - now) / 1000));
      res.set("Retry-After", String(retry));
      return res.status(429).json({ success: false, error: "too many requests — slow down" });
    }
    next();
  };
}

/* ----------------------------- concurrency cap -----------------------------
 * A limit on *parallel* requests per client, not per minute. This is what stops
 * one tab (or one script) from opening hundreds of HLS segments/sockets at once
 * and starving the shared keep-alive pool.
 */
const live = new Map();   // name|client -> count

function concurrent(opts) {
  const max = (opts && opts.max) || 16;
  const name = (opts && opts.name) || "cc";
  return function concurrencyLimiter(req, res, next) {
    const key = name + "|" + identity(req);
    const active = live.get(key) || 0;
    if (active >= max) {
      res.set("Retry-After", "1");
      return res.status(429).json({ success: false, error: "too many parallel requests" });
    }
    live.set(key, active + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (live.get(key) || 1) - 1;
      if (left <= 0) live.delete(key); else live.set(key, left);
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  };
}

/* --------------------------- global upstream budget -------------------------
 * Delegated to the shared cluster budget (services/shared.js): one adaptive
 * token bucket for the whole fleet, starting at UPSTREAM_BUDGET_PER_MIN
 * (default 300) and growing on successes up to UPSTREAM_BUDGET_MAX_PER_MIN
 * (default 6000). No fixed ceiling at our layer — the budget follows what
 * upstream actually tolerates. Falls back to a local bucket without Redis.
 */
const shared = require("./shared");

/** Take one page-fetch credit. false => serve stale / 503 instead of fetching. */
async function takeUpstream() {
  // Fleet-wide breaker: upstream is refusing everyone, so spend nothing. This is
  // what turns a spike into cached pages instead of a spike into a ban.
  if (await shared.breakerActive()) return false;
  const r = await shared.budgetTake();
  return r.granted;
}

function budgetStatus() {
  return shared.budgetStatus();
}

module.exports = { rateLimit, concurrent, clientIp, identity, takeUpstream, budgetStatus };
