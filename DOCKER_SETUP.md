# Docker setup guide

HyCanvas ships as a single self-contained image: one Go binary serves the web UI, the REST API (`/api/v1`), and the realtime WebSocket (`/realtime`) on one port, applies its database migrations on boot, and bundles ffmpeg for video export. The only external dependency is PostgreSQL.

This guide covers the two ways to run it and documents every environment variable.

## Contents

- [Option A: published image + your own Postgres](#option-a-published-image)
- [Option B: docker compose (bundled or external Postgres)](#option-b-docker-compose)
- [Example .env for Docker](#example-env-for-docker)
- [Option C: local development with hot reload](#option-c-local-development)
- [Networking: the localhost gotcha](#networking-the-localhost-gotcha)
- [Persistence and volumes](#persistence-and-volumes)
- [Environment variable reference](#environment-variable-reference)
- [Production hardening](#production-hardening)
- [Health checks and troubleshooting](#health-checks-and-troubleshooting)

## Option A: published image

The prebuilt image (`hycanvas/hycanvas`, built for `linux/amd64` and `linux/arm64`) needs a Postgres it can reach over the network. The simplest setup runs one alongside it on a shared Docker network:

```bash
docker network create hycanvas-net

docker run -d --name hycanvas-db --network hycanvas-net \
  -e POSTGRES_PASSWORD=hycanvas -e POSTGRES_DB=hycanvas \
  postgres:16

docker run -d --name hycanvas --network hycanvas-net -p 8005:8005 \
  -e DATABASE_URL="postgresql://postgres:hycanvas@hycanvas-db:5432/hycanvas?schema=public" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -v hycanvas-storage:/app/.data/storage \
  hycanvas/hycanvas:latest
```

Open http://localhost:8005. The app creates its tables on first boot (`DB_AUTO_MIGRATE=true`).

Tags: `latest` (stable), `development` (latest dev build), and `<version>-<sha>` (immutable).

## Option B: docker compose

From a checkout of the repository:

```bash
cp .env.example .env     # set JWT_SECRET, APP_PORT, and a reachable DATABASE_URL
docker compose up -d     # pulls the published image (bring-your-own Postgres)
```

This serves everything at http://localhost:<APP_PORT> (e.g. 8005). Update later with `docker compose pull && docker compose up -d`. Stop with `docker compose down`; local storage lives in the host folder `./data/storage` and is unaffected.

The published `docker-compose.yml` ships no bundled Postgres, point it at your own by setting `DATABASE_URL` (or `EXTERNAL_DATABASE_URL`) in `.env`. Inside a container `localhost` is the container itself, so use `host.docker.internal` for a DB on your machine (mapped via `extra_hosts`) or a managed endpoint. For a bundled Postgres, build from source (see the table).

There are three compose files:

| File | Use |
| --- | --- |
| `docker-compose.yml` | The default. `docker compose up -d` pulls the published `hycanvas/hycanvas` image and runs it against your own managed Postgres (no bundled `db`). |
| `docker-compose.prod.yml` | Build YOUR source instead of the published image, with a container healthcheck (`/healthz`), restart policy, and an optional BUNDLED Postgres (`COMPOSE_PROFILES=bundled`). Run with `docker compose -f docker-compose.prod.yml up --build -d`. |
| `docker-compose.dev.yml` | Local development with hot reload, with a bundled Postgres (see Option C). |

## Example .env for Docker

`cp .env.example .env`, then set the values below. For the published-image compose you need `JWT_SECRET`, `APP_PORT` (the host port to publish on), a reachable `DATABASE_URL` (or `EXTERNAL_DATABASE_URL`), and, to use object storage, `STORAGE_DRIVER=s3` plus the `S3_*` keys. The compose file wires `NODE_ENV`, `COOKIE_SECURE`, `REDIS_URL`, `DB_AUTO_MIGRATE`, and `PORT` (those override `.env`); `DATABASE_URL` and `STORAGE_DRIVER` are read from `.env`.

### Managed Postgres (published image)

The published `docker-compose.yml` connects to a Postgres you provide, it ships no `db` container:

```
# Required: signs sessions and encrypts stored secrets. Generate with: openssl rand -hex 32
JWT_SECRET="replace-with-a-32-byte-random-hex"

# Your managed Postgres. The database must already exist (the app creates its own
# tables, not the database). For a Postgres on the host machine, use
# host.docker.internal instead of localhost.
DATABASE_URL="postgresql://user:pass@your-db-host:5432/hycanvas?schema=public"

# Host port the app is published on (maps to the container's :8005).
APP_PORT=8005
```

That is the complete minimum. `docker compose up -d` then serves the app at http://localhost:8005 (or whatever `APP_PORT` you set). `EXTERNAL_DATABASE_URL` is honored too and takes priority over `DATABASE_URL`.

### Bundled Postgres (build from source)

`docker-compose.prod.yml` can run a Postgres container instead of requiring an external one, gated by `COMPOSE_PROFILES=bundled`; it assembles the connection URL from these credentials:

```
JWT_SECRET="replace-with-a-32-byte-random-hex"

# Bundled Postgres credentials (prod.yml provisions the db container and builds
# DATABASE_URL from them). Use a strong password for any real deployment.
POSTGRES_USER="hycanvas"
POSTGRES_PASSWORD="change-this-password"
POSTGRES_DB="hycanvas"
COMPOSE_PROFILES="bundled"

APP_PORT=8005
```

Run it with `docker compose -f docker-compose.prod.yml up --build -d`.

### Optional add-ons

All optional; leave unset to disable. These are read straight from `.env` (the compose does not override them). See the [environment variable reference](#environment-variable-reference) for the full list and defaults.

```
# Public base URL, used in links inside outbound email. Set to your real origin.
APP_URL="https://canvas.yourdomain.com"

# SSO (generic OIDC). The "Continue with ..." button appears only when all three are set.
OIDC_ISSUER="https://accounts.google.com"
OIDC_CLIENT_ID=""
OIDC_CLIENT_SECRET=""

# Real email (otherwise verify/reset/invite links go to the dev outbox).
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_USERNAME="apikey-or-user"
SMTP_PASSWORD="..."
SMTP_FROM="no-reply@yourdomain.com"
```

Notes:
- Behind https (a TLS reverse proxy), also set `COOKIE_SECURE: "true"` on the `app` service in the compose (not `.env`, the compose pins it) and point `APP_URL` at your https origin. Over plain http it must stay `false` or login fails.
- Object storage (S3/MinIO): set `STORAGE_DRIVER=s3` and the `S3_*` keys in `.env`; compose reads `STORAGE_DRIVER` from there (defaults to `local`).
- AI providers are configured per workspace inside the app (encrypted in the database), never via env.

## Option C: local development

For day-to-day development in containers (no local Go or Node toolchain needed), use the dev stack. It runs Postgres plus one app container that serves the Go backend and the Next.js dev server with live reload against your working tree (bind-mounted).

```bash
cp .env.example .env      # optional: add OIDC/SMTP/S3 keys; a dev JWT_SECRET is provided
docker compose -f docker-compose.dev.yml up --build
```

Then open http://localhost:3000 (the UI), which calls the API on http://localhost:8005. What the container does on start (`docker/entrypoint-dev.sh`): wait for Postgres, `npm install`, `npm run build:packages` (the `@hc/*` libraries are consumed from their compiled `dist/`), apply migrations, then start the Go backend on `:8005` (via `air`, which rebuilds and restarts it on `.go` changes) and the Next.js dev server on `:3000`.

Notes:
- This image (`Dockerfile.dev`) carries both Go and Node and is for development only; it is not the production artifact. Production is the embedded single binary built by `Dockerfile`.
- The working tree is bind-mounted, so edits on the host hot-reload in the container: the frontend via `next dev`, the backend via `air` (a brief rebuild on each `.go` save). Dependencies (`node_modules`) and Go module/build caches live in named volumes so they survive restarts and never clash with host-platform binaries.
- The `environment:` block in `docker-compose.dev.yml` points `DATABASE_URL` at the `db` service and supplies a dev-only `JWT_SECRET`; these take precedence over any localhost values in your `.env`.
- If a frontend native dependency (lightningcss/swc) ever mismatches the container architecture, reset the deps volumes: `docker compose -f docker-compose.dev.yml down` then `docker volume rm open-canva_frontend_node_modules open-canva_node_modules`, and `up --build` again. (A full reset including the database and storage is `docker compose -f docker-compose.dev.yml down -v`.)

## Networking: the localhost gotcha

Inside a container, `localhost` is the container itself, not your host machine. So:

- App and DB in Docker: connect via the DB's service/container name on a shared network (e.g. `hycanvas-db:5432` above, or `db:5432` under compose).
- Postgres running on the host (Docker Desktop): use `host.docker.internal` instead of `localhost`, e.g. `postgresql://user:pass@host.docker.internal:5432/hycanvas?schema=public`. Make sure the target database already exists (HyCanvas creates its tables, not the database itself).

## Persistence and volumes

With the default local storage driver, uploads, exports, and snapshots are written under `LOCAL_STORAGE_PATH` (`/app/.data/storage` in the image). The bundled `docker-compose.yml` bind-mounts that to the host folder `./data/storage` (next to the compose file), so the data persists even across `docker compose down -v`. With `docker run`, mount a volume there to persist them:

```
-v hycanvas-storage:/app/.data/storage
```

Postgres data persists in its own volume (the `pgdata` volume under compose, or whatever you mount on the `postgres` container).

## Environment variable reference

`JWT_SECRET` is the only strictly required value; the API refuses to start without it. Real environment variables always override any `.env` file.

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `JWT_SECRET` | (required) | Signs access/refresh session tokens. Use a strong random value (`openssl rand -hex 32`). Also the fallback key for encrypting stored secrets (see `AI_SECRET`). |
| `DATABASE_URL` | - | Postgres connection string. Required for the published-image compose and when running the image directly. With the bundled Postgres (`docker-compose.prod.yml`, `COMPOSE_PROFILES=bundled`) it is assembled from `POSTGRES_*` instead. |
| `PORT` | `8005` | Port the binary listens on (UI + API + realtime). `GO_API_PORT` is an accepted alias. |
| `NODE_ENV` | `development` | `production` marks session cookies Secure, requires https AI provider base URLs, and disables the dev mail outbox and permissive localhost CORS. Set `production` for real deployments. |
| `COOKIE_SECURE` | follows `NODE_ENV` | Force the session-cookie `Secure` flag. Over plain http (localhost / LAN / a VPS before TLS) it MUST be `false` or the browser drops the cookie and login fails; set `true` only when served over https. The compose files default it to `false` for the http://localhost quick start. |
| `DB_AUTO_MIGRATE` | `true` | Apply pending SQL migrations on boot. Set `false` to manage migrations out of band. |
| `APP_URL` | - | Public base URL of the app, used to build links in outbound email (verify email, password reset, magic link). |
| `AI_SECRET` | falls back to `JWT_SECRET` | AES-256-GCM key encrypting secrets at rest: per-workspace AI provider keys and MFA TOTP secrets. Set a dedicated value to rotate it independently of `JWT_SECRET`. |
| `STOCK_PHOTO_PROVIDER` | (enabled) | Live photo search via the Openverse API (open-licensed photos, anonymous tier, no key). Set `off` for air-gapped deployments; the bundled icon/illustration/emoji catalog keeps working without it. |

### Database (compose only)

| Variable | Default | Description |
| --- | --- | --- |
| `POSTGRES_USER` | `postgres` | Credentials for the bundled `db` service in `docker-compose.prod.yml`/`docker-compose.dev.yml` (used to build its in-network `DATABASE_URL`). The published-image compose has no `db` and ignores these. |
| `POSTGRES_PASSWORD` | `password` | Set a strong value for any real deployment. |
| `POSTGRES_DB` | `hycanvas` | Database name. |
| `COMPOSE_PROFILES` | `bundled` | Selects the bundled Postgres in `docker-compose.prod.yml`: `bundled` runs the `db` container; empty (with `EXTERNAL_DATABASE_URL` set) runs only the app. No effect on the published-image compose. |
| `EXTERNAL_DATABASE_URL` | - | Connection string for a managed Postgres. Takes priority over `DATABASE_URL` in every compose file; required by the published-image compose unless `DATABASE_URL` is set. |

### Realtime scaling (optional, Redis)

HyCanvas needs **no Redis** by default: a single instance keeps realtime collaboration (Yjs sync, presence, cursors, locks) in memory and runs background jobs in-process. Redis is only for running **multiple app instances** behind a load balancer, where it fans relay/awareness frames out across instances (pub/sub) and backs a cross-instance lock store.

| Variable | Default | Description |
| --- | --- | --- |
| `REDIS_URL` | (empty) | Unset/empty = single instance, in-memory (the default). Set to a reachable Redis to enable multi-instance fan-out. A set-but-unreachable value fails loudly on boot (no silent split-brain). |

All three compose files set `REDIS_URL: ""` on the `app` service, so a `REDIS_URL` in your `.env` is intentionally ignored under Docker (the same way `DATABASE_URL` is) and the stack ships no `redis` service. To enable it, add a `redis` service, set `REDIS_URL: "redis://redis:6379/0"` on the `app` service, and run 2+ `app` replicas behind a reverse proxy.

### Storage and uploads

| Variable | Default | Description |
| --- | --- | --- |
| `STORAGE_DRIVER` | `local` | `local` filesystem storage, or `s3` for S3-compatible object storage (see `S3_*`). Left blank, S3 is used when `S3_ENDPOINT` + credentials are set, else local. Compose reads this from `.env` (defaulting to `local`), so setting `STORAGE_DRIVER=s3` there is enough. |
| `LOCAL_STORAGE_PATH` | `.data/storage` | Where uploads/exports/snapshots are written. In the image this is `/app/.data/storage` - mount a volume there. Use an absolute path outside Docker. |
| `BACKEND_PUBLIC_URL` | (relative) | Absolute base URL used to build asset delivery links. Set to your public URL behind a proxy/CDN. |
| `ASSET_QUOTA_BYTES` | (unset) | Caps per-workspace upload storage in bytes (e.g. `5368709120` = 5 GiB). |
| `S3_*` | - | S3-compatible object storage when `STORAGE_DRIVER=s3`: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (set `true` for MinIO/non-AWS). The bucket is created if missing. |

### Single sign-on (OIDC, optional)

The "Continue with ..." button appears only when all three of issuer/client-id/client-secret are set. Works with any OIDC provider (Google `https://accounts.google.com`, Microsoft, Okta, Auth0, ...). Register an OAuth app and set its callback to `{APP_URL}/api/v1/auth/oidc/callback`.

| Variable | Description |
| --- | --- |
| `OIDC_ISSUER` | Provider issuer URL. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | OAuth app credentials. |
| `OIDC_REDIRECT_URI` | Override the callback URL (default `{APP_URL}/api/v1/auth/oidc/callback`). |
| `OIDC_SCOPES` | Default `openid email profile`. |
| `OIDC_LABEL` | Button label (e.g. `Google`). |

### Web push (optional)

Enabled only when both keys are set; otherwise push is a no-op and in-app notifications still work. Generate a pair with `npx web-push generate-vapid-keys`.

| Variable | Description |
| --- | --- |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | VAPID key pair. |
| `VAPID_SUBJECT` | Contact, e.g. `mailto:admin@yourdomain.com`. |

### Not relevant in the container

- `PUBLIC_DIR` - the image embeds the frontend in the binary, so this is ignored. (It only applies to a backend-only build that serves a separate exported frontend.)
- `NEXT_PUBLIC_BACKEND_URL` - a frontend build-time value, baked to same-origin `/api` in the image.
- `FRONTEND_URL` - only used for dev cross-origin CORS; in the single-origin image it does not apply.

### Email

Email delivery is not wired (no SMTP). Verify-email, password-reset, and magic-link tokens are minted; in non-production their links are captured in an in-memory dev outbox at `GET /api/v1/auth/dev/outbox`.

### AI

AI is bring-your-own: providers and API keys are configured per workspace in the app and stored encrypted (with `AI_SECRET`), not via process env.

## Production hardening

- Set `NODE_ENV=production` (Secure cookies, https-only AI base URLs, no dev outbox).
- Set a strong, unique `JWT_SECRET` (and optionally a separate `AI_SECRET`).
- Use strong `POSTGRES_PASSWORD` / managed Postgres credentials.
- Terminate TLS at a reverse proxy in front of the container; set `APP_URL` and `BACKEND_PUBLIC_URL` to the public https URL.
- Persist `/app/.data/storage` (or move to object storage once the S3 driver lands).
- Back up the Postgres volume.

## Health checks and troubleshooting

- Liveness: `GET /healthz` returns `{"status":"ok","version":"..."}`.
- Readiness: `GET /readyz` returns 200 only when the database is reachable.
- Boot logs are structured JSON. A healthy start logs `database connected`, `database migrations up to date`, `serving embedded frontend`, then `api listening`.

Common issues:

- Container exits immediately with `JWT_SECRET is required`: set `JWT_SECRET`.
- `database connect failed ... connection refused`: the DB is unreachable. Most often `localhost` was used inside the container - see [the localhost gotcha](#networking-the-localhost-gotcha).
- `database ... does not exist`: create the target database first; HyCanvas creates tables, not the database.

Inspect a failed run with `docker logs <container>`.
