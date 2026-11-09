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
const { isAllowedCdnHost } = require("./secure-url");
const egress = require("./egress");

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

  // CDN routes are direct by default: residential proxy bandwidth is metered per
  // GB, so only opt in (EGRESS_SCOPE) when this edge actually refuses us.
  const kind = o.kind || "thumb";
  const picked = o.agent ? null : (egress.enabled(kind) ? egress.agentFor(kind) : null);
  const useAgent = o.agent || (picked && picked.agent) || agent;
  let reported = false;
  const report = (ok, reason) => {
    if (!picked || reported) return;
    reported = true;
    egress.report(picked.entry, ok, reason);
  };

  return new Promise((resolve, reject) => {
    const go = (target, left) => {
      // Defense in depth: a redirect (or a caller bug) must never turn this into
      // a general-purpose proxy. Only known CDN hosts over https, and no
      // redirect can escape that set.
      let targetUrl;
      try { targetUrl = new URL(target); } catch (e) { return reject(e); }
      if (targetUrl.protocol !== "https:" || !isAllowedCdnHost(targetUrl.hostname)) {
        const err = new Error("cdn host not allowed");
        err.status = 403;
        return reject(err);
      }
      let req;
      try {
        req = https.request(targetUrl, { method: o.method || "GET", agent: useAgent, headers, timeout: timeoutMs }, (res) => {
          const sc = res.statusCode || 0;
          report(sc < 400, "http " + sc);
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
      req.on("error", (err) => {
        report(false, (err && err.message) || "error");
        reject(err);
      });
      req.end();
    };
    go(url, redirectsLeft);
  });
}

function collect(stream, maxBytes) {
  const limit = maxBytes || 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        // Never buffer an unbounded upstream body: a single huge object used to
        // be enough to exhaust this process' memory through the thumb route.
        stream.destroy();
        const err = new Error("cdn body too large");
        err.tooLarge = true;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** GET a full body into a Buffer, with retries (GET is idempotent). */
async function cdnGetBuffer(url, opts, attempts) {
  const tries = attempts || 2;
  const maxBytes = (opts && opts.maxBytes) || 8 * 1024 * 1024;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await cdnRequest(url, opts);
      if (r.status === 200 || r.status === 206) {
        const cl = Number(r.headers["content-length"]);
        if (Number.isFinite(cl) && cl > maxBytes) {
          r.stream.destroy();
          const err = new Error("cdn body too large");
          err.tooLarge = true;
          throw err;
        }
        return { buf: await collect(r.stream, maxBytes), ctype: r.headers["content-type"] || "", status: r.status };
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
      if (e && (e.status || e.tooLarge)) break; // hard 4xx / oversized — no retry
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
    cdnRequest("https://" + h + "/", { timeoutMs: 6000, redirects: 0, agent })
      .then((r) => { r.stream.resume(); })
      .catch(() => {});
  }
}

module.exports = { cdnRequest, cdnGetBuffer, cdnGetText, preconnect, agent, UA };
