# Pulse (SHE v2) — container image.
#
# Supports the private / self-hosted deployment case: the service runs anywhere a
# container runs, with the workspace and its state mounted as a volume.
#
# Built and run on every push: the `docker-build` job in `.github/workflows/ci.yml` runs
# `docker build` and then starts the container and asks it for /api/health. That job exists
# precisely because `scripts/docker-check.mjs` (paths and structure only) cannot tell whether the
# image starts — the first time it ran, the image built fine and died at startup with
# ERR_MODULE_NOT_FOUND: only `dist` and a root `node_modules` were copied, so every dependency
# symlink dangled. See the deploy step below.
#
# Build:
#   docker build -t pulse:0.3.0 .
# Run (workspace mounted so the agent's files and history persist):
#   docker run --rm -p 127.0.0.1:5577:5577 \
#     -v "$PWD/workspace:/workspace" \
#     -e OPENAI_API_KEY=sk-... \
#     pulse:0.3.0
# Then open http://127.0.0.1:5577 (same port as the server default in packages/shared/src/config.ts)

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

# A SELF-CONTAINED tree for the runtime stage.
#
# `--node-linker=hoisted` is LOAD-BEARING — the same trap AGENTS.md records for the desktop
# staging: pnpm's default layout keeps a package's dependencies as SIBLINGS of it, reached
# through symlinks, so an image that copies only `dist` + a root `node_modules` leaves every link
# dangling and the container dies at startup with ERR_MODULE_NOT_FOUND.
RUN pnpm --filter @she/server deploy /deploy/server --prod --node-linker=hoisted

# ─── runtime ───
FROM node:22-bookworm-slim AS runtime

# `tini` reaps zombie processes: the server spawns language servers, MCP servers and
# shells, and without an init they accumulate as orphans inside the container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# SHE_UI_DIR points at the built UI inside the image (default resolution: UI_DIR in
# packages/server/src/index.ts).
ENV NODE_ENV=production \
    SHE_HOST=0.0.0.0 \
    SHE_PORT=5577 \
    SHE_WORKSPACE=/workspace \
    SHE_STATE_DIR=/workspace \
    SHE_UI_DIR=/app/ui

WORKDIR /app

# Only what runs at runtime. Copying the whole build stage would ship sources, tests
# and the toolchain, and would duplicate the `src` trees that `dist` supersedes.
# The deployed server: its own node_modules, hoisted, nothing pointing outside the tree.
COPY --from=build /deploy/server ./server
# The built UI, exactly where SHE_UI_DIR says (the desktop runtime uses this same sibling
# layout: `ui/` next to `server/`).
COPY --from=build /app/packages/ui/dist ./ui
# Bundled skills, for the same reason: the prompt index lists them from here.
COPY --from=build /app/skills ./skills

# The workspace lives on a volume; the agent reads and writes here.
RUN mkdir -p /workspace/.she

# Run as the unprivileged user the node image already provides. The agent executes
# shell commands, so running as root in the container would be a real escalation if
# it ever escaped the sandbox.
RUN chown -R node:node /workspace /app
USER node

EXPOSE 5577

# Reports unhealthy when the service stops answering, so an orchestrator can restart
# it instead of leaving a container that is up but serving nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5577/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini as PID 1, so signals reach the server and orphans are reaped.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
