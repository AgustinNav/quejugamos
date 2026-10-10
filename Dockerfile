# syntax=docker/dockerfile:1
#
# GameMatch runtime image. Zero runtime deps: Node 24 runs src/server.ts via native type stripping,
# so there is no build stage and no node_modules.
#
# Pinned to an exact patch + Alpine release so rebuilds are reproducible. Bump deliberately.
# Optional, stricter: pin the multi-arch digest too (immutable even if the tag is re-pushed):
#   FROM node:24.21.0-alpine3.24@sha256:83f1c388c31fb2e51f7cbd4dea949b96260798c98f206e8e4696bc93bd964e3a
ARG NODE_IMAGE=node:24.21.0-alpine3.24
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app

# If runtime dependencies ever appear, uncomment (needs a committed package-lock.json):
#   COPY package.json package-lock.json ./
#   RUN npm ci --omit=dev && npm cache clean --force
COPY package.json ./
COPY public ./public
COPY src ./src

# Code stays root-owned (read-only for the runtime user). Only the Steam cache file is writable,
# pre-created so the app can overwrite it without needing write access to /app itself.
RUN printf '{}' > .steam-cache.json && chown node:node .steam-cache.json

USER node

# Documentation only: Cloud Run injects PORT (8080) and ignores EXPOSE.
EXPOSE 8080

# Used by `docker run` / CI. Cloud Run ignores HEALTHCHECK and uses its own startup probe.
# Shell form on purpose: ${PORT} must expand at runtime. busybox wget ships with Alpine.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

# Cloud Run sends SIGTERM and SIGKILLs 10 s later. Node is PID 1, so the app must handle SIGTERM itself.
STOPSIGNAL SIGTERM

CMD ["node", "src/server.ts"]
