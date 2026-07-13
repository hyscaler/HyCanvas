# Contributing to HyCanvas

Thanks for your interest in improving HyCanvas. This guide covers how to set up,
make changes, and submit them.

## Project layout

The frontend and shared packages are an npm-workspaces monorepo; the backend is a
standalone Go module under `backend/`. See `README.md` for the full layout and the
tech stack, and `docs/roadmap/` for specs of work that is not yet built.

## Prerequisites

- Node 24 (see `.nvmrc`) for the frontend and `@hc/*` packages.
- Go 1.25 for the backend.
- PostgreSQL (object storage is optional; the backend falls back to local files).

## Setup

```bash
cp .env.example .env        # then set DATABASE_URL and a strong JWT_SECRET
npm install
npm run build:packages      # build the @hc/* libraries once
npm run db:migrate          # apply migrations
npm run dev                 # backend on :8005, frontend on :3000
```

`JWT_SECRET` is required (the API refuses to start without it). Generate one with
`openssl rand -hex 32`.

## Making changes

- Match the style and patterns of the surrounding code. TypeScript is strict; Go
  is the backend language.
- For shipped features, the code is the reference. For roadmap areas, read the
  relevant `docs/roadmap/` spec first.
- After editing any `packages/*` source, run `npm run build:packages` so the
  frontend picks up the change.

## Before opening a pull request

Run the checks locally and make sure they pass:

```bash
npm run lint            # vet the Go backend, lint the frontend
npm run test            # package + Go backend tests
npm run build:dist      # full production build into a single binary
```

Keep pull requests focused, describe what changed and why, and reference any
related issue. Do not commit secrets; `.env` is gitignored and must stay that way.

## Releases and publishing

Merges to `development` run CI only; nothing publishes on ordinary commits.
Releases are cut by tagging `v*` on the `stable` branch (merge `development`
into `stable` first; the pipeline rejects tags from anywhere else). One tag
builds the binaries, the GitHub Release, and the lean Docker images
(`latest` + semver for final tags, `development` for pre-releases). The
Docker Hub overview syncs automatically from `docker/README.md`. The full
maintainer walkthrough is in the README under "Releases and publishing".

## License of contributions (CLA required)

HyCanvas is distributed under the Elastic License 2.0 (see `LICENSE`), with
[commercial licensing](COMMERCIAL.md) available from NetTantra for hosted
offerings. Selling a commercial exception means relicensing the code, and only
a contributor can grant that right, so every contributor signs the
[Contributor License Agreement](CLA.md) once: the CLA bot will ask on your
first pull request, and signing is a single comment. You keep ownership of your
contribution and grant NetTantra the license rights described in the CLA.

Opening a pull request is not by itself acceptance; the signature comment is.
NetTantra's own personnel are exempt (NetTantra already owns their work) and are
listed in the bot's allowlist in `.github/workflows/cla.yml`.

## Reporting security issues

Please do not open public issues for vulnerabilities. See `SECURITY.md`.
