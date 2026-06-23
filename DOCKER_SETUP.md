# Docker setup guide

HyCanvas ships as a single self-contained image: one Go binary serves the web UI, the REST API (`/api/v1`), and the realtime WebSocket (`/realtime`) on one port, applies its database migrations on boot, and bundles ffmpeg for video export. The only external dependency is PostgreSQL.

This guide covers the two ways to run it and documents every environment variable.

## Contents

- [Option A: published image + your own Postgres](#option-a-published-image)
- [Option B: docker compose (bundled or external Postgres)](#option-b-docker-compose)
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
cp .env.example .env     # set JWT_SECRET at minimum
docker compose up        # add --build to rebuild the image from source
```

This serves everything at http://localhost:8005, with Postgres as a companion service. Stop with `docker compose down` (add `-v` to also drop the data volumes).

Compose chooses the database from `.env`:

- BUNDLED (default): `COMPOSE_PROFILES=bundled` runs the `db` container and assembles the connection URL from `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`. The `.env` `DATABASE_URL` (localhost-based) is ignored inside compose.
- EXTERNAL (bring your own managed Postgres): set `EXTERNAL_DATABASE_URL` and `COMPOSE_PROFILES=` (empty) so the bundled container does not start.

## Networking: the localhost gotcha

Inside a container, `localhost` is the container itself, not your host machine. So:

- App and DB in Docker: connect via the DB's service/container name on a shared network (e.g. `hycanvas-db:5432` above, or `db:5432` under compose).
- Postgres running on the host (Docker Desktop): use `host.docker.internal` instead of `localhost`, e.g. `postgresql://user:pass@host.docker.internal:5432/hycanvas?schema=public`. Make sure the target database already exists (HyCanvas creates its tables, not the database itself).

## Persistence and volumes

With the default local storage driver, uploads, exports, and snapshots are written under `LOCAL_STORAGE_PATH` (`/app/.data/storage` in the image). Mount a named volume there to persist them:

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
| `DATABASE_URL` | - | Postgres connection string. Required when running the image directly. Under compose it is assembled from `POSTGRES_*` instead. |
| `PORT` | `8005` | Port the binary listens on (UI + API + realtime). `GO_API_PORT` is an accepted alias. |
| `NODE_ENV` | `development` | `production` marks session cookies Secure, requires https AI provider base URLs, and disables the dev mail outbox and permissive localhost CORS. Set `production` for real deployments. |
| `DB_AUTO_MIGRATE` | `true` | Apply pending SQL migrations on boot. Set `false` to manage migrations out of band. |
| `APP_URL` | - | Public base URL of the app, used to build links in outbound email (verify email, password reset, magic link). |
| `AI_SECRET` | falls back to `JWT_SECRET` | AES-256-GCM key encrypting secrets at rest: per-workspace AI provider keys and MFA TOTP secrets. Set a dedicated value to rotate it independently of `JWT_SECRET`. |

### Database (compose only)

| Variable | Default | Description |
| --- | --- | --- |
| `POSTGRES_USER` | `postgres` | Credentials the compose `db` service provisions and that compose uses to build the in-network `DATABASE_URL`. |
| `POSTGRES_PASSWORD` | `password` | Set a strong value for any real deployment. |
| `POSTGRES_DB` | `hycanvas` | Database name. |
| `COMPOSE_PROFILES` | `bundled` | `bundled` runs the Postgres container; empty (with `EXTERNAL_DATABASE_URL` set) runs only the app. |
| `EXTERNAL_DATABASE_URL` | - | Connection string for a managed Postgres, used when `COMPOSE_PROFILES` is empty. |

### Storage and uploads

| Variable | Default | Description |
| --- | --- | --- |
| `STORAGE_DRIVER` | `local` | `local` filesystem storage. (`s3` is reserved; the Go backend has no S3 driver yet, so keep `local`.) |
| `LOCAL_STORAGE_PATH` | `.data/storage` | Where uploads/exports/snapshots are written. In the image this is `/app/.data/storage` - mount a volume there. Use an absolute path outside Docker. |
| `BACKEND_PUBLIC_URL` | (relative) | Absolute base URL used to build asset delivery links. Set to your public URL behind a proxy/CDN. |
| `ASSET_QUOTA_BYTES` | (unset) | Caps per-workspace upload storage in bytes (e.g. `5368709120` = 5 GiB). |
| `S3_*` | - | Reserved for a future S3/MinIO driver; not yet implemented. |

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
