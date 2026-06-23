# HyCanvas

A free, self-hostable, AI-native alternative to Canva: design anything, with no paywalls or watermarks. Shipped as a single self-contained image - one Go binary serves the web UI, the REST API, and the realtime WebSocket on one port, runs its database migrations on boot, and includes ffmpeg for video export. Postgres is the only external dependency.

## Quick start (self-contained: app + Postgres)

HyCanvas needs a Postgres it can reach over the network. The simplest way is to run one alongside it on a shared Docker network:

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

Then open http://localhost:8005.

`JWT_SECRET` is required (the app refuses to start without it). The app applies database migrations automatically on boot (`DB_AUTO_MIGRATE=true`).

### Using your own Postgres

Set `DATABASE_URL` to your server and make sure the target database exists (HyCanvas creates its tables, not the database). Note that `localhost` inside a container refers to the container itself, not your host - to reach a Postgres running on the host machine with Docker Desktop, use `host.docker.internal`:

```bash
-e DATABASE_URL="postgresql://user:pass@host.docker.internal:5432/hycanvas?schema=public"
```

## With Docker Compose (app + Postgres)

The repository ships a `docker-compose.yml` that runs HyCanvas plus a bundled Postgres:

```bash
git clone https://github.com/hyscaler/HyCanvas.git
cd HyCanvas
cp .env.example .env   # set JWT_SECRET (and POSTGRES_* if you like)
docker compose up
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
| `APP_URL`, `FRONTEND_URL`, `OIDC_*`, `AI_SECRET`, `VAPID_*` | no | See the repository README. |

Persist uploads/exports by mounting a volume at `/app/.data/storage`, or use S3.

## Tags

- `latest` - most recent stable build.
- `development` - latest development build.
- `<version>-<sha>` - immutable, pinned to a specific commit.

Built for `linux/amd64` and `linux/arm64`.

## Links

- Source and docs: https://github.com/hyscaler/HyCanvas
- License: Elastic License 2.0 (source-available).
