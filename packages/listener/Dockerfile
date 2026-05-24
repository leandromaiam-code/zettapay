# syntax=docker/dockerfile:1
# @zettapay/listener — self-hosted, non-custodial BTC payment listener.
# Build once, ship the compiled dist/ + production deps only.

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
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["start"]
