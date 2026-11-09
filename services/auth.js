/* auth.js — invite-only access gate for public deployments.
 *
 * A public URL on an unauthenticated proxy is the fastest way to lose the site:
 * strangers (or a botnet) spend the upstream budget, trip xHamster's rate limiter
 * and get our egress blocked for everyone. Public mode therefore requires an
 * invite code. With ACCESS_CODES empty the gate is off (local development, same
 * as before).
 *
 * Design:
 *   - Codes live only in env, compared with timing-safe equality.
 *   - The session cookie is an HMAC-signed { code-fingerprint, expiry } token.
 *     Removing a code from ACCESS_CODES revokes every session minted from it.
 *   - Quotas key off the code fingerprint (see guard.js), so one invite cannot
 *     multiply its budget by opening more sessions.
 *   - No accounts, no email, no database. 18+ confirmation is part of the same
 *     form because this is adult material being served publicly.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE = "ts_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CODES = String(process.env.ACCESS_CODES || "")
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 6);
const ENABLED = CODES.length > 0;

/* fingerprint = first 16 hex chars of SHA-256; enough to name a session, useless
 * for recovering the code. */
const CODE_KEYS = CODES.map((c) => crypto.createHash("sha256").update(c).digest("hex").slice(0, 16));
const CODE_BUFFERS = CODES.map((c) => Buffer.from(c));

/* ------------------------------- signing key ------------------------------- */
const KEY_FILE = path.join(__dirname, "..", ".cache", "session-secret");
let cachedKey = null;

function sessionSecret() {
  if (cachedKey) return cachedKey;
  const env = String(process.env.SESSION_SECRET || "");
  if (env.length >= 16) {
    cachedKey = crypto.createHash("sha256").update(env).digest();
    return cachedKey;
  }
  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === 32) { cachedKey = raw; return cachedKey; }
  } catch (e) { /* first boot */ }
  const made = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, made, { mode: 0o600, flag: "wx" });
    cachedKey = made;
  } catch (e) {
    try {
      const raw = fs.readFileSync(KEY_FILE);
      cachedKey = raw.length === 32 ? raw : made;
    } catch (e2) { cachedKey = made; }
  }
  return cachedKey;
}

function sign(payload) {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest();
}

function issue(key) {
  const payload = Buffer.from(JSON.stringify({ k: key, e: Date.now() + TTL_MS }), "utf8").toString("base64url");
  return payload + "." + sign(payload).toString("base64url");
}

function verify(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let got;
  try { got = Buffer.from(parts[1], "base64url"); } catch (e) { return null; }
  const expected = sign(parts[0]);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (e) { return null; }
  if (!obj || typeof obj.k !== "string" || !Number.isFinite(obj.e) || obj.e < Date.now()) return null;
  // Revocation: a session only lives while its invite code is still configured.
  if (!CODE_KEYS.includes(obj.k)) return null;
  return obj;
}

/* -------------------------------- helpers -------------------------------- */
function isHttps(req) {
  if (req.secure) return true;
  // Only a configured reverse proxy may assert the scheme. Otherwise a client
  // could talk us into a Secure cookie over plain HTTP and lock itself out.
  if (process.env.TRUST_PROXY !== "1") return false;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readSession(req) {
  return verify(parseCookies(req.headers.cookie)[COOKIE]);
}

/** Returns the fingerprint of the matching invite code, or "" — never the code. */
function codeKey(code) {
  const given = Buffer.from(String(code || ""));
  let found = "";
  // Compare against every configured code without an early exit, so response
  // timing does not reveal how close a guess was.
  for (let i = 0; i < CODE_BUFFERS.length; i++) {
    const want = CODE_BUFFERS[i];
    if (want.length === given.length && crypto.timingSafeEqual(want, given)) found = CODE_KEYS[i];
  }
  return found;
}

function safeNext(value) {
  const s = String(value || "/");
  if (!s.startsWith("/") || s.startsWith("//") || s.includes("\\")) return "/";
  return s;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* --------------------------------- gate --------------------------------- */
function gate(req, res, next) {
  if (!ENABLED) return next();
  if (req.path === "/login" || req.path === "/api/auth/login" || req.path === "/api/health") return next();
  const session = readSession(req);
  if (session) {
    req.userId = session.k;
    return next();
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ success: false, error: "auth required" });
  res.set("Cache-Control", "no-store");
  return res.redirect(302, "/login?next=" + encodeURIComponent(req.originalUrl.slice(0, 300)));
}

function loginPage(req) {
  const q = req.query || {};
  const next = safeNext(q.next);
  const showError = String(q.e || "") === "1";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Private access — TubeStream</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b10;color:#ececf4;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .card{width:min(430px,92vw);padding:28px;border:1px solid #24243a;border-radius:16px;background:#12121c;box-shadow:0 18px 60px rgba(0,0,0,.55)}
  h1{margin:0 0 4px;font-size:20px;letter-spacing:-.01em}
  p{margin:0 0 18px;color:#9a9ab4;font-size:13px}
  label{display:block;margin:14px 0 6px;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:#8c8ca8}
  input[type=password]{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #2c2c46;background:#0b0b14;color:#fff;font-size:15px}
  input[type=password]:focus{outline:2px solid #ff5a7a55;border-color:#ff5a7a}
  .check{display:flex;gap:9px;align-items:flex-start;margin:16px 0;color:#c3c3d8;font-size:12.5px;text-transform:none;letter-spacing:0}
  .check input{margin:2px 0 0}
  button{width:100%;margin-top:6px;padding:12px;border:0;border-radius:10px;background:#ff5a7a;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
  button:hover{background:#ff7089}
  .err{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#3a1220;border:1px solid #6d2035;color:#ffb3c2;font-size:13px}
  .foot{margin-top:16px;color:#66667e;font-size:11.5px}
</style>
</head>
<body>
<main class="card">
  <h1>Private access</h1>
  <p>This library is invite-only. Enter your access code to continue.</p>
  ${showError ? '<div class="err">That code is not valid, or the 18+ confirmation is missing.</div>' : ""}
  <form method="post" action="/api/auth/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="code">Invite code</label>
    <input id="code" name="code" type="password" autocomplete="one-time-code" required autofocus>
    <label class="check"><input type="checkbox" name="age" value="1" required> <span>I am 18 or older and viewing adult material is legal where I live.</span></label>
    <button type="submit">Enter</button>
  </form>
  <div class="foot">Access is tracked only as an anonymous session id tied to the invite. No account, no email.</div>
</main>
</body>
</html>`;
}

function loginHandler(req, res) {
  // Same-origin form only. A cross-site login would silently bind the victim to
  // somebody else's invite (login CSRF).
  const origin = req.headers.origin;
  if (origin) {
    let sameHost = false;
    try { sameHost = new URL(origin).host === req.headers.host; } catch (e) { sameHost = false; }
    if (!sameHost) return res.status(403).send("cross-origin login refused");
  }
  const body = req.body || {};
  const next = safeNext(body.next);
  if (String(body.age || "") !== "1") return res.redirect(303, "/login?e=1&next=" + encodeURIComponent(next));
  const key = codeKey(body.code);
  if (!key) {
    console.warn("[auth] rejected login from", req.socket && req.socket.remoteAddress);
    return res.redirect(303, "/login?e=1&next=" + encodeURIComponent(next));
  }
  res.cookie(COOKIE, issue(key), {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(req),
    path: "/",
    maxAge: TTL_MS,
  });
  res.set("Cache-Control", "no-store");
  return res.redirect(303, next);
}

function logoutHandler(req, res) {
  res.clearCookie(COOKIE, { path: "/" });
  res.set("Cache-Control", "no-store");
  res.redirect(303, "/login");
}

module.exports = {
  ENABLED,
  gate,
  loginPage,
  loginHandler,
  logoutHandler,
  readSession,
  isHttps,
  COOKIE,
};
