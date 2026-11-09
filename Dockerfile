FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so a code change does not bust the layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# .cache holds the page cache, the DNS pins and the two signing keys. Mount a
# volume over it so sessions survive a redeploy (see docker-compose.yml).
RUN mkdir -p /app/.cache && chown -R node:node /app
USER node

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
