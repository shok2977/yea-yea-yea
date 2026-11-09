/* secure-url.js — opaque, expiring, same-origin handles for upstream media.
 *
 * Why this exists (the two problems it closes):
 *
 * 1) The client used to be handed the real CDN URL. `/api/stream` and
 *    `/api/thumb` accepted *any* URL matching a hostname regex, so one caller
 *    could mint unlimited distinct cache keys and make the server pull unlimited
 *    distinct objects from xHamster's CDN. That is a per-IP egress flood: their
 *    edge answers 403/429, and every visitor loses thumbnails and video at once.
 *
 * 2) The browser also used those raw URLs directly (direct-first thumbnail and
 *    player loading in public/app.js). That exposed every visitor's own IP to
 *    xHamster's CDN, which is exactly how a *user* gets blocked, and it defeated
 *    the whole point of proxying.
 *
 * So the server now mints handles: AES-256-GCM sealed {url, kind, expiry}.
 * The handle is unguessable, unenumerable, expires, and is bound to one purpose.
 * The browser only ever sees `/api/thumb?t=…` and `/api/stream?t=…` on our own
 * origin. `/api/*` refuses anything it did not mint itself.
 *
 * The key persists in .cache/proxy-secret (0600, gitignored) so playback and
 * image handles survive a restart. PROXY_SECRET overrides it for multi-process
 * deployments.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/* Thumbnails live on the media zone; both zones are separate host families from
 * the page host, which is why the ISP DNS block never touched them. */
const IMAGE_SUFFIXES = ["xhcdn.com", "xhpingcdn.com", "xhmediacdn.com"];
const MEDIA_SUFFIXES = IMAGE_SUFFIXES.concat([
  "phncdn.com",
  "ahcdn.com",
  "xhamster.com",
  "xhamster.desi",
  "xhamster2.com",
  "xhamster3.com",
  "xhopen.com",
  "xhspot.com",
  "xhtotal.com",
  "xhaccess.com",
  "xhday.com",
  "xhvid.com",
  "xhms.pro",
]);

const VERSION = 1;
/* Handles are bucketed, not freshly randomised: the same URL yields the same
 * token for the whole bucket, so the service worker and the HTTP cache keep
 * working (a new token per render would miss both on every navigation). A
 * handle stays valid for one to two buckets — 6–12h for thumbnails, 2–4h for
 * media, which is inside the lifetime of the CDN token it wraps. */
const BUCKET_MS = { thumb: 6 * 60 * 60 * 1000, media: 2 * 60 * 60 * 1000 };
const MAX_TOKEN_CHARS = 4096;

function hostMatches(hostname, suffixes) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  for (const suffix of suffixes) {
    if (h === suffix || h.endsWith("." + suffix)) return true;
  }
  return false;
}

function isAllowedCdnHost(hostname) {
  return hostMatches(hostname, MEDIA_SUFFIXES);
}

/** Validate + normalise an upstream URL for one purpose. "" means "refuse". */
function allowedUrl(raw, kind) {
  let u;
  try { u = new URL(String(raw || "")); } catch (e) { return ""; }
  if (u.protocol !== "https:") return "";
  if (u.username || u.password) return "";          // no credential tricks
  if (u.port && u.port !== "443") return "";        // no port hopping
  if (!hostMatches(u.hostname, kind === "thumb" ? IMAGE_SUFFIXES : MEDIA_SUFFIXES)) return "";
  if (/(^|\/)\.\.(\/|$)/.test(u.pathname)) return "";
  return u.href;
}

/* ------------------------------- sealing key ------------------------------- */
const KEY_FILE = path.join(__dirname, "..", ".cache", "proxy-secret");
let cachedKey = null;

function secretKey() {
  if (cachedKey) return cachedKey;
  const env = String(process.env.PROXY_SECRET || "");
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
    // Another process won the create race — use its key, never a divergent one.
    try {
      const raw = fs.readFileSync(KEY_FILE);
      cachedKey = raw.length === 32 ? raw : made;
    } catch (e2) {
      cachedKey = made;
    }
  }
  return cachedKey;
}

/* A separate subkey derives the IV from the plaintext. Deterministic encryption
 * is safe here because the full message is in the nonce derivation and the
 * message itself is unique per (kind, bucket, url): equal plaintexts only ever
 * produce equal ciphertexts, never a reused nonce for two different messages. */
let cachedIvKey = null;
function ivKey() {
  if (!cachedIvKey) cachedIvKey = crypto.createHmac("sha256", secretKey()).update("tubestream/proxy-iv/v1").digest();
  return cachedIvKey;
}

function seal(rawUrl, kind) {
  const url = allowedUrl(rawUrl, kind);
  if (!url) return "";
  const bucketMs = BUCKET_MS[kind] || BUCKET_MS.media;
  const bucket = Math.floor(Date.now() / bucketMs);
  const plain = JSON.stringify({ v: VERSION, k: kind, e: (bucket + 2) * bucketMs, u: url });
  const iv = crypto.createHmac("sha256", ivKey()).update(plain).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Returns the upstream URL for a valid handle of this kind, else "". */
function openHandle(token, kind) {
  const t = String(token || "");
  if (!t || t.length > MAX_TOKEN_CHARS) return "";
  let raw;
  try { raw = Buffer.from(t, "base64url"); } catch (e) { return ""; }
  if (raw.length < 12 + 16 + 8) return "";
  try {
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    const obj = JSON.parse(plain.toString("utf8"));
    if (!obj || obj.v !== VERSION || obj.k !== kind) return "";
    if (!Number.isFinite(obj.e) || obj.e < Date.now()) return "";
    return allowedUrl(obj.u, kind);
  } catch (e) {
    return "";   // bad tag, truncated, wrong key — all the same answer
  }
}

function proxyThumbUrl(raw) {
  const t = seal(raw, "thumb");
  return t ? "/api/thumb?t=" + t : "";
}

function proxyMediaUrl(raw) {
  const t = seal(raw, "media");
  return t ? "/api/stream?t=" + t : "";
}

module.exports = {
  proxyThumbUrl,
  proxyMediaUrl,
  readThumbToken: (t) => openHandle(t, "thumb"),
  readMediaToken: (t) => openHandle(t, "media"),
  isAllowedCdnHost,
  allowedUrl,
  IMAGE_SUFFIXES,
  MEDIA_SUFFIXES,
};
