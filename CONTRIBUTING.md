# Contributing to HyCanvas

Thanks for your interest in improving HyCanvas. Bug reports, translations, templates, docs fixes, and code are all welcome. This guide gets you from a fresh clone to an open pull request, then covers the project's layout, scripts, and conventions.

New here? Issues labelled [`good first issue`](https://github.com/hyscaler/HyCanvas/labels/good%20first%20issue) are small, scoped, and say which files to touch. Questions go to [Discussions](https://github.com/hyscaler/HyCanvas/discussions); security reports go to the [Security tab](https://github.com/hyscaler/HyCanvas/security/advisories/new), never a public issue.

## Your first pull request

The Docker dev stack needs nothing installed but Docker and git. It runs Postgres, the Go backend on `:8005`, and the Next.js dev server on `:3000`, with live reload against your working tree.

1. Fork the repository and clone your fork.
2. Start the stack (the first build takes a few minutes; later starts are quick):

   ```bash
   docker compose -f docker-compose.dev.yml up --build
   ```

3. Open `http://localhost:3000`, create an account, and find the thing you want to change.
4. Make the change on a branch. The frontend reloads on save, and the backend rebuilds and restarts when a Go file changes.
5. Run the tests inside the stack:

   ```bash
   docker compose -f docker-compose.dev.yml exec app npm run test
   ```

6. Push the branch and open a pull request against `development`. The CLA bot asks you to sign once (see [below](#license-of-contributions-cla-required)); CI runs the same tests.

Keep pull requests focused, describe what changed and why, and reference the issue. Do not commit secrets; `.env` is gitignored and must stay that way.

## Contributing a template

A small template library is the most common gap people point out in any design tool, so templates are one of the most useful contributions. Built-in templates are compact JSON specs in `scripts/templates/` (140 today), compiled into the binary:

1. Copy a spec close to what you want (for example `scripts/templates/a4-invoice.json`) to a new file with a unique `id`.
2. Edit the size, pages, and nodes: hex colours, text blocks, shapes, buttons, icons, and picture slots. Use fonts from the in-app font catalog, and only images you have the right to contribute under the AGPL.
3. Compile and validate: `node scripts/build-templates.mjs --check`, then without `--check` to write `backend/internal/templates/seed.json`.
4. Restart the backend and open the template from the dashboard to check it.
5. In the pull request, attach a PNG export of every page.

More detail is under [Built-in Templates](#built-in-templates).

## Before opening a pull request

Run the checks locally (or with `docker compose -f docker-compose.dev.yml exec app ...`) and make sure they pass:

```bash
npm run lint            # vet the Go backend, lint the frontend
npm run test            # package + Go backend tests
npm run build:dist      # full production build into a single binary
```

## Making changes

- Match the style and patterns of the surrounding code. TypeScript is strict; Go is the backend language.
- For shipped features, the code is the reference. For roadmap areas, read the relevant `docs/roadmap/` spec first.
- After editing any `packages/*` source, run `npm run build:packages` so the frontend picks up the change.
- Changes that touch the design file format or the database follow the zero data loss rules in [`CLAUDE.md`](CLAUDE.md#zero-data-loss-non-negotiable): additive schema changes with a forward migration, and no destructive SQL.

## Repository Layout

The frontend and shared packages are an npm-workspaces monorepo (orchestrated with concurrently and dotenv-cli against a single shared root `.env`); the backend is a standalone Go module.

- `backend`: Go backend (REST under `/api/v1`, the `/realtime` WebSocket, the Go rendering engine for export, and DB migrations). Serves the exported frontend in the production bundle. Postgres only.
- `frontend`: Next.js app (Pages Router), statically exported for production.
- `packages/*`: framework-agnostic `@hc/*` libraries (schema, engine, editor, sdk, color, text, geometry, export, media, stock, templates, authz, formula, sheets, timeline, whiteboard, docs, publishing, website, print, a11y, ...). The frontend imports them from their built `dist/`.
- `scripts/build-dist.js`: embeds the exported frontend into the Go binary (`go build -tags embed`) and writes the single self-contained `dist/hycanvas`.


## Development without Docker

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

Prerequisites: Node 24 (see `.nvmrc`), Go 1.25, and PostgreSQL. Object storage is optional; the backend falls back to local files. `JWT_SECRET` is required (the API refuses to start without it); generate one with `openssl rand -hex 32`.

### More on the Docker dev stack

The stack from [Your first pull request](#your-first-pull-request) runs the Go backend on `:8005` and the Next.js dev server on `:3000` with live reload against your working tree:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open `http://localhost:3000`. See [DOCKER_SETUP.md](DOCKER_SETUP.md#option-c-local-development) for details.


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
| `npm run deploy` | Build the dist bundle and restart the built-in service (`hycanvas service restart`). |

## Built-in Templates

The starter template catalog lives in `backend/internal/templates/seed.json` and is compiled into the binary (`//go:embed`). There is no seed command or database step: the templates are served directly from the embedded JSON, merged with any templates saved to the database.

The seed is compiled, never hand-edited: each template is a compact spec in `scripts/templates/*.json` (hex colours, text blocks, buttons, icons, drawings, picture slots, live charts, and bundled illustrations), and `node scripts/build-templates.mjs` validates every spec against the schema and writes the seed. The presentation templates are generated from one library of looks and layouts (`scripts/lib/deck-kit.mjs`): `node scripts/gen-deck-kits.mjs` writes the six kits, `node scripts/gen-topic-decks.mjs` the thirty-one topic decks from the copy in `scripts/topics/`, `node scripts/gen-single-slides.mjs` the single slides, and `node scripts/gen-signature-decks.mjs` the three decks with a look of their own, so a grid change lands on every slide at once. To add or edit a built-in template, edit or add a spec, run the build, then rebuild/restart the backend so it re-embeds the file:

- Development: restart `npm run dev` (it runs the backend via `go run`, which recompiles each start).
- Production (native): `npm run build:dist` then `npm run start:dist:only` (or `npm run deploy`).
- Docker: rebuild from source with `docker compose -f docker-compose.prod.yml up --build` (the default `docker compose up` pulls the published image and won't include local edits).

User-saved templates (Save as template) are stored in the database and need no rebuild.


## Releases and publishing (maintainers)

Two long-lived branches: `development` (ongoing work) and `stable` (release-ready). Pushing commits builds no Docker images and cuts no releases; CI runs tests only. Releasing is explicit:

1. Merge `development` into `stable` when it is release-ready.
2. Tag on `stable`: `git tag v0.2.0 && git push origin v0.2.0`. The release workflow REFUSES tags whose commit is not on `stable`.

One tag then drives everything (`.github/workflows/release.yml`):

- **Binary release**: the frontend builds once, the embedded binary cross-compiles for all five platforms (pure Go, `CGO_ENABLED=0`), and a GitHub Release is published with the archives and `SHA256SUMS.txt`. Hyphenated tags (`v0.2.0-rc.1`) are marked pre-release.
- **Docker images**, always lean (the `docker` job packages the just-built release binaries into the runtime-only `Dockerfile.release`; no toolchains, no from-source image builds anywhere):
  - a final tag `v0.2.0` publishes `hycanvas/hycanvas:latest`, `:development`, `:0.2.0`, and the rolling minor alias `:0.2`;
  - a pre-release tag `v0.2.0-rc.1` publishes `:development` and `:0.2.0-rc.1` only, so the development channel previews the next release while `latest` stays on the last final one.
- **Docker Hub overview**: any change to `docker/README.md` on `development` is synced to the Docker Hub repository description automatically by `.github/workflows/dockerhub-description.yml` (also runnable manually from the Actions tab).

The Actions "Run workflow" button on the release workflow does a build-only dry run without releasing or publishing images.

The version stamped into the binary (`git describe`) is logged on startup and reported by `/healthz`.

## Conventions

- TypeScript everywhere, strict mode. Keep the rendering engine free of any React or UI dependency.
- For shipped features, match the surrounding code; for unbuilt work, read the relevant `docs/roadmap/` spec first.
- Never use longdash characters or standalone three-hyphen horizontal rules in markdown.


## License of contributions (CLA required)

From v0.3.17 onwards HyCanvas is distributed under the GNU Affero General Public License v3 (`AGPL-3.0-only`, see `LICENSE`), with [commercial licensing](COMMERCIAL.md) available from HyScaler for use without the AGPL obligations.

Why a CLA: selling a commercial license means licensing the whole codebase, including your contribution, under terms other than the AGPL, and only the author of a contribution can grant that right. So every contributor signs the [Contributor License Agreement](CLA.md) once: the CLA bot asks on your first pull request, and signing is a single comment. You keep ownership of your contribution and grant HyScaler the license rights described in the CLA. Code released under the AGPL stays available under the AGPL: the CLA adds a second license for HyScaler alongside it, it does not withdraw the first.

Opening a pull request is not by itself acceptance; the signature comment is. HyScaler's own personnel are exempt (HyScaler already owns their work) and are listed in the bot's allowlist in `.github/workflows/cla.yml`.

## Reporting security issues

Please do not open public issues for vulnerabilities. See `SECURITY.md`.
