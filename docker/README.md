![HyCanvas: design anything, own everything](https://brand.hycanvas.com/assets/png/twitter-header-1500x500.png)

# HyCanvas

A free, self-hostable, AI-native alternative to Canva: design anything, with no paywalls or watermarks. Shipped as a single self-contained image - one Go binary serves the web UI, the REST API, and the realtime WebSocket on one port, runs its database migrations on boot, and includes ffmpeg for video export. Postgres is the only external dependency.

## Quick start (Docker Compose, recommended)

Create a `docker-compose.yml`, this pulls the published image and runs it with a bundled Postgres:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: hycanvas
      POSTGRES_PASSWORD: change-this-password
      POSTGRES_DB: hycanvas
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hycanvas -d hycanvas"]
      interval: 5s
      timeout: 5s
      retries: 12
    restart: unless-stopped

  app:
    image: hycanvas/hycanvas:latest
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "8005:8005"
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://hycanvas:change-this-password@db:5432/hycanvas?schema=public
      JWT_SECRET: change-me   # REQUIRED - generate with: openssl rand -hex 32
      # http://localhost quick start: cookies can't be Secure over http. Behind a
      # TLS reverse proxy, set this "true" (and APP_URL to your https origin).
      COOKIE_SECURE: "false"
    volumes:
      - storage:/app/.data/storage
    restart: unless-stopped

volumes:
  pgdata:
  storage:
```

```bash
docker compose up -d
```

Then open http://localhost:8005. `JWT_SECRET` is required (the app refuses to start without it); the app applies database migrations automatically on boot. Update later with `docker compose pull && docker compose up -d`.

> From a clone of the HyCanvas repository, `docker-compose.yml` runs the published image against your own managed Postgres (no bundled `db` service): it reads `JWT_SECRET`, `DATABASE_URL` (or `EXTERNAL_DATABASE_URL`), and the rest from a `.env`. Do `cp .env.example .env`, set `JWT_SECRET` and a reachable `DATABASE_URL`, then `docker compose up -d`. To get a bundled Postgres from a clone instead, build from source with `docker-compose.prod.yml` and `COMPOSE_PROFILES=bundled`.

### Using your own Postgres

Point `DATABASE_URL` at your server and drop the bundled `db` service. Make sure the target database exists (HyCanvas creates its tables, not the database). `localhost` inside a container is the container itself, not your host, to reach a Postgres on the host with Docker Desktop use `host.docker.internal`:

```
DATABASE_URL: postgresql://user:pass@host.docker.internal:5432/hycanvas?schema=public
```

### Alternative: docker run

If you prefer not to use Compose:

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

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. |
| `JWT_SECRET` | yes | Signs session tokens (and encrypts stored AI keys). Use a strong random value. |
| `PORT` | no | Defaults to `8005`. |
| `DB_AUTO_MIGRATE` | no | `true` (default) applies migrations on boot. |
| `STORAGE_DRIVER` | no | `local` (default) or `s3`. |
| `LOCAL_STORAGE_PATH` | no | Path for local file storage (default `/app/.data/storage`; mount a volume to persist). |
| `S3_*` | no | S3-compatible object storage when `STORAGE_DRIVER=s3`. |
| `APP_URL`, `OIDC_*` (SSO), `AI_SECRET`, `VAPID_*` (web push) | no | See the full setup guide. |

Persist uploads/exports by mounting a volume at `/app/.data/storage`, or use S3.

For every variable, SSO/web-push setup, external Postgres, and production hardening, see the [Docker setup guide](https://github.com/hyscaler/HyCanvas/blob/development/DOCKER_SETUP.md).

## Tags

- `latest` - most recent stable build.
- `development` - latest development build.
- `<version>-<sha>` - immutable, pinned to a specific commit.

Built for `linux/amd64` and `linux/arm64`.

## Prefer no Docker?

Prebuilt self-contained binaries for Linux (amd64/arm64), macOS (Intel/Apple Silicon), and Windows are on the [releases page](https://github.com/hyscaler/HyCanvas/releases). Unpack and run `./hycanvas service start`: a first run with no configuration walks you through setup in your browser (guarded by a one-time secret printed on the terminal) or directly in the terminal.

## Links

- Source and docs: https://github.com/hyscaler/HyCanvas
- License: Elastic License 2.0 (source-available).
