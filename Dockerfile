# HyCanvas - single application image. The Go backend (REST + /realtime
# WebSocket) serves the statically-exported Next.js frontend on one port and runs
# its SQL migrations on boot. Postgres is an external service (see
# docker-compose.yml). ffmpeg is included for video export.

# ---------------------------------------------------------------------------
# Stage 1: build the frontend static export
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS frontend
WORKDIR /app
COPY . .
# The lockfile records every platform's native deps (lightningcss, swc, rollup)
# with cpu/os metadata, so `npm ci` installs the right ones for this build
# platform and the image stays exactly reproducible.
RUN npm ci --no-audit --no-fund
# build:dist -w frontend bakes NEXT_PUBLIC_BACKEND_URL=/api into the export.
RUN npm run build:packages && npm run build:dist -w frontend

# ---------------------------------------------------------------------------
# Stage 2: build the Go backend binary
# ---------------------------------------------------------------------------
FROM golang:1.26-bookworm AS backend
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
# Stage the frontend export into the Go module so go:embed bakes it into the
# binary (single self-contained file; no sidecar public/ at runtime).
COPY --from=frontend /app/frontend/out ./internal/webui/public
# Static (CGO off) so it runs on the slim runtime base. -tags embed bakes the
# frontend in; migrations, seed catalogs, and fonts are always embedded. VERSION
# is stamped into the binary for boot logs and the health endpoints.
ARG VERSION=docker
RUN CGO_ENABLED=0 go build -tags embed -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/hycanvas ./cmd/api

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
WORKDIR /app

# ffmpeg: video export. ca-certificates: outbound TLS (AI providers, SSO).
# curl: container healthcheck against /healthz.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Runs as an unprivileged user, never root. The uid is numeric so Kubernetes
# runAsNonRoot can verify it. /app (the working directory, where the setup
# wizard writes .env) and the storage directory are owned by group 0 with group
# write, so the default user, a new named volume (which copies this ownership)
# and any uid run in group 0 (runAsUser, OpenShift) can all write them. The
# binary lives in root-owned /usr/local/bin, out of reach of the process.
# A storage volume created by an earlier image is root-owned; the server
# refuses to start on it with the one-time chown that fixes it (DOCKER_SETUP.md).
RUN useradd --uid 10001 --gid 0 --home-dir /app --no-create-home --shell /usr/sbin/nologin hycanvas \
 && mkdir -p /app/.data/storage \
 && chown -R 10001:0 /app \
 && chmod -R g=u /app

COPY --from=backend /out/hycanvas /usr/local/bin/hycanvas

ENV HOME=/app \
    PORT=8005 \
    DB_AUTO_MIGRATE=true \
    STORAGE_DRIVER=local \
    LOCAL_STORAGE_PATH=/app/.data/storage

EXPOSE 8005
# Persist uploads/exports/snapshots when using the local storage driver.
VOLUME ["/app/.data/storage"]

# The Go binary serves /healthz once its HTTP listener is up.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/healthz" || exit 1

USER 10001:0
ENTRYPOINT ["/usr/local/bin/hycanvas"]
