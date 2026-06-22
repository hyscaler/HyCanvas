# CLAUDE.md

Guidance for working in the HyCanvas repository.

## What This Project Is

HyCanvas is a free, AI-native visual design platform built to lead on performance, AI quality, collaboration, openness, and accessibility. Everything is free: no tiers, no paywalls, no watermarks. Web-only.

Current state: the core product is built and runs. A single-player editor, content systems (uploads, stock, templates), accounts and workspaces, document types (presentations, video, whiteboard, docs, sheets), export, brand kits, and a bring-your-own-key AI layer all ship today. The remaining and early-stage work is tracked in `docs/roadmap/`.

## Source of Truth (read these first)

1. `README.md` - how to run the project (dev and production), the repository layout, environment variables, and the build/deploy story.
2. `docs/roadmap/` - forward-looking specs for work that is not yet built (realtime collaboration, AI media, accessibility/i18n/enterprise/NFR). Read the relevant spec before building in those areas.

For anything already shipped, the code is the source of truth; match the patterns of the surrounding code.

## Tech Stack

- Frontend: Next.js (React, Pages Router) + TypeScript, Zustand (editor state), Tailwind (UI chrome only, never for canvas content). Statically exported (`output: "export"`) for production.
- Rendering: custom scene-graph engine (`@hc/engine`) on Canvas2D, framework-agnostic so it runs in browser, worker, and headless on the server. A WebGL/WebGPU accelerated path is on the roadmap.
- Backend: Go (`backend`) - one service owning REST under `/api/v1`, the `/realtime` WebSocket, the Go rendering engine for export, and SQL migrations. chi router, pgx for Postgres. There is no Node API in the runtime.
- Realtime: a WebSocket relay with presence and locks ships; the full Yjs CRDT / offline-first model is on the roadmap (`docs/roadmap/16-realtime-collaboration.md`).
- Data: Postgres (metadata), S3-compatible object storage for assets/exports, with a local-filesystem fallback when no S3 is configured.
- Jobs: long work (export, video render, bulk create) runs through an in-process job registry, polled via `GET /api/v1/jobs/:id`.
- AI: a provider-adapter layer supporting built-in models and bring-your-own keys/endpoints; keys are stored encrypted per workspace, never via env.
- Auth: cookie sessions (httpOnly access + refresh with rotation), OIDC SSO, MFA (TOTP).
- Packaging: a single self-contained Go binary with the frontend embedded (`go:embed`, built `-tags embed`); the binary self-loads `.env`. Self-host via docker-compose.

## Monorepo Layout

The frontend and shared packages are an npm-workspaces monorepo (orchestrated with concurrently + dotenv-cli against a single shared root `.env`); the backend is a standalone Go module.

- `frontend` - Next.js app (Pages Router); statically exported for production and embedded into the Go binary.
- `backend` - the Go backend (REST, `/realtime`, export engine, DB migrations). Serves the embedded frontend in the production bundle. Postgres only.
- `packages/schema` - open file-format types and migrations (`@hc/schema`), no runtime deps.
- `packages/engine` - rendering engine (`@hc/engine`), no React/UI dependency.
- `packages/sdk` - typed REST/WS client (`@hc/sdk`).
- `packages/config` - typed, validated env config (`@hc/config`).
- `packages/ui` - shared UI utilities/components (`@hc/ui`).
- other `packages/*` - framework-agnostic `@hc/*` libraries (text, color, geometry, export, media, stock, templates, authz, formula, sheets, timeline, whiteboard, docs, publishing, website, print, a11y, ...). The frontend imports them from their built `dist/`.
- `scripts/build-dist.js` - embeds the exported frontend into the Go binary (`go build -tags embed`) and writes the single `dist/hycanvas` for PM2.

Keep the rendering engine free of any React or UI dependency so it stays reusable across browser, worker, and server.

## Key Architectural Rules

- The open design file format (`@hc/schema`) is the contract. Any feature that adds a node type or property must extend the schema and provide a forward migration. Opening an older file must always succeed.
- The database stores design snapshots in the open file format; restore, branch, export, and the API all reuse that format.
- Long-running work goes through the job registry, never inline in a request handler.
- Per-workspace data isolation is enforced at the query layer.
- Degrade gracefully: WebGL/WebGPU unavailable falls back to Canvas2D; object storage is abstracted so self-hosters can use local files or MinIO.

## Conventions

Documentation:
- Feature IDs: `F<seq>` (for example `F05`). Requirement IDs: `FR-<n>`. Acceptance criteria: `AC-<n>`.
- Never use longdash characters. Never use a standalone horizontal rule line of three hyphens. Markdown table separator rows are fine.
- The shipped code is the feature reference; `docs/roadmap/` holds the specs for unbuilt work. Keep the roadmap in sync when scope changes.

Code:
- TypeScript everywhere in the packages and frontend (strict mode); Go for the backend.
- Match the style and patterns of surrounding code.
- Errors as RFC 7807 problem+json from the API.
- Structured JSON logs.
- `@hc/*` packages are consumed from their built `dist/`, so run `npm run build:packages` after editing package source before the frontend sees the change.

## Common Commands

Run from the repo root. After cloning, copy `.env.example` to `.env`, then `npm install`.

- `npm install` - install the frontend + shared packages.
- `npm run build:packages` - build the `@hc/*` libraries (needed before the first `npm run dev`).
- `docker compose up --build` - run the whole product (UI + API + realtime) with Postgres.
- `npm run dev` - run the Go backend (:8005) and the frontend (:3000) with hot reload.
- `npm run build` - build packages, the Go binary, and the frontend.
- `npm run db:migrate` - apply SQL migrations (Go migrator); the server also migrates on boot.
- `npm run test` - run package and Go backend tests.
- `npm run lint` - vet the Go backend and lint the frontend.
- `npm run build:dist` then `npm run deploy` - build the single binary and (re)start under PM2.

## When Making Changes

- For shipped features, read the surrounding code and match it. For roadmap areas, read the relevant `docs/roadmap/` spec first.
- If a change adds or changes product scope in a roadmap area, update the relevant `docs/roadmap/` spec to keep it in sync.
- Verify before considering a change done; report honestly if tests fail or a step was skipped.
