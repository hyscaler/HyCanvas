# Self-hosting HyCanvas

Everything an operator needs to run HyCanvas: Docker, the prebuilt binary, the production bundle, reverse proxies, storage, sign-in, and every environment variable. The [README](../README.md#quickstart) has the three-command Docker quickstart; this page covers what comes after it. The same material, illustrated, is on [docs.hycanvas.com](https://docs.hycanvas.com/operate/docker/).

## Run with Docker

The whole product (UI + REST API + realtime WebSocket) runs from one image, with Postgres as a companion service. For the full environment-variable reference and production options, see [DOCKER_SETUP.md](../DOCKER_SETUP.md).

### Quick trial with a bundled Postgres

[`docker/docker-compose.yml`](../docker/docker-compose.yml) runs the published image next to its own Postgres, so it needs nothing but Docker:

```bash
mkdir hycanvas && cd hycanvas
curl -fsSLO https://raw.githubusercontent.com/hyscaler/HyCanvas/development/docker/docker-compose.yml
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Open `http://localhost:8005` and create the first account. Set `HYCANVAS_PORT` in `.env` to publish on another port, and `POSTGRES_PASSWORD` to change the bundled database password before the first start. Keep `JWT_SECRET` stable: changing it signs everyone out, and it is also the key that encrypts stored AI provider keys. Update with `docker compose pull && docker compose up -d`.

### Run the published image against your own Postgres

The root `docker-compose.yml` pulls the prebuilt image (`linux/amd64` and `linux/arm64`) and runs it against your own managed Postgres (it ships no bundled `db`):

```bash
cp .env.example .env   # set JWT_SECRET, APP_PORT, and a reachable DATABASE_URL
docker compose up -d
```

Then open `http://localhost:<APP_PORT>` (e.g. `http://localhost:8005`). `JWT_SECRET`, `APP_PORT`, and a reachable `DATABASE_URL` (or `EXTERNAL_DATABASE_URL`) are required and migrations run on boot; inside a container `localhost` is the container, so use `host.docker.internal` for a DB on your machine (mapped via `extra_hosts`) or a managed endpoint. Update later with `docker compose pull && docker compose up -d`. For a quick trial with Postgres bundled, use the compose file above.

### Build from source

To run your own source instead of the published image, use the build variant (it builds `Dockerfile` and adds a container healthcheck + restart policy):

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

The build variant serves at `http://localhost:8005`; the published `docker-compose.yml` publishes on the host port you set in `APP_PORT`. Stop with `docker compose down`. The build variant can run a bundled Postgres (`COMPOSE_PROFILES=bundled`); add `-v` to drop that Postgres volume.

Notes:
- ffmpeg (for video export) is bundled in the image; no host install needed.
- Local-file storage persists on the host at `./data/storage` (bind-mounted to `/app/.data/storage`) with the published `docker-compose.yml`, so it survives `docker compose down -v`. To use object storage instead, set the `S3_*` variables on the `app` service.
- Secrets/config (notably `JWT_SECRET`, and optionally `AI_SECRET`, `OIDC_*`, `VAPID_*`) come from your `.env`.
- Database: the published `docker-compose.yml` always uses an external Postgres, set `DATABASE_URL` or `EXTERNAL_DATABASE_URL` in `.env`. The build-from-source `docker-compose.prod.yml` can bundle Postgres with `COMPOSE_PROFILES=bundled`, or point it external by emptying `COMPOSE_PROFILES` and setting `EXTERNAL_DATABASE_URL`. For Postgres on the host, use `host.docker.internal` (both compose files map it via `extra_hosts`).


## Install a prebuilt binary

Releases on the [GitHub releases page](https://github.com/hyscaler/HyCanvas/releases) ship the same self-contained binary prebuilt for Linux (amd64, arm64), macOS (Intel, Apple Silicon), and Windows (amd64). Each archive contains just the `hycanvas` binary (the first-run wizard generates the configuration), and a `SHA256SUMS.txt` accompanies the archives for verification. You still need PostgreSQL. Install ffmpeg too: without it server-side video export is unavailable and large videos get no preview proxy, so the editor scrubs the full original instead.

```bash
tar -xzf hycanvas_<version>_<os>_<arch>.tar.gz && cd <unpacked dir>
./hycanvas service start    # asks: browser wizard or terminal wizard
```

The macOS binaries are not signed or notarized; if macOS quarantines the download, run `xattr -d com.apple.quarantine hycanvas` or right-click the binary and choose Open.


## Prerequisites for the binary and source builds

- Node 24 (see `.nvmrc`) for the frontend and shared packages.
- Go 1.25 for the backend (`backend`).
- PostgreSQL. Object storage is optional (S3-compatible / MinIO); the backend falls back to local-file storage.
- ffmpeg for server-side video export AND for the 540p preview proxies that keep large videos smooth to scrub in the editor (already bundled in the Docker image; install it yourself when running the bare binary).

## Production

The production bundle is a single self-contained binary: `dist/hycanvas`. The statically-exported frontend is baked into it (`go:embed`, built with `-tags embed`), so one binary serves the frontend, the REST API, and the realtime WebSocket on one port, with no Node runtime and no sidecar `public/` folder. It migrates the database on boot. The build also stamps the git version into the binary; it is logged on startup and returned by `/healthz` and `/api/v1/_go/health`.

```bash
npm run build:dist          # builds @hc/* + the frontend (routed to /api), embeds it, and compiles the Go binary into dist/
./dist/hycanvas       # run it directly: the binary loads .env itself, no Node needed
```

Running the bundle needs no Node at all: the Go binary loads a `.env` from the working directory (or its parent) on startup, so `./dist/hycanvas` is fully standalone, exactly how it runs under Docker. Real environment variables always win over `.env`, so injected config (containers, CI) is never overridden. `npm run start:dist:only` is just a convenience alias for the same binary.

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

The binary's directory is the service's working directory, which is where `.env` is read from. The service does not auto-start at boot; if you want that, add a crontab entry (`@reboot /path/to/hycanvas service start`) or use Docker.

### First-run setup wizard

No `.env` yet? Just start the server. On an interactive terminal it first asks whether to set up in the browser or right there in the terminal:

- **Web wizard** (default): the server boots into setup mode and prints a one-time wizard access secret; opening any page redirects to `/installation/step-1`, which asks for that secret and then walks through PostgreSQL, storage (local or S3), and optional SMTP, testing each answer live with visible progress. Step 1 includes "Running HyCanvas behind a proxy?": when enabled you configure the external domain (e.g. `https://hycanvas.art`) separately from the internal host and port the proxy forwards to (written as `APP_URL`, `BIND_HOST`, and `PORT`). Answers are held on the server (never in the browser), and a page refresh always restarts at the welcome step.
- **CLI wizard**: the same questions asked in the terminal, with the same live validation and hidden password input.

Either way the wizard writes `.env` (secrets like `JWT_SECRET` are generated automatically), runs the database migrations, starts the app in the same process, and (in the browser flow) creates your first account. Non-interactive starts (Docker, pipes) default to the web wizard. To skip all of it, create a `.env` by hand (see `.env.example`) before starting.

`npm run deploy` rebuilds the bundle and restarts the running service in one step (`build:dist` + `./dist/hycanvas service restart`).

When writing `.env` by hand for production, set at minimum `NODE_ENV=production`, `DATABASE_URL`, a strong `JWT_SECRET`, `APP_URL` (public base URL used in generated links), and an absolute `LOCAL_STORAGE_PATH` (or `STORAGE_DRIVER=s3` with `S3_*`). AI provider keys are configured per workspace at runtime (stored encrypted), never via env. A user can also connect a personal key in Settings, used only in workspaces that have no provider of their own and allow personal keys.

### Running behind a reverse proxy

HyCanvas serves plain HTTP; put nginx, Caddy, or Traefik in front for TLS. Three settings matter: `APP_URL` is the external domain the proxy serves (used in generated links and the OIDC redirect), `PORT` is the internal port the proxy forwards to, and `BIND_HOST=127.0.0.1` keeps the app reachable only through the proxy. The setup wizard configures all three when you answer "Running HyCanvas behind a proxy?" in step 1. The proxy must forward the `Host` header and (for realtime collaboration) WebSocket upgrades on `/realtime`. With an https `APP_URL`, session cookies stay `Secure` automatically.

Also raise the proxy's request-body limit for uploads: nginx's default `client_max_body_size` of 1 MB rejects anything bigger with a 413 before HyCanvas ever sees it. Uploads arrive as 8 MiB chunks, so `client_max_body_size 16m;` is enough however large the files are. Caddy and Traefik impose no body limit by default.

Chunking is also what makes HyCanvas work behind a CDN. Cloudflare caps a request body at 100 MB on its Free, Pro and Business plans, and that limit is enforced at the edge: no origin setting can raise it, so a single large upload is rejected before it reaches your proxy at all. Because no chunk approaches that cap, uploads of any size pass through unchanged. On S3/MinIO deployments you can take the bytes out of the path entirely by enabling direct-to-bucket uploads; see "Uploads and object storage" below.

### Uploads and object storage

Uploads use a direct-upload handshake: the API grants an upload target, the browser sends the raw bytes there, and the API then validates the stored object (true size, magic-byte type sniff, quota) before recording the asset. File bytes are never base64-encoded and never buffered whole in API memory.

- **Local storage (default):** bytes stream through the API to disk, as a sequence of 8 MiB chunks reassembled server-side. An interrupted upload resumes from the last chunk the server acknowledged rather than starting over. Partial uploads spool under the OS temp directory; set `UPLOAD_SPOOL_DIR` to put them on a disk with room for the largest upload you allow. The only proxy knob is the body-size limit above.
- **S3/MinIO with `S3_DIRECT_UPLOADS="true"`:** browsers upload straight to the bucket with presigned POSTs; upload traffic never touches the API or its proxy. Two prerequisites: the bucket must allow cross-origin POSTs from your app origin, and browsers must be able to reach the bucket endpoint (set `S3_PUBLIC_URL` if `S3_ENDPOINT` is internal-only, such as a compose-network MinIO). Example MinIO CORS setup:

```
mc admin config set myminio api cors_allow_origin="https://hycanvas.example.com"
```

For AWS S3, attach a bucket CORS rule allowing `POST` from your app origin with `*` headers. If the direct-to-bucket leg fails (missing CORS, unreachable endpoint), the app logs a console warning and automatically falls back to streaming through the API, so uploads keep working while you fix the bucket config.

### Sign in with Google (or any OIDC provider)

Social sign-in is configured via env and appears on the login and signup pages once set. For Google:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), configure the OAuth consent screen, then create an OAuth client ID of type "Web application".
2. Add the authorized redirect URI: `<APP_URL>/api/v1/auth/oidc/callback` (for example `https://hycanvas.art/api/v1/auth/oidc/callback`).
3. Set in `.env` and restart (`./dist/hycanvas service restart`):

```bash
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=<client id>.apps.googleusercontent.com
OIDC_CLIENT_SECRET=<client secret>
OIDC_LABEL=Google
```

A "Continue with Google" button then shows on the auth pages. Any standards-compliant OIDC provider works the same way via its issuer URL; `OIDC_ALLOWED_EMAIL_DOMAINS` restricts sign-in to listed domains, and `OIDC_REDIRECT_URI` overrides the callback when the default does not fit. The issuer must be https (localhost excepted), and `APP_URL` must be set correctly, especially behind a proxy.

### Choosing which sign-in methods are allowed

Three sign-in methods ship (email + password, magic link, and OIDC/SSO), and each has an independent login and signup toggle so you can decide exactly how people get in and how accounts are created. Set any of these to `true` or `false`; anything else keeps the default. The defaults leave the product as it was before these settings existed, so you only set what you want to change.

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_PASSWORD_LOGIN_ENABLED` | `true` | Sign in with email + password |
| `AUTH_PASSWORD_SIGNUP_ENABLED` | `true` | Create an account with a password |
| `AUTH_MAGICLINK_LOGIN_ENABLED` | `true` | Emailed sign-in link for an existing account |
| `AUTH_MAGICLINK_SIGNUP_ENABLED` | `false` | Emailed link that creates a new account (create-on-click; nothing is created until the link is opened) |
| `AUTH_OIDC_LOGIN_ENABLED` | `true` | SSO sign-in (needs the `OIDC_*` settings above) |
| `AUTH_OIDC_SIGNUP_ENABLED` | `true` | SSO creates a new account on first login |

The sign-in page shows only the methods you leave on, so no user sees a form they cannot use. The toggles are enforced on the server too: a disabled method's endpoint returns 403, not just a hidden button.

Two guardrails apply automatically. The OIDC toggles do nothing unless OIDC is configured. And if a combination would leave no usable way to sign in, the server keeps password login on and logs a warning, so a typo cannot lock you out.

To run an instance where every account comes from your identity provider (no passwords, no magic links), turn the local methods off and leave OIDC on:

```bash
AUTH_PASSWORD_LOGIN_ENABLED=false
AUTH_PASSWORD_SIGNUP_ENABLED=false
AUTH_MAGICLINK_LOGIN_ENABLED=false
# OIDC_* configured as above; AUTH_OIDC_* left at their true default
```

Note when switching an existing instance to SSO-only: a user who already has a password account links their SSO identity to it automatically only when the provider's email domain is listed in `OIDC_ALLOWED_EMAIL_DOMAINS` (you are vouching that the provider owns those emails). Without that, their first SSO login creates a separate account. Set the allowlist before flipping the switch if you have existing password users.

### CAPTCHA on the auth forms

Protect login, signup, password-reset request, and magic-link request from automated abuse with Cloudflare Turnstile or Google reCAPTCHA. It is off until you set a provider:

```bash
CAPTCHA_PROVIDER=turnstile          # or "recaptcha"
CAPTCHA_SITE_KEY=<public site key>  # from the provider dashboard
CAPTCHA_SECRET_KEY=<secret key>
# CAPTCHA_MIN_SCORE=0.5             # reCAPTCHA v3 only; Turnstile / v2 ignore it
```

The site key is sent to the browser (public by design) and the sign-in page renders the widget; the secret verifies each response server-side. The redeem endpoints (password-reset and magic-link, which carry a token from an email, not a form) are not gated.

Two behaviors to know. It is **fail-closed**: if the provider is unreachable, the gated forms reject, so a solved challenge is always required once enabled; a provider outage blocks these forms, which is the correct default for a security control but is worth planning for. And a provider set without both keys is treated as disabled (and logged), so a half-configuration never 403s every login. Both instances behind Cloudflare make Turnstile the natural choice; reCAPTCHA works the same way via its keys.

### Moving from local storage to S3

Started on local-disk storage and want object storage later? The binary migrates itself:

```bash
./dist/hycanvas service stop       # stop first so no new objects land mid-copy
./dist/hycanvas storage migrate    # copies every object, verifies, updates .env
./dist/hycanvas service start
```

The S3 target (AWS, MinIO, R2, ...) is taken from `S3_*` in the environment when present, or asked interactively with a connectivity check; `--dry-run` previews the object count and size, and `--yes` makes it non-interactive for scripts. The copy is idempotent (already-present objects are skipped, so re-runs are safe), the database needs no changes (it stores storage keys, not URLs), and the local files are kept as a rollback until you delete them.


## Environment Variables

All configuration is read from the root `.env` (copy `.env.example`). The most important keys:

| Variable | Mode | Description |
| --- | --- | --- |
| `DATABASE_URL` | both | Postgres connection string. Required. |
| `JWT_SECRET` | both | Signs session tokens (also the fallback key for encrypting AI keys). Use a strong value in production. |
| `PORT` | both | Backend port (default `8005`). |
| `NODE_ENV` | both | `development` or `production`. |
| `DB_AUTO_MIGRATE` | both | When `true`, the server applies migrations on boot. |
| `DB_CONNECT_ATTEMPTS` | both | Times to retry the initial DB connect before giving up (default `12`). Tolerates Postgres still starting after a host reboot. |
| `DB_CONNECT_RETRY_DELAY` | both | Wait between initial-connect retries, as a Go duration (default `5s`). |
| `NEXT_PUBLIC_BACKEND_URL` | dev | Frontend API base in dev (`http://localhost:8005/api`). Unused in the dist build (it calls same-origin `/api`). |
| `FRONTEND_URL` | both | Allowed CORS origin for the API (dev: `http://localhost:3000`). |
| `APP_URL` | prod | Public base URL used in generated links (verify-email, magic-link, share). |
| `STORAGE_DRIVER` | both | `local` (default) or `s3`. |
| `LOCAL_STORAGE_PATH` | both | Absolute path for local-file storage when `STORAGE_DRIVER=local`. Must be absolute so dev and the dist bundle share it. |
| `S3_*` | optional | S3-compatible object storage (endpoint, bucket, keys) when `STORAGE_DRIVER=s3`. |
| `ASSET_QUOTA_BYTES` | optional | Per-workspace upload cap in bytes (default 2 GiB). |
| `USER_STORAGE_QUOTA_BYTES` | optional | Global per-user upload cap across all workspaces; unset/0 = unlimited. For public instances. |
| `BRAND_STARTER_KIT` | optional | `hycanvas` (default) seeds HyCanvas's own brand kit into workspaces that have none; `off` disables it. See [Branding and theming](#branding-and-theming). |
| `AI_SECRET` | optional | Encrypts stored AI keys (workspace and personal); falls back to `JWT_SECRET`. |
| `OIDC_*` | optional | OIDC single sign-on (issuer, client id/secret). |
| `AUTH_*_ENABLED` | optional | Enable/disable each sign-in method's login and signup (password, magic link, OIDC). Defaults preserve prior behavior. See [Choosing which sign-in methods are allowed](#choosing-which-sign-in-methods-are-allowed). |
| `CAPTCHA_*` | optional | Turnstile / reCAPTCHA on the auth forms (`CAPTCHA_PROVIDER`, `CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET_KEY`, `CAPTCHA_MIN_SCORE`). Off unless a provider is set. See [CAPTCHA on the auth forms](#captcha-on-the-auth-forms). |
| `GOOGLE_ANALYTICS_ID` | optional | GA4 measurement id (e.g. `G-XXXXXXXXXX`). When set, the server injects the gtag.js snippet into served HTML pages at runtime; empty means no analytics. |
| `VAPID_*` | optional | Web-push keys for notifications. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `COMPOSE_PROFILES` | docker | Used by the bundled Postgres in `docker-compose.yml`. |


## Branding and theming

The app's color identity lives in one file: `frontend/src/theme.config.mjs` (the brand and accent scales, the identity gradient, the editor canvas-overlay colors, and the collaborator presence palette). To rebrand, edit that file and run `npm run gen:theme`. The generator rewrites the Tailwind CSS tokens, the typed canvas-overlay constants, and the Go presence palette, so one change propagates across the UI chrome, the gradient, the logo, the favicon/theme-color, the canvas overlays, and presence colors. `npm run gen:theme:check` (run as part of `npm run lint`) fails if the committed generated files drift from the source.

This product/app accent is intentionally separate from the per-workspace Brand Kit, which themes design content rather than the app shell.

### The starter brand kit

HyCanvas ships its own brand kit the way it ships the template catalog: compiled into the binary (`backend/internal/brand/starter`) and present from the start. A workspace that has no kit receives it as the workspace default when the workspace is created (signup, a first single sign-on login, a new team workspace) and, once, on the first boot after the upgrade for workspaces that predate it. The kit carries the brand palette (plum, magenta, deep plum, blush, ink, paper, plus the gradient ends), Plus Jakarta Sans for headings and body, the logo and the mark in ink with their paper versions for dark grounds, the app tile, the colour lockup the app's own header uses, all stored as assets in the workspace library, and a house voice. A workspace that already has a kit of its own (one with any content, or one the owner named) is never touched; an empty kit still called "Untitled brand kit" is a placeholder, and the starter kit lands beside it as the default. A starter kit the owner deletes or replaces never comes back: the seeding records its visit on the workspace.

The default kit grounds every AI generation in the workspace (voice, palette, faces and the logo on every page), so an instance whose users bring their own brands should set `BRAND_STARTER_KIT="off"`. The spec is `starter/hycanvas.json`; the logo PNGs are rendered from the SVG masters in `starter/src` by `npm run gen:brand-starter` (needs `rsvg-convert`), and a change to either needs a backend rebuild so the binary re-embeds the files.

