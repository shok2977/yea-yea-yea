"use strict";
/*
 * shared.js — cluster-wide state for horizontally scaled deployments.
 *
 * A single instance already serves the site fine (in-memory L1 + best-effort
 * disk snapshot). Two or more instances, however, would each keep their own
 * page cache and their own upstream budget — and N instances × their own budget
 * is exactly how a fleet pushes itself into a block.
 *
 * This module is the shared layer:
 *  - page cache entries (`ts:page:<key>`) — every replica reads/writes the same
 *    entries, so a warm page on replica A is a hit on replica B without an
 *    upstream fetch.
 *  - the upstream budget (token bucket + adaptive limit) — one bucket for the
 *    whole fleet, so scaling replicas cannot multiply upstream pressure.
 *  - upstream host health + DoH pins (`ts:health`) — cooldowns are fleet-wide.
 *
 * When REDIS_URL is not set (or Redis is unreachable at boot) everything falls
 * back to per-process state with the same semantics: the site still works,
 * it just does not share cache across replicas. That fallback is the default
 * for `npm start` and CI; production sets REDIS_URL.
 *
 * Budget model: there is no fixed requests-per-minute ceiling at our layer.
 * The limit is adaptive (AIMD): it starts at UPSTREAM_BUDGET_PER_MIN (default
 * 300) and grows ~1% on every successful upstream response, up to
 * UPSTREAM_BUDGET_MAX_PER_MIN (default 6000), shrinking back toward the base
 * on refusals (403/429). A token bucket (`UPSTREAM_BUDGET_BURST`, default
 * 1200) smooths bursts. The reason for pacing at all is upstream, not us:
 * xHamster rate-limits *IPs*; hammering past their tolerance gets the egress
 * IP blocked, after which the site serves nothing at all. Because most pages
 * come from the shared cache, the steady-state upstream rate stays far below
 * any limit and the AIMD limit mostly sits idle at its ceiling.
 */

const REDIS_URL = String(process.env.REDIS_URL || "").trim();

const BUDGET_BASE = Math.max(1, parseBudgetInt(process.env.UPSTREAM_BUDGET_PER_MIN, 300));
const BUDGET_MAX = Math.max(BUDGET_BASE, parseBudgetInt(process.env.UPSTREAM_BUDGET_MAX_PER_MIN, 6000));
const BUDGET_BURST = Math.max(10, parseBudgetInt(process.env.UPSTREAM_BUDGET_BURST, 1200));
const BUDGET_DISABLED = String(process.env.UPSTREAM_BUDGET_PER_MIN || "") === "0";

function parseBudgetInt(raw, dflt) {
  const n = parseInt(String(raw == null ? "" : raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/* ------------------------------- local state ------------------------------- */
const local = {
  limit: BUDGET_BASE,
  tokens: BUDGET_BURST,
  last: Date.now(),
};

function localTake() {
  if (BUDGET_DISABLED) return { granted: true, available: Infinity, limit: Infinity };
  const now = Date.now();
  // dt >= 0: a backward clock jump (NTP correction, DST, VM resume) must refill
  // nothing — not drain the bucket and black out upstream for minutes.
  const dt = Math.max(0, Math.min(60, (now - local.last) / 1000));
  local.tokens = Math.min(BUDGET_BURST, Math.max(0, local.tokens) + dt * (local.limit / 60));
  local.last = now;
  if (local.tokens < 1) return { granted: false, available: 0, limit: local.limit };
  local.tokens -= 1;
  lastStatus = { limit: local.limit, available: Math.floor(local.tokens) };
  return { granted: true, available: Math.floor(local.tokens), limit: local.limit };
}

function localSuccess() {
  local.limit = Math.min(BUDGET_MAX, local.limit + Math.max(1, local.limit * 0.01));
}

function localRefusal() {
  local.limit = Math.max(BUDGET_BASE, local.limit * 0.5);
}

/* --------------------------------- redis --------------------------------- */
let client = null;
let mode = "local";
let lastStatus = { limit: BUDGET_BASE, available: 0 };

const KEY = "ts:budget";

const LUA_TAKE = `
local K = KEYS[1]
local now = tonumber(ARGV[1])
local base = tonumber(ARGV[2])
local mx = tonumber(ARGV[3])
local burst = tonumber(ARGV[4])
local h = redis.call('HMGET', K, 'tokens', 'limit', 'last')
local tokens = tonumber(h[1])
if not tokens then tokens = burst end
local limit = tonumber(h[2])
if not limit or limit <= 0 then limit = base end
local last = tonumber(h[3]) or now
local dt = math.max(0, math.min(60, (now - last) / 1000))
tokens = math.min(burst, math.max(0, tokens) + dt * (limit / 60))
local ok = 0
if tokens >= 1 then ok = 1 tokens = tokens - 1 end
redis.call('HMSET', K, 'tokens', tokens, 'limit', limit, 'last', now)
redis.call('EXPIRE', K, 86400)
return { ok, math.floor(tokens), math.floor(limit) }
`;

const LUA_SUCCESS = `
local K = KEYS[1]
local base = tonumber(ARGV[1])
local mx = tonumber(ARGV[2])
local limit = tonumber(redis.call('HGET', K, 'limit')) or base
limit = math.min(mx, limit + math.max(1, limit * 0.01))
redis.call('HSET', K, 'limit', limit)
return math.floor(limit)
`;

const LUA_REFUSAL = `
local K = KEYS[1]
local base = tonumber(ARGV[1])
local limit = tonumber(redis.call('HGET', K, 'limit')) or base
limit = math.max(base, limit * 0.5)
redis.call('HSET', K, 'limit', limit)
return math.floor(limit)
`;

/* Booting must never wait on Redis. node-redis retries forever by design, so
 * `await connect()` alone would hang the boot when Redis is not up yet and the
 * site would never listen. We therefore give it a short window, then start in
 * local mode and let the background reconnect upgrade the process to shared
 * state whenever Redis appears — no restart, no restart-visible outage. */
const CONNECT_WAIT_MS = 2500;

async function init() {
  if (!REDIS_URL) return getMode();
  let createClient;
  try {
    createClient = require("redis").createClient;
  } catch (e) {
    console.warn("[shared] redis package unavailable — running local:", e.message);
    return getMode();
  }

  try {
    client = createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: 2000,
        // Capped backoff forever: a Redis that comes back later must rejoin the
        // fleet on its own.
        reconnectStrategy: (r) => Math.min(200 * r, 3000),
      },
    });
  } catch (e) {
    console.warn("[shared] redis client init failed — running local:", e.message);
    client = null;
    return getMode();
  }

  let lastWarn = 0;
  client.on("error", (err) => {
    const now = Date.now();
    if (now - lastWarn > 15000) {          // no log flood while it retries
      lastWarn = now;
      console.warn("[shared] redis unavailable (local mode, retrying):", err && err.message);
    }
  });
  client.on("ready", () => {
    console.log("[shared] Redis connected — shared cache, adaptive budget", BUDGET_BASE + "→" + BUDGET_MAX + "/min");
  });

  await Promise.race([
    client.connect().catch(() => null),
    new Promise((r) => setTimeout(r, CONNECT_WAIT_MS).unref()),
  ]);

  if (isReady()) console.log("[shared] shared state active across replicas");
  else console.warn("[shared] Redis not ready — starting local; attaches automatically when it connects");
  return getMode();
}

function getMode() {
  if (client && client.isReady) return "redis";
  if (client) return "redis-reconnecting";
  return "local";
}
function isReady() { return !!client && client.isReady === true; }

/* --------------------------------- budget --------------------------------- */
async function budgetTake() {
  if (BUDGET_DISABLED) return { granted: true, available: Infinity, limit: Infinity };
  if (isReady()) {
    try {
      const r = await client.eval(LUA_TAKE, {
        keys: [KEY],
        arguments: [String(Date.now()), String(BUDGET_BASE), String(BUDGET_MAX), String(BUDGET_BURST)],
      });
      lastStatus = { limit: r[2], available: r[1] };
      return { granted: r[0] === 1, available: r[1], limit: r[2] };
    } catch (e) {
      return localTake();   // transient redis failure must not 503 the whole site
    }
  }
  return localTake();
}

/* Fire-and-forget helpers: budget feedback must never delay or break a page. */
function budgetSuccess() {
  try {
    if (isReady()) {
      client.eval(LUA_SUCCESS, { keys: [KEY], arguments: [String(BUDGET_BASE), String(BUDGET_MAX)] })
        .then((l) => { lastStatus.limit = l; })
        .catch(() => localSuccess());
    } else {
      localSuccess();
    }
  } catch (e) { /* never surface */ }
}

function budgetRefusal() {
  try {
    if (isReady()) {
      client.eval(LUA_REFUSAL, { keys: [KEY], arguments: [String(BUDGET_BASE)] })
        .then((l) => { lastStatus.limit = l; })
        .catch(() => localRefusal());
    } else {
      localRefusal();
    }
  } catch (e) { /* never surface */ }
}

function budgetStatus() {
  return {
    mode: getMode(),
    disabled: BUDGET_DISABLED,
    limit: BUDGET_DISABLED ? null : lastStatus.limit,
    available: BUDGET_DISABLED ? null : lastStatus.available,
    base: BUDGET_DISABLED ? null : BUDGET_BASE,
    max: BUDGET_DISABLED ? null : BUDGET_MAX,
    burst: BUDGET_DISABLED ? null : BUDGET_BURST,
  };
}

/* ------------------------------- page cache ------------------------------- */
const PAGE_PREFIX = "ts:page:";

function pageKey(key) { return PAGE_PREFIX + key; }

async function pageGet(key) {
  if (!isReady()) return null;
  try {
    const raw = await client.get(pageKey(key));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !entry.value || !entry.ts) return null;
    if (Date.now() - entry.ts > (entry.ttl || 0)) return null;   // fresh window only
    return entry.value;
  } catch (e) { return null; }
}

async function pageStaleGet(key, withMeta) {
  if (!isReady()) return null;
  try {
    const raw = await client.get(pageKey(key));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !entry.value || !entry.ts) return null;
    if (Date.now() - entry.ts > (entry.staleTtl || 0)) return null;
    // withMeta: also hand back the HTTP validators, so a replica that did not
    // build this entry can still revalidate it conditionally instead of
    // re-downloading the page.
    return withMeta
      ? { value: entry.value, etag: entry.etag || "", lastModified: entry.lastModified || "", hash: entry.hash || "" }
      : entry.value;
  } catch (e) { return null; }
}

function pageDel(key) {
  if (!isReady()) return;
  try { client.del(pageKey(key)).catch(() => { /* best effort */ }); } catch (e) { /* never surface */ }
}

function pageSet(key, entry) {
  if (!isReady()) return;
  try {
    const ex = Math.max(60, Math.ceil(((entry.staleTtl || entry.ttl || 3600)) / 1000));
    client.set(pageKey(key), JSON.stringify(entry), { EX: ex }).catch(() => { /* best effort */ });
  } catch (e) { /* never surface */ }
}

/* ------------------------------- host health ------------------------------- */
async function healthGet() {
  if (!isReady()) return null;
  try {
    const raw = await client.get("ts:health");
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function healthSet(json) {
  if (!isReady()) return;
  try {
    client.set("ts:health", JSON.stringify(json)).catch(() => { /* best effort */ });
  } catch (e) { /* never surface */ }
}

/* ------------------------ fleet-wide upstream breaker ----------------------
 * xh-fetch already breaks the circuit in-process after three refusals. With N
 * replicas that is 3N refusals, and every extra request pushes a limiter that is
 * already unhappy further toward a real ban. Sharing the pause fixes that: the
 * first replica that sees a block silences the whole fleet, so a rate limit
 * stays a rate limit instead of escalating into a block.
 *
 * Exponential: 2 min, 4 min, … capped at 10 min, reset by any success.
 */
const BREAKER_KEY = "ts:breaker";
const BREAKER_BASE_MS = Math.max(5000, parseInt(process.env.UPSTREAM_PAUSE_BASE_MS, 10) || 120000);
const BREAKER_MAX_MS = Math.max(
  BREAKER_BASE_MS,
  parseInt(process.env.UPSTREAM_PAUSE_MAX_MS, 10) || 10 * 60 * 1000
);
let breaker = { until: 0, level: 0 };
let breakerCheckedAt = 0;

/** Is upstream refusing the fleet right now? At most one Redis read per 2 s. */
async function breakerActive() {
  if (breaker.until > Date.now()) return true;
  if (!isReady()) return false;
  if (Date.now() - breakerCheckedAt < 2000) return false;
  breakerCheckedAt = Date.now();
  try {
    const raw = await client.get(BREAKER_KEY);
    if (!raw) return false;
    const e = JSON.parse(raw);
    if (e && e.until > Date.now()) {
      breaker = { until: e.until, level: e.level || 1 };
      return true;
    }
  } catch (e) { /* fail open: a Redis blip must never silence the site */ }
  return false;
}

/** Open the breaker fleet-wide and return when it reopens. */
function breakerTrip(reason) {
  const level = Math.min(8, (breaker.level || 0) + 1);
  const until = Date.now() + Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * Math.pow(2, level - 1));
  breaker = { until, level };
  breakerCheckedAt = Date.now();
  if (isReady()) {
    try {
      client.set(BREAKER_KEY, JSON.stringify({ until, level, reason: String(reason || "") }),
        { PX: Math.max(1000, until - Date.now()) }).catch(() => { /* best effort */ });
    } catch (e) { /* never surface */ }
  }
  return { until, level };
}

/** Upstream answered us again — close the breaker everywhere. */
function breakerReset() {
  breaker = { until: 0, level: 0 };
  breakerCheckedAt = Date.now();
  if (isReady()) {
    try { client.del(BREAKER_KEY).catch(() => { /* best effort */ }); } catch (e) { /* never surface */ }
  }
}

function breakerStatus() {
  return {
    active: breaker.until > Date.now(),
    level: breaker.level || 0,
    msLeft: Math.max(0, breaker.until - Date.now()),
  };
}

module.exports = {
  init,
  getMode,
  isReady,
  budgetTake,
  budgetSuccess,
  budgetRefusal,
  budgetStatus,
  pageGet,
  pageStaleGet,
  pageSet,
  pageDel,
  healthGet,
  healthSet,
  breakerActive,
  breakerTrip,
  breakerReset,
  breakerStatus,
};
