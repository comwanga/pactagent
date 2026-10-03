# PactAgent application image (Issue #39 Railway deployment).
#
# One deterministic image serves two services:
#   - pactagent-web:      Next.js production server (requester UI + BFF + runtime)
#   - pactagent-provider: standalone P002 provider service (tsx, react-server)
#
# Dev dependencies are retained so the provider service can run through tsx
# in production. The image is the same for both services; the Railway
# startCommand selects the entrypoint.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/local ./local

EXPOSE 3000

# Railway overrides the start command per service:
#   - web:      node node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT}
#   - provider: node --conditions=react-server --import tsx scripts/provider-start.mjs
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
