# syntax=docker/dockerfile:1
# @zettapay/listener — self-hosted, non-custodial BTC payment listener.
# Plug-and-play: `docker run` with MERCHANT_XPUB + webhook env vars and it
# auto-seeds the merchant on first boot, then runs watcher + HTTP API.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HEALTH_PORT=8787
ENV STORAGE=json
ENV ZETTAPAY_DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY README.md LICENSE ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && chown -R node:node /data /app
USER node
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
