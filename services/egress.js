/* egress.js — optional rotating egress for the upstream requests.
 *
 * Why: a block on this server's one IP takes the whole site down. xHamster's
 * limiter buckets per IP, so swapping `.com` mirror hostnames buys nothing — the
 * requests still leave from the same address. The only real defence is to leave
 * from many addresses.
 *
 * Configure any HTTP(S) or SOCKS5 proxy endpoints:
 *
 *   EGRESS_PROXIES=http://user:pass@host:port,socks5://user:pass@host2:port
 *   PROXY_HTTP_URL=...      (single-endpoint shorthand)
 *   PROXY_SOCKS5_URL=...
 *
 * and choose what goes through them:
 *
 *   EGRESS_SCOPE=pages            (default: HTML page fetches only)
 *   EGRESS_SCOPE=pages,thumbs     (+ thumbnails)
 *   EGRESS_SCOPE=all              (+ video/playlists — expensive, see DEPLOY.md)
 *
 * Rotation: `keepAlive` is off on these agents, so every request opens a fresh
 * tunnel and a rotating gateway hands out a new IP. Entries cool down on failure
 * with exponential backoff; when every entry is cooling down the caller falls
 * back to the direct connection, so a dead proxy vendor never becomes a dead site.
 *
 * Credentials stay in env. `status()` deliberately exposes counts only — never a
 * proxy URL, because those contain the username and password.
 */
let HttpsProxyAgent = null;
let SocksProxyAgent = null;
try { ({ HttpsProxyAgent } = require("https-proxy-agent")); } catch (e) { /* optional dependency */ }
try { ({ SocksProxyAgent } = require("socks-proxy-agent")); } catch (e) { /* optional dependency */ }

const SCOPE = new Set(
  String(process.env.EGRESS_SCOPE || "pages")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);

const RAW = [process.env.EGRESS_PROXIES, process.env.PROXY_HTTP_URL, process.env.PROXY_SOCKS5_URL]
  .filter(Boolean).join(",");

const POOL = [];

for (const entry of String(RAW).split(",")) {
  const url = entry.trim();
  if (!url) continue;
  let parsed;
  try { parsed = new URL(url); } catch (e) {
    console.warn("[egress] ignoring malformed proxy entry");
    continue;
  }
  const socks = /^socks/i.test(parsed.protocol);
  if (!socks && !/^https?:$/.test(parsed.protocol)) {
    console.warn("[egress] unsupported proxy protocol:", parsed.protocol);
    continue;
  }
  const Agent = socks ? SocksProxyAgent : HttpsProxyAgent;
  if (!Agent) {
    console.warn("[egress] no agent installed for", parsed.protocol, "— run npm install");
    continue;
  }
  let agent;
  try {
    // keepAlive:false → each request gets its own tunnel → a rotating gateway
    // hands out a fresh egress IP instead of pinning us to one.
    agent = new Agent(url, { keepAlive: false });
  } catch (e) {
    console.warn("[egress] bad proxy entry:", e.message);
    continue;
  }
  POOL.push({ agent, fails: 0, cooldownUntil: 0 });
}

if (POOL.length) {
  console.log("[egress] " + POOL.length + " proxy endpoint(s) configured, scope=" + [...SCOPE].join(","));
}

let cursor = 0;

function enabled(kind) {
  if (!POOL.length) return false;
  if (SCOPE.has("all")) return true;
  // Callers say "page"/"thumb"/"stream"; operators configure "pages,thumbs".
  // Accept either form so the two spellings cannot silently disable egress.
  const k = String(kind || "");
  return SCOPE.has(k) || SCOPE.has(k + "s");
}

/** Next healthy proxy for this kind of request, or null (caller goes direct). */
function agentFor(kind) {
  if (!enabled(kind)) return null;
  const now = Date.now();
  for (let i = 0; i < POOL.length; i++) {
    const entry = POOL[(cursor + i) % POOL.length];
    if ((entry.cooldownUntil || 0) <= now) {
      cursor = (cursor + i + 1) % POOL.length;
      return { agent: entry.agent, entry };
    }
  }
  return null;
}

function report(entry, ok, reason) {
  if (!entry) return;
  if (ok) {
    entry.fails = 0;
    entry.cooldownUntil = 0;
    return;
  }
  entry.fails += 1;
  const base = 20 * 1000;
  const grown = base * Math.pow(2, Math.min(entry.fails - 1, 4));
  entry.cooldownUntil = Date.now() + Math.min(15 * 60 * 1000, grown);
  console.warn("[egress] endpoint cooling down for", Math.round((entry.cooldownUntil - Date.now()) / 1000) + "s", "-", String(reason || "error"));
}

function status() {
  const now = Date.now();
  return {
    endpoints: POOL.length,
    scope: [...SCOPE],
    available: POOL.filter((e) => (e.cooldownUntil || 0) <= now).length,
    cooling: POOL.filter((e) => (e.cooldownUntil || 0) > now).length,
  };
}

module.exports = { enabled, agentFor, report, status, SCOPE };
