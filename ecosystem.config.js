/* PM2 process file — the no-Docker path (Windows PC or a bare VPS).
 *
 * Cluster mode forks one worker per core behind a single shared port, so the
 * site uses every core without needing a reverse proxy:
 *
 *   pm2 start ecosystem.config.js     # one worker per core
 *   pm2 scale tubestream 8            # add/remove workers live, no downtime
 *   pm2 reload ecosystem.config.js    # zero-downtime restart after a deploy
 *
 * Redis matters here: N workers without REDIS_URL means N page caches and N
 * separate upstream budgets — which multiplies upstream pressure instead of
 * sharing it. Point REDIS_URL at a Redis and every worker shares one cache, one
 * adaptive budget and one set of host cooldowns. Without it the app still runs
 * (per-process fallback), it just loses cross-worker sharing.
 */
module.exports = {
  apps: [
    {
      name: "tubestream",
      script: "server.js",
      exec_mode: "cluster",
      instances: "max",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "20s",
      // Recycle a worker that leaks; the others keep serving.
      max_memory_restart: "1200M",
      kill_timeout: 6000,
      listen_timeout: 15000,
      env: {
        NODE_ENV: "production",
        PORT: 8080,
        TRUST_PROXY: "1",
        // Public by default — set ACCESS_CODES in .env only for invite-only mode.
      },
    },
  ],
};
