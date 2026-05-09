# syntax=docker/dockerfile:1.7

# ---------- Base ----------
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# ---------- Deps (full install incl. dev for build) ----------
FROM base AS deps
# better-sqlite3 native build toolchain
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN npm ci --include=dev

# ---------- Build ----------
FROM deps AS build
COPY tsconfig.json ./
COPY packages/api packages/api
COPY packages/sdk packages/sdk
RUN npm run build --workspaces --if-present

# ---------- Production deps only ----------
FROM base AS prod-deps
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN npm ci --omit=dev

# ---------- Runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0

# libstdc++ required at runtime by better-sqlite3 native binding on alpine
RUN apk add --no-cache libstdc++ tini

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/api/package.json ./packages/api/package.json
COPY package.json package-lock.json ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/api/dist/server.js"]
