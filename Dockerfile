# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the SkyTwin server-side apps (api / web / worker).
#
# Output is a single runtime image; the operator picks which app to run via
# the APP build arg or by overriding CMD. We ship one image rather than three
# because the apps share most of their build (turbo's dependency graph) and
# the per-app dist is small relative to node_modules.
#
# Build:
#   docker build -t skytwin -f Dockerfile .
#
# Run a specific app:
#   docker run -e DATABASE_URL=... -p 3100:3100 skytwin api
#   docker run -e DATABASE_URL=... -p 3101:3101 skytwin worker
#   docker run -e DATABASE_URL=... -p 3200:3200 skytwin web
#
# Required env at runtime (api):
#   DATABASE_URL, SESSION_SECRET, NODE_ENV
# Optional env at runtime:
#   API_PORT, IRONCLAW_API_URL, IRONCLAW_WEBHOOK_SECRET, OPENCLAW_API_URL,
#   USE_MOCK_IRONCLAW, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, …

ARG NODE_VERSION=20-alpine
ARG PNPM_VERSION=9.1.0

# ─── Stage 1: dependencies ──────────────────────────────────────────────────
# Resolves the workspace and installs every package's deps in one place. Kept
# separate from the build stage so the layer cache is reused unless the
# lockfile or any package.json changes.
FROM node:${NODE_VERSION} AS deps
ARG PNPM_VERSION
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy only the manifests so the install layer reuses cache when source
# changes but deps don't.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY apps/openclaw-bridge/package.json ./apps/openclaw-bridge/
COPY apps/desktop/package.json ./apps/desktop/
COPY apps/mobile/package.json ./apps/mobile/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/twin-model/package.json ./packages/twin-model/
COPY packages/decision-engine/package.json ./packages/decision-engine/
COPY packages/policy-engine/package.json ./packages/policy-engine/
COPY packages/ironclaw-adapter/package.json ./packages/ironclaw-adapter/
COPY packages/execution-router/package.json ./packages/execution-router/
COPY packages/llm-client/package.json ./packages/llm-client/
COPY packages/explanations/package.json ./packages/explanations/
COPY packages/connectors/package.json ./packages/connectors/
COPY packages/mempalace/package.json ./packages/mempalace/
COPY packages/evals/package.json ./packages/evals/

# Install everything (devDeps included; needed for tsc and turbo at build time).
# `--frozen-lockfile` to fail loud on lockfile drift.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ─── Stage 2: build ─────────────────────────────────────────────────────────
# Runs `pnpm build` (turbo run build) which compiles every package's TS to
# dist/. The runtime stage copies just those dist/ outputs, skipping src/.
FROM deps AS build
WORKDIR /app

# Copy the rest of the source. apps/desktop and apps/mobile aren't needed
# for a server image but copying them is cheap and avoids per-app exclusions.
COPY . .

# Turbo respects the dependency graph (shared-types → config → core → db → …),
# so this single command builds everything in topological order.
RUN pnpm build

# `tsc` emits only `.js`/`.d.ts`; the migration runner in
# packages/db/src/migrations/001-initial.ts reads `*.sql` files relative to
# its own location, so we colocate them next to the compiled JS in dist/.
RUN mkdir -p packages/db/dist/migrations packages/db/dist/schemas \
 && cp packages/db/src/migrations/*.sql packages/db/dist/migrations/ \
 && cp packages/db/src/schemas/*.sql packages/db/dist/schemas/

# Drop devDependencies for the runtime image. `--prod` rewrites node_modules
# to only the runtime-needed packages.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ─── Stage 3: runtime ──────────────────────────────────────────────────────
# Minimal image. Only the dist/ output, the pruned node_modules, and the
# entry-point picker script. No source, no toolchain.
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# Tini is a tiny init that reaps zombie children and forwards signals — Node
# alone doesn't handle SIGTERM cleanly under PID 1.
RUN apk add --no-cache tini

ENV NODE_ENV=production

# Workspace metadata + pruned deps.
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/turbo.json ./
COPY --from=build /app/node_modules ./node_modules

# Per-app dist outputs and their package.json (for "main" / "type" resolution).
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/package.json ./apps/web/
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY --from=build /app/apps/openclaw-bridge ./apps/openclaw-bridge

# Workspace package dist outputs that the apps require at runtime.
COPY --from=build /app/packages ./packages

# Entry-point picker. The image accepts the app name as the first arg and
# execs the matching node entry. Operator can also bypass via `--entrypoint`.
COPY --from=build /app/bin/docker-entrypoint.sh /usr/local/bin/skytwin-entrypoint
RUN chmod +x /usr/local/bin/skytwin-entrypoint

# Drop privileges. node:alpine ships a `node` user (uid 1000).
USER node

# /api/health/live is the liveness probe; readiness is /api/health/ready.
# Both come from apps/api/src/index.ts. Ports default to the API; override
# with EXPOSE/PORT for worker/web.
EXPOSE 3100

ENTRYPOINT ["/sbin/tini", "--", "skytwin-entrypoint"]
CMD ["api"]
