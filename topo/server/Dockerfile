FROM node:24-bookworm-slim AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY build ./build
COPY public ./public
RUN npm run vendor

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    TOPO_DB=/data/topo.db
WORKDIR /app

RUN groupadd --system --gid 10001 netluo \
 && useradd --system --uid 10001 --gid netluo --home-dir /data --shell /usr/sbin/nologin netluo \
 && mkdir -p /data && chown netluo:netluo /data

COPY --from=assets --chown=netluo:netluo /app/node_modules ./node_modules
COPY --from=assets --chown=netluo:netluo /app/public ./public
COPY --chown=netluo:netluo src ./src
COPY --chown=netluo:netluo package.json ./

USER netluo
EXPOSE 3000
VOLUME ["/data"]

# 镜像里不带 curl，用 node 自己探活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
