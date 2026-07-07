<p align="center">
  <img src=".github/readme-banner.png" alt="HyCanvas: design anything, own everything" width="820">
</p>

HyCanvas is a free, self-hostable, AI-native alternative to Canva. Design anything - social graphics, presentations, videos, whiteboards, docs, and print - with no paywalls or watermarks. Web-only.

The product spans a single-player editor, document types (presentations, video, whiteboard, docs, sheets), export, brand kits, and a bring-your-own-key AI layer. Work not yet built is tracked under `docs/roadmap/`.

## Repository Layout

The frontend and shared packages are an npm-workspaces monorepo (orchestrated with concurrently and dotenv-cli against a single shared root `.env`); the backend is a standalone Go module.

- `backend` - Go backend (REST under `/api/v1`, the `/realtime` WebSocket, the Go rendering engine for export, and DB migrations). Serves the exported frontend in the production bundle. Postgres only.
- `frontend` - Next.js app (Pages Router), statically exported for production.
- `packages/*` - framework-agnostic `@hc/*` libraries (schema, engine, editor, sdk, color, text, geometry, export, media, stock, templates, authz, formula, sheets, timeline, whiteboard, docs, publishing, website, print, a11y, ...). The frontend imports them from their built `dist/`.
- `scripts/build-dist.js` - embeds the exported frontend into the Go binary (`go build -tags embed`) and writes the single self-contained `dist/hycanvas` for PM2.

## Documentation

- `docs/roadmap/` - forward-looking specs for work not yet built (realtime collaboration, AI media, accessibility/i18n/enterprise).
- `CLAUDE.md` - working guidance for this repository.

## Prerequisites

- Node 24 (see `.nvmrc`) for the frontend and shared packages.
- Go 1.25 for the backend (`backend`).
- PostgreSQL. Object storage is optional (S3-compatible / MinIO); the backend falls back to local-file storage.
- ffmpeg only if you want server-side video export (already bundled in the Docker image).

## Development

```bash
cp .env.example .env        # then edit values (at minimum DATABASE_URL + JWT_SECRET)
npm install                 # installs the frontend + shared packages
npm run build:packages      # build the @hc/* libraries once (the frontend imports their dist)
npm run db:migrate          # apply SQL migrations (Go migrator)
npm run dev                 # backend (Go) on :8005, frontend on :3000
```

Open `http://localhost:3000`. The frontend reads the backend base URL from `NEXT_PUBLIC_BACKEND_URL` (defaults to `http://localhost:8005/api`).

Notes for development:
- `npm run build:packages` is required before the first `npm run dev` (and after editing any `packages/*` source), because the `@hc/*` packages are consumed from their compiled `dist/`, not their source. `npm run build` and `npm run build:dist` build the packages for you.
- The server also runs migrations on boot when `DB_AUTO_MIGRATE=true`, so `npm run db:migrate` is mainly for an explicit, pre-boot migration.
- No SMTP is wired: verify-email / password-reset / magic-link links are read from the dev outbox in non-production instead of being emailed.

## Production

The production bundle is a single self-contained binary: `dist/hycanvas`. The statically-exported frontend is baked into it (`go:embed`, built with `-tags embed`), so one binary serves the frontend, the REST API, and the realtime WebSocket on one port, with no Node runtime and no sidecar `public/` folder. It migrates the database on boot. The build also stamps the git version into the binary; it is logged on startup and returned by `/healthz` and `/api/v1/_go/health`.

```bash
npm run build:dist          # builds @hc/* + the frontend (routed to /api), embeds it, and compiles the Go binary into dist/
./dist/hycanvas       # run it directly: the binary loads .env itself, no Node needed
```

Running the bundle needs no Node at all: the Go binary loads a `.env` from the working directory (or its parent) on startup, so `./dist/hycanvas` is fully standalone, exactly how it runs under Docker and PM2. Real environment variables always win over `.env`, so injected config (containers, PM2, CI) is never overridden. `npm run start:dist:only` is just a convenience alias for the same binary.

If you build the binary without the embedded UI (for example a plain `npm run build:backend`), set `PUBLIC_DIR` to an exported frontend directory to serve it; with neither, the binary serves the API only and shows a short notice page.

In the dist build the frontend talks to the same-origin `/api` (no `NEXT_PUBLIC_BACKEND_URL` needed), so the one process answers UI and API together.

The binary can also run itself as a background service, so no external process manager is needed. `./dist/hycanvas start` (or just `./dist/hycanvas`) runs in the foreground; the `service` verbs manage a detached process with a pidfile and logfile next to the binary, on Linux, macOS, and Windows alike:

```bash
./dist/hycanvas service start       # detach into the background
./dist/hycanvas service status
./dist/hycanvas service log         # last log lines; -f follows
./dist/hycanvas service restart
./dist/hycanvas service stop
```

The binary's directory is the service's working directory, which is where `.env` is read from. The service does not auto-start at boot; if you want that, use Docker or your own supervisor (PM2 below).

### First-run setup wizard

No `.env` yet? Just start the server. On an interactive terminal it first asks whether to set up in the browser or right there in the terminal:

- **Web wizard** (default): the server boots into setup mode and prints a one-time wizard access secret; opening any page redirects to `/installation/step-1`, which asks for that secret and then walks through PostgreSQL, storage (local or S3), and optional SMTP, testing each answer live with visible progress. Answers are held on the server (never in the browser), and a page refresh always restarts at the welcome step.
- **CLI wizard**: the same questions asked in the terminal, with the same live validation and hidden password input.

Either way the wizard writes `.env` (secrets like `JWT_SECRET` are generated automatically), runs the database migrations, starts the app in the same process, and (in the browser flow) creates your first account. Non-interactive starts (Docker, pipes) default to the web wizard. To skip all of it, create a `.env` by hand (see `.env.example`) before starting.

Alternatively, run it under a process manager with PM2 (`ecosystem.config.js`):

```bash
npm run deploy              # build:dist + pm2 reload ecosystem.config.js
```

When writing `.env` by hand for production, set at minimum `NODE_ENV=production`, `DATABASE_URL`, a strong `JWT_SECRET`, `APP_URL` (public base URL used in generated links), and an absolute `LOCAL_STORAGE_PATH` (or `STORAGE_DRIVER=s3` with `S3_*`). AI provider keys are configured per workspace at runtime (stored encrypted), never via env.

## Install a prebuilt binary

Releases on the [GitHub releases page](https://github.com/hyscaler/HyCanvas/releases) ship the same self-contained binary prebuilt for Linux (amd64, arm64), macOS (Intel, Apple Silicon), and Windows (amd64), each archive containing the binary, `.env.example`, and the license files, plus a `SHA256SUMS.txt` for verification. You still need PostgreSQL; ffmpeg is only required for server-side video export.

```bash
tar -xzf hycanvas_<version>_<os>_<arch>.tar.gz && cd <unpacked dir>
./hycanvas service start    # asks: browser wizard or terminal wizard
```

The macOS binaries are not signed or notarized; if macOS quarantines the download, run `xattr -d com.apple.quarantine hycanvas` or right-click the binary and choose Open.

## Run with Docker (self-host)

The whole product (UI + REST API + realtime WebSocket) runs from one image, with Postgres as a companion service. For the full environment-variable reference and production options, see [DOCKER_SETUP.md](DOCKER_SETUP.md).

### Run the published image (fastest)

The repo ships a `docker-compose.yml` that pulls the prebuilt image (`linux/amd64` and `linux/arm64`) and runs it with a bundled Postgres:

```bash
cp .env.example .env   # set JWT_SECRET and APP_PORT (and POSTGRES_* if you like)
docker compose up -d
```

Then open `http://localhost:<APP_PORT>` (e.g. `http://localhost:8005`). `JWT_SECRET` and `APP_PORT` are required and migrations run on boot. Update later with `docker compose pull && docker compose up -d`. You don't even need a checkout, the same compose (and a `docker run` alternative) is in [docker/README.md](docker/README.md), runnable anywhere.

### Build from source

To run your own source instead of the published image, use the build variant (it builds `Dockerfile` and adds a container healthcheck + restart policy):

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

The build variant serves at `http://localhost:8005`; the published `docker-compose.yml` publishes on the host port you set in `APP_PORT`. Stop with `docker compose down` (add `-v` to drop the bundled Postgres volume).

Notes:
- ffmpeg (for video export) is bundled in the image; no host install needed.
- Local-file storage persists on the host at `./data/storage` (bind-mounted to `/app/.data/storage`) with the published `docker-compose.yml`, so it survives `docker compose down -v`. To use object storage instead, set the `S3_*` variables on the `app` service.
- Secrets/config (notably `JWT_SECRET`, and optionally `AI_SECRET`, `OIDC_*`, `VAPID_*`) come from your `.env`.
- To point the app at an external Postgres, set `EXTERNAL_DATABASE_URL` and `COMPOSE_PROFILES=` (empty) so the bundled `db` container does not start. For Postgres on the host, use `host.docker.internal` as the host (the published compose maps it via `extra_hosts`).

### Develop in Docker (hot reload)

To work on the code in containers, with no local Go or Node toolchain, use the dev stack. It runs the Go backend on `:8005` and the Next.js dev server on `:3000` with live reload against your working tree:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open `http://localhost:3000`. See [DOCKER_SETUP.md](DOCKER_SETUP.md#option-c-local-development) for details.

## Environment Variables

All configuration is read from the root `.env` (copy `.env.example`). The most important keys:

| Variable | Mode | Description |
| --- | --- | --- |
| `DATABASE_URL` | both | Postgres connection string. Required. |
| `JWT_SECRET` | both | Signs session tokens (also the fallback key for encrypting AI keys). Use a strong value in production. |
| `PORT` | both | Backend port (default `8005`). |
| `NODE_ENV` | both | `development` or `production`. |
| `DB_AUTO_MIGRATE` | both | When `true`, the server applies migrations on boot. |
| `NEXT_PUBLIC_BACKEND_URL` | dev | Frontend API base in dev (`http://localhost:8005/api`). Unused in the dist build (it calls same-origin `/api`). |
| `FRONTEND_URL` | both | Allowed CORS origin for the API (dev: `http://localhost:3000`). |
| `APP_URL` | prod | Public base URL used in generated links (verify-email, magic-link, share). |
| `STORAGE_DRIVER` | both | `local` (default) or `s3`. |
| `LOCAL_STORAGE_PATH` | both | Absolute path for local-file storage when `STORAGE_DRIVER=local`. Must be absolute so dev and the dist bundle share it. |
| `S3_*` | optional | S3-compatible object storage (endpoint, bucket, keys) when `STORAGE_DRIVER=s3`. |
| `AI_SECRET` | optional | Encrypts stored per-workspace AI keys; falls back to `JWT_SECRET`. |
| `OIDC_*` | optional | OIDC single sign-on (issuer, client id/secret). |
| `VAPID_*` | optional | Web-push keys for notifications. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `COMPOSE_PROFILES` | docker | Used by the bundled Postgres in `docker-compose.yml`. |

## Common Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run the Go backend and the frontend together with hot reload. |
| `npm run build:packages` | Build the `@hc/*` libraries (needed before dev on a fresh checkout). |
| `npm run build` | Build packages, the Go binary, and the frontend. |
| `npm run gen:theme` | Regenerate color tokens from `frontend/src/theme.config.mjs` (the frontend build runs this automatically). |
| `npm run db:migrate` | Apply SQL migrations (Go migrator). The server also migrates on boot. |
| `npm run lint` | Vet the Go backend and lint the frontend. |
| `npm run test` | Run the package and Go backend tests. |
| `npm run build:dist` | Compile the single `dist/hycanvas` binary with the frontend embedded (`-tags embed`) and the git version stamped in. |
| `npm run start:dist:only` | Run the already-built binary (alias for `./dist/hycanvas`, which loads `.env` itself). |
| `npm run deploy` | Build the dist bundle and reload it under PM2. |

## Built-in Templates

The starter template catalog lives in `backend/internal/templates/seed.json` and is compiled into the binary (`//go:embed`). There is no seed command or database step: the templates are served directly from the embedded JSON, merged with any templates saved to the database.

To add or edit a built-in template, edit `seed.json`, then rebuild/restart the backend so it re-embeds the file:

- Development: restart `npm run dev` (it runs the backend via `go run`, which recompiles each start).
- Production (native): `npm run build:dist` then `npm run start:dist:only` (or `npm run deploy`).
- Docker: rebuild from source with `docker compose -f docker-compose.prod.yml up --build` (the default `docker compose up` pulls the published image and won't include local edits).

User-saved templates (Save as template) are stored in the database and need no rebuild.

## Branding and theming

The app's color identity lives in one file: `frontend/src/theme.config.mjs` (the brand and accent scales, the identity gradient, the editor canvas-overlay colors, and the collaborator presence palette). To rebrand, edit that file and run `npm run gen:theme`. The generator rewrites the Tailwind CSS tokens, the typed canvas-overlay constants, and the Go presence palette, so one change propagates across the UI chrome, the gradient, the logo, the favicon/theme-color, the canvas overlays, and presence colors. `npm run gen:theme:check` (run as part of `npm run lint`) fails if the committed generated files drift from the source.

This product/app accent is intentionally separate from the per-workspace Brand Kit, which themes design content rather than the app shell.

## Releases and publishing (maintainers)

Merging to `development` runs CI only; the two public distribution channels have explicit triggers:

- **Binary releases**: pushing a `v*` tag (for example `git tag v0.1.0 && git push origin v0.1.0`) runs `.github/workflows/release.yml`, which builds the frontend once, cross-compiles the embedded binary for all five platforms from a single Ubuntu runner (pure Go, `CGO_ENABLED=0`), and publishes a GitHub Release with the archives and `SHA256SUMS.txt`. Tags containing a hyphen (`v1.0.0-rc.1`) are marked as pre-releases automatically. The Actions "Run workflow" button on the release workflow does a build-only dry run without creating a release.
- **Docker image**: pushing to the `docker/build/latest` or `docker/build/development` branch (for example `git push origin development:docker/build/latest`) runs `.github/workflows/docker-build-push.yml`, which builds and pushes the multi-arch `hycanvas/hycanvas` image to Docker Hub with the matching tag.
- **Docker Hub overview**: any change to `docker/README.md` on `development` is synced to the Docker Hub repository description automatically by `.github/workflows/dockerhub-description.yml` (also runnable manually from the Actions tab).

The version stamped into the binary (`git describe`) is logged on startup and reported by `/healthz`.

## Conventions

- TypeScript everywhere, strict mode. Keep the rendering engine free of any React or UI dependency.
- For shipped features, match the surrounding code; for unbuilt work, read the relevant `docs/roadmap/` spec first.
- Never use longdash characters or standalone three-hyphen horizontal rules in markdown.

## Contributing

See `CONTRIBUTING.md` for setup and the pull-request checklist, `CODE_OF_CONDUCT.md` for community expectations, and `SECURITY.md` for reporting vulnerabilities.

## License

HyCanvas is licensed under the Elastic License 2.0 (see `LICENSE`). This is a source-available license: you may use, modify, self-host, and redistribute it freely, but you may not provide it to third parties as a hosted or managed service, circumvent the license-key functionality, or remove the licensing notices. Third-party and bundled-asset notices are in `NOTICE`.

© 2026 HyScaler. HyCanvas is a product of HyScaler.
