# SHE v2 — container image.
#
# Supports the private / self-hosted deployment case: the service runs anywhere a
# container runs, with the workspace and its state mounted as a volume.
#
# NOT YET BUILT. Docker was unavailable in the environment where this was written,
# so the image has not been built or run. `scripts/docker-check.mjs` verifies that
# every path referenced here exists in the repository, which catches the likely
# mistakes (a wrong COPY source, a dist directory that is not produced) — but that
# is not a substitute for `docker build && docker run`.
#
# Build:
#   docker build -t she:0.3.0 .
# Run (workspace mounted so the agent's files and history persist):
#   docker run --rm -p 4577:4577 \
#     -v "$PWD/workspace:/workspace" \
#     -e OPENAI_API_KEY=sk-... \
#     she:0.3.0
# Then open http://127.0.0.1:4577

# ─── build ───
FROM node:22-bookworm-slim AS build

# Build tools are needed only if better-sqlite3 has no prebuilt binary for this
# platform. Including them costs size in a stage that is discarded, and removes a
# class of "works on my machine" failures.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# Manifests first, so a source-only change reuses the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/kb/package.json ./packages/kb/
COPY packages/sandbox/package.json ./packages/sandbox/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/server/package.json ./packages/server/
COPY packages/ui/package.json ./packages/ui/
COPY packages/desktop/package.json ./packages/desktop/
COPY packages/she-cli/package.json ./packages/she-cli/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -r build

# Drop dev dependencies once the build is done. Scripts must run, or better-sqlite3
# loses its compiled binding.
RUN pnpm prune --prod

# ─── runtime ───
FROM node:22-bookworm-slim AS runtime

# `tini` reaps zombie processes: the server spawns language servers, MCP servers and
# shells, and without an init they accumulate as orphans inside the container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    SHE_HOST=0.0.0.0 \
    SHE_PORT=4577 \
    SHE_WORKSPACE=/workspace \
    SHE_STATE_DIR=/workspace

WORKDIR /app

# Only what runs at runtime. Copying the whole build stage would ship sources, tests
# and the toolchain, and would duplicate the `src` trees that `dist` supersedes.
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/kb/package.json ./packages/kb/
COPY --from=build /app/packages/kb/dist ./packages/kb/dist
COPY --from=build /app/packages/sandbox/package.json ./packages/sandbox/
COPY --from=build /app/packages/sandbox/dist ./packages/sandbox/dist
COPY --from=build /app/packages/agent-runtime/package.json ./packages/agent-runtime/
COPY --from=build /app/packages/agent-runtime/dist ./packages/agent-runtime/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
# The server serves the built UI from packages/ui/dist (see UI_DIR in index.ts).
COPY --from=build /app/packages/ui/dist ./packages/ui/dist
# The `she` CLI, so the container can also drive the server as a command.
COPY --from=build /app/packages/she-cli/package.json ./packages/she-cli/
COPY --from=build /app/packages/she-cli/dist ./packages/she-cli/dist

# The workspace lives on a volume; the agent reads and writes here.
RUN mkdir -p /workspace/.she

# Run as the unprivileged user the node image already provides. The agent executes
# shell commands, so running as root in the container would be a real escalation if
# it ever escaped the sandbox.
RUN chown -R node:node /workspace /app
USER node

EXPOSE 4577

# Reports unhealthy when the service stops answering, so an orchestrator can restart
# it instead of leaving a container that is up but serving nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4577/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini as PID 1, so signals reach the server and orphans are reaped.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
