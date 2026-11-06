/* cdn-http.js — shared keep-alive HTTPS client for xHamster's CDN edges.
 *
 * Why this exists: every thumbnail and every HLS segment used to go out through
 * the global `fetch()` (undici), which:
 *   - opens a NEW TLS connection for most requests once the pool idles out
 *     (~300–400ms handshake to the Singapore/SG edge on this ISP),
 *   - blocks the 4-thread libuv pool on getaddrinfo() when many requests fire
 *     at once (a page = 36 thumbs → visible multi-second stall),
 *   - has no cross-request connection affinity, so warm segments cannot ride an
 *     existing socket.
 *
 * A dedicated https.Agent with keepAlive + our own DNS cache (c-ares, cached for
 * 15 min) makes cold thumbnails ~2× faster and stops 36 parallel fetches from
 * queueing behind each other.
 *
 * Measured on this machine (diag-cdn-bench.cjs): cold thumb ~780ms via fetch,
 * ~360–420ms with the keep-alive agent + warm socket.
 */
const https = require("https");
const dns = require("dns");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/* ---------- DNS cache (c-ares, so it never touches the libuv threadpool) ---------- */
const dnsCache = new Map(); // host -> { ip, ts }
const DNS_TTL = 15 * 60 * 1000;

function cachedLookup(hostname, opts, cb) {
  const hit = dnsCache.get(hostname);
  if (hit && Date.now() - hit.ts < DNS_TTL) {
    if (opts && opts.all) return cb(null, [{ address: hit.ip, family: 4 }]);
    return cb(null, hit.ip, 4);
  }
  dns.resolve4(hostname, (err, addrs) => {
    if (!err && addrs && addrs.length) {
      const ip = addrs[0];
      dnsCache.set(hostname, { ip, ts: Date.now() });
      if (opts && opts.all) return cb(null, [{ address: ip, family: 4 }]);
      return cb(null, ip, 4);
    }
    // System resolver fallback (works when c-ares is blocked)
    dns.lookup(hostname, opts, cb);
  });
}

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  keepAliveMsecs: 60 * 1000,
  timeout: 45 * 1000,
  lookup: cachedLookup,
});

/* Same DNS-cached agent for plain http? The CDN is https-only; keep it simple. */

/**
 * Raw request (no body buffering). Resolves with the IncomingMessage so callers
 * can pipe big HLS segments straight to the client response.
 * @returns {Promise<{status:number, headers:object, stream:import('http').IncomingMessage}>}
 */
function cdnRequest(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 15000;
  const headers = Object.assign({ "User-Agent": UA, "Accept-Encoding": "identity" }, o.headers || {});
  let redirectsLeft = o.redirects == null ? 3 : o.redirects;

  return new Promise((resolve, reject) => {
    const go = (target, left) => {
      let req;
      try {
        req = https.request(target, { method: o.method || "GET", agent, headers, timeout: timeoutMs }, (res) => {
          const sc = res.statusCode || 0;
          if (sc >= 301 && sc <= 308 && res.headers.location && left > 0) {
            res.resume();
            let next;
            try { next = new URL(res.headers.location, target).href; } catch (e) { return reject(e); }
            return go(next, left - 1);
          }
          res._cdnUrl = target;
          resolve({ status: sc, headers: res.headers, stream: res, url: target });
        });
      } catch (e) { return reject(e); }
      req.on("timeout", () => req.destroy(new Error("cdn timeout " + timeoutMs + "ms")));
      req.on("error", reject);
      req.end();
    };
    go(url, redirectsLeft);
  });
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** GET a full body into a Buffer, with retries (GET is idempotent). */
async function cdnGetBuffer(url, opts, attempts) {
  const tries = attempts || 2;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await cdnRequest(url, opts);
      if (r.status === 200 || r.status === 206) {
        return { buf: await collect(r.stream), ctype: r.headers["content-type"] || "", status: r.status };
      }
      r.stream.resume();
      if (r.status >= 400 && r.status < 500) {
        const err = new Error("cdn http " + r.status);
        err.status = r.status;
        throw err;
      }
      lastErr = new Error("cdn http " + r.status);
    } catch (e) {
      lastErr = e;
      if (e && e.status) break; // hard 4xx — no retry
    }
  }
  throw lastErr || new Error("cdn fetch failed");
}

async function cdnGetText(url, opts, attempts) {
  const r = await cdnGetBuffer(url, opts, attempts);
  return r.buf.toString("utf8");
}

/* Pre-open TCP+TLS to the CDN hosts the app uses, so the very first thumbnail /
 * segment does not pay for a handshake. Best-effort, fire and forget. */
function preconnect(hosts) {
  for (const h of hosts || []) {
    cdnRequest("https://" + h + "/", { timeoutMs: 6000, redirects: 0 })
      .then((r) => { r.stream.resume(); })
      .catch(() => {});
  }
}

module.exports = { cdnRequest, cdnGetBuffer, cdnGetText, preconnect, agent, UA };
