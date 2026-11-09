# Deploying TubeStream publicly

The app is a normal long-running Node process (in-memory caches, timers, outbound
scraping), so it runs on a VPS or any Docker host. It is **not** a fit for
serverless platforms: Next/Vercel-style targets are unsuitable, and Sites/Workers
cannot run this server.

The site is **public by default** — no invite required. What protects it is
architecture, not a login wall:

1. **Shared cache (L1 + Redis L2)** — listings cached 3 min, watch pages 45 min.
   Repeat visits never touch xHamster. This is what makes the upstream load tiny.
2. **Adaptive upstream budget** — there is **no fixed requests-per-minute ceiling**
   at our layer. The limit starts at `UPSTREAM_BUDGET_PER_MIN` (300) and grows
   ~1% per successful upstream response, up to `UPSTREAM_BUDGET_MAX_PER_MIN`
   (6000), sliding back only when xHamsterActually refuses (403/429). A token
   bucket (`UPSTREAM_BUDGET_BURST`, 1200) smooths bursts. Only cache-*missing*
   page fetches spend budget; cached responses are unlimited, so visitor demand
   scales independently of the upstream.
3. **Per-IP visitor caps (`RATE_LIMIT_AUTO=1`)** — thousands per minute, only
   there to stop a runaway scraper, far above any real browsing use.
4. **Horizontal scale-out** — N replicas behind Caddy share cache, budget and
   cooldowns through Redis, so adding replicas adds capacity without multiplying
   upstream pressure.
5. **Stale-while-revalidate** — an expired page is returned from cache in ~1 ms
   and refreshed in the background (once per page, not once per visitor). A
   traffic spike turns into cached page views, never a queue on upstream.
6. **Ban-avoidance breaker** — repeated 403/429 pauses the *whole fleet* for
   2 min, doubling on every repeat up to `UPSTREAM_PAUSE_MAX_MS` (10 min); any
   success resets it. Going quiet is the only response that makes a block less
   likely, and it is shared, so N replicas cost 3 refusals instead of 3N.
7. **Revalidation, both directions.** Measured live: xHamster sends **no**
   `ETag` and **no** `Last-Modified`, so a conditional GET to them still returns
   the full ~390 KB body. What we do instead:
   - **Upstream side:** the response body is SHA-1 hashed. Identical bytes → the
     cached parse is reused and only the TTL is extended (`unchanged` in
     `/api/stats`). Page TTL now also follows their own `Cache-Control: max-age`
     instead of a hard-coded 3 minutes.
   - **Visitor side:** our JSON responses carry a weak `ETag` computed over the
     payload with the volatile handle fields masked, so a repeat view revalidates
     to **304 with 0 bytes** instead of re-sending ~60 KB.
8. **Browser-side cache (Service Worker)** — `/api/feed`, `/api/category/*`,
   `/api/search/*` and `/api/watch/*` are served stale-while-revalidate from the
   visitor's own Cache API. A repeat visit does not reach the server at all, so
   the same backend carries far more people with no extra upstream load.
   Compression negotiates brotli/zstd (`Content-Encoding: br` verified).
9. **HTTP/3 (QUIC)** — Caddy serves h1/h2/h3; Express sends zstd/gzip at the edge.
   Faster on mobile/lossy networks at zero extra cost.

## 1. VPS + Docker (recommended)

Minimum: 2 vCPU, 2 GB RAM, 1 TB+ monthly transfer, Ubuntu 24.04.

```bash
# on the server
git clone <your repo> tubestream && cd tubestream
cp .env.example .env
# edit .env: TRUST_PROXY=1, leave ACCESS_CODES empty (= public site)
docker compose up -d --build
curl -s http://127.0.0.1:8080/api/health
```

The stack is Redis (shared state) + N app replicas + Caddy (load balancer).
Caddy listens on `127.0.0.1:8080` and balances across the replicas with
`least_conn` plus active `/api/health` checks, so a dead replica simply leaves
rotation. Nothing but Caddy is published.

TLS with automatic certificates — edit the site address in `Caddyfile`:

```caddyfile
example.com {
    reverse_proxy app:8080
    encode zstd gzip
}
```

…and publish 443 in `docker-compose.yml` (`"80:80"`, `"443:443"`). Caddy sends
`X-Forwarded-Proto`, so keep `TRUST_PROXY=1`; the app then sets HSTS and sees the
real client IP for its per-visitor caps.

Scale up any time, no config edit and no restart:

```bash
docker compose up -d --scale app=4      # or APP_REPLICAS=4 docker compose up -d
```

The shared Redis keeps every replica on one cache and one upstream budget.

### No Docker? PM2 cluster mode

```bash
npm i -g pm2
set REDIS_URL=redis://127.0.0.1:6379     # or export on Linux
pm2 start ecosystem.config.js            # one worker per core, one shared port
pm2 scale tubestream 8                   # live scale up/down, zero downtime
pm2 save && pm2 startup                  # survive reboot
```

Caddy/Nginx/cloudflared still terminates TLS in front of the PM2 port.

## 2. Scaling: what actually grows

| Bottleneck | What grows it |
|---|---|
| Visitor request rate | Caddy + more replicas (serve from L1/L2 cache) |
| Cache-miss upstream fetches | The adaptive budget — it follows upstream tolerance, not a fixed number |
| CPU per replica | The app is I/O-bound; replicas are cheap |
| One replica dying | Caddy skips it; Redis keeps the cache and cooldowns |

What does **not** scale: xHamster's own per-IP fairness. If all replicas share
one egress IP, that one IP's upstream tolerance is the fleet's. The adaptive
budget is what notices that tolerance and eases off before a block; rotating
egress (section 3) is what raises it.

## 3. Cloudflare Tunnel (no open ports)

If you do not want a public IP at all (or you are hosting from a home PC):

```bash
# temporary URL (good for testing, not for a real audience)
npx cloudflared tunnel --url http://127.0.0.1:8080
```

For production create a named tunnel in the Cloudflare dashboard, point it at
`http://127.0.0.1:8080`, and attach your domain. Keep `TRUST_PROXY=1`. Cloudflare
also absorbs DDoS traffic aimed at *your* site; it does nothing about xHamster
limiting *your egress*, which is what section 4 is for.

A home PC must stay on, and its upload speed is the site's speed. A small VPS is
the better long-term home.

## 4. Rotating egress — raising the upstream ceiling

xHamster's limiter buckets per IP, not per hostname: swapping `.com` mirrors does
not produce fresh limit buckets. If you outgrow one IP's tolerance, the only real
defence is leaving from many addresses. Any HTTP(S)/SOCKS5 proxy provider works;
the app needs only URLs:

```env
PROXY_HTTP_URL=http://USER:PASSWORD@HOST:PORT
PROXY_SOCKS5_URL=socks5://USER:PASSWORD@HOST:PORT
# or several at once:
EGRESS_PROXIES=http://u:p@a:1,socks5://u:p@b:2
EGRESS_SCOPE=pages
```

A rotating gateway (one endpoint that hands out a new IP per connection) is
enough. **IPRoyal** is a reasonable fit: residential/ISP/datacenter/mobile, HTTP
and SOCKS5, pay-as-you-go, no expiring bandwidth.

Rules of thumb:

- **Keep `EGRESS_SCOPE=pages`.** Page fetches are small and are what gets
  rate-limited into a block. Video is hundreds of MB per view — residential
  proxies bill per GB, so proxying video is how you turn a block problem into a
  billing problem. Add `thumbs` only if the CDN starts refusing your IP.
- Prefer **ISP or datacenter** proxies for speed; use residential only if the WAF
  actually rejects datacenter ranges.
- One endpoint is not redundancy. Two providers/endpoints is the point where a
  single vendor outage stops mattering. Endpoints that fail cool down
  automatically and the app falls back to direct.

## 5. Capacity math (be honest with yourself)

- One page view = 1 listing fetch + ~46 thumbnail fetches + one video.
- One 20-minute 720p view ≈ 300–600 MB through this server. 100 views/day is
  roughly 30–60 GB/day. Size the plan for that, or keep the audience small.
- The upstream budget is adaptive: it starts at 300/min and grows toward
  `UPSTREAM_BUDGET_MAX_PER_MIN` (6000) while xHamster keeps answering. The page
  cache (3 min listings, 45 min watch) is what keeps steady-state upstream use
  far below any limit, so a large audience stays affordable.

## 6. Go-live checklist

- [ ] `REDIS_URL` set and Redis running (required for multi-replica scaling).
- [ ] `TRUST_PROXY=1` and a TLS terminator in front (Caddy/Cloudflare).
- [ ] `SESSION_SECRET` and `PROXY_SECRET` set (stable across rebuilds).
- [ ] Volume mounted for `/app/.cache` (page cache survives deploys).
- [ ] `ACCESS_CODES` left empty for a fully public site, or set for invite-only.
- [ ] `/api/health` monitored from outside; `/api/stats` checked from loopback.
- [ ] `.env` never committed (it is in `.gitignore` and `.dockerignore`).

## Legal note

The optional 18+ checkbox is a consent screen, not legal age verification.
Several jurisdictions (UK OSA, some US states, parts of the EU) require real age
assurance for commercial adult sites, and proxying third-party content raises
copyright questions. Check your host's adult-content policy and your local rules
before opening the site publicly. Keeping it unlisted and non-indexed is the
lowest-risk configuration.
