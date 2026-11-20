# ---- build ---------------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Toolchain for native modules (better-sqlite3) when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/oracle/package.json packages/oracle/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @ndox/web build \
 && pnpm --filter @ndox/server build \
 && pnpm --filter @ndox/server deploy --prod --legacy /out

# ---- runtime -------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST_DIR=/app/web \
    SEED_DIR=/app/seed \
    MIGRATIONS_DIR=/app/drizzle \
    DATABASE_PATH=/data/ndox.sqlite
WORKDIR /app

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/web/dist ./web
COPY --from=build /repo/data/seed ./seed
COPY --from=build /repo/apps/server/drizzle ./drizzle

RUN mkdir -p /data && chown node:node /data
# /data is a volume: docker-compose names it, Railway attaches one (Railway: RAILWAY_RUN_UID=0,
# its volumes are owned by root).
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
