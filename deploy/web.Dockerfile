# PactAgent application image (Issue #39 Railway deployment; hardened #69).
#
# One deterministic image serves two services:
#   - pactagent-web:      Next.js production server (requester UI + BFF + runtime)
#   - pactagent-provider: standalone P002 provider service (compiled; no tsx)
#
# Hardening (Issue #69):
#   - The Node.js base image is pinned by immutable digest on every stage.
#     Dependabot (/deploy docker ecosystem) maintains the digest.
#   - The provider service is compiled ahead of time with esbuild (a transitive
#     dependency of the devDependency tsx) into dist/provider-start.mjs during
#     the build stage. The runtime image excludes all devDependencies
#     (npm ci --omit=dev), so tsx, vitest, typescript, eslint, @types/*,
#     @next/swc-wasm-nodejs, @playwright/test, jsdom and railway are absent.
#   - Both services run as the non-root `node` user (UID 1000).
#   - Runtime writes are confined to /data (Railway persistent volume) and the
#     Next.js .next cache; both are owned by the node user.
#
# Railway overrides the start command per service:
#   - web:      node node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT}
#   - provider: node --conditions=react-server dist/provider-start.mjs

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
RUN npm run build:provider

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# /data is the Railway persistent-volume mount point for both services
# (web: PACTAGENT_DEMO_STATE_DIRECTORY=/data; provider:
# PACTAGENT_PROVIDER_STATE_DIRECTORY=/data). Create it owned by the non-root
# user so a FRESH volume mount inherits node-owned permissions. Existing
# volumes containing files written by the previous root-running container
# require a one-time ownership migration before deploying this image; see
# docs/issue-39-railway-deployment.md. A recursive chown is intentionally NOT
# performed at container start against an unknown mounted volume.
RUN mkdir -p /data && chown -R node:node /data

# Production dependencies only. The native SWC binary for the target platform
# is an optionalDependency of `next` and is retained; the WASM fallback
# (@next/swc-wasm-nodejs, a devDependency) is excluded. Every top-level
# devDependency (tsx, vitest, typescript, eslint, @types/*, @testing-library/*,
# @playwright/test, jsdom, railway, @next/swc-wasm-nodejs) is excluded by
# --omit=dev. Note: npm auto-installs two peer dependencies of production
# packages - `typescript` (a peer of nostr-tools) and `@playwright/test` (an
# optional peer of next) - which therefore remain; neither is executed at
# runtime (the provider is pre-compiled and next start uses the native SWC,
# not tsc or Playwright). See docs/issue-39-railway-deployment.md.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Next.js build output; owned by node so the runtime data/route cache is writable.
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts
# Compiled provider service (bundled ahead of time; no tsx at runtime).
COPY --from=build /app/dist ./dist
# PDF text-extraction worker: plain JavaScript loaded by path at runtime
# (resolve(process.cwd(), "src", "domain", "pdf-text-extract.worker.mjs")).
# It imports `unpdf` from node_modules inside the worker thread, so it must
# exist at <cwd>/src/domain/. No other src/ TypeScript is required at runtime.
COPY --from=build /app/src/domain/pdf-text-extract.worker.mjs ./src/domain/pdf-text-extract.worker.mjs

EXPOSE 3000

USER node

CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
