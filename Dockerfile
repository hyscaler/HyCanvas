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
# Resolve fresh so the build platform's native deps (lightningcss, swc) install
# correctly rather than reusing a cross-platform lockfile.
RUN rm -f package-lock.json && npm install --no-audit --no-fund
# build:dist -w frontend bakes NEXT_PUBLIC_BACKEND_URL=/api into the export.
RUN npm run build:packages && npm run build:dist -w frontend

# ---------------------------------------------------------------------------
# Stage 2: build the Go backend binary
# ---------------------------------------------------------------------------
FROM golang:1.25-bookworm AS backend
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
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=backend /out/hycanvas /app/hycanvas

ENV PORT=8005 \
    DB_AUTO_MIGRATE=true \
    STORAGE_DRIVER=local \
    LOCAL_STORAGE_PATH=/app/.data/storage

EXPOSE 8005
# Persist uploads/exports/snapshots when using the local storage driver.
VOLUME ["/app/.data/storage"]

ENTRYPOINT ["/app/hycanvas"]
