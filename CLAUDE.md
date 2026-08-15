# CLAUDE.md

Guidance for working in the HyCanvas repository.

## What This Project Is

HyCanvas is a free, self-hostable, AI-native design platform, built to lead on performance, AI quality, collaboration, openness, and accessibility. Everything is free: no tiers, no paywalls, no watermarks. Web-only.

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
- `scripts/build-dist.js` - embeds the exported frontend into the Go binary (`go build -tags embed`) and writes the single `dist/hycanvas`.

Keep the rendering engine free of any React or UI dependency so it stays reusable across browser, worker, and server.

## Key Architectural Rules

- The open design file format (`@hc/schema`) is the contract. Any feature that adds a node type or property must extend the schema and provide a forward migration. Opening an older file must always succeed.
- The database stores design snapshots in the open file format; restore, branch, export, and the API all reuse that format.
- Long-running work goes through the job registry, never inline in a request handler.
- Per-workspace data isolation is enforced at the query layer.
- Degrade gracefully: WebGL/WebGPU unavailable falls back to Canvas2D; object storage is abstracted so self-hosters can use local files or MinIO.

## Zero Data Loss (non-negotiable)

Every instance is someone's production instance, and self-hosters upgrade by swapping a binary. A change must be deployable onto a live instance holding real designs without destroying, corrupting, or silently altering any of it.

Rules for every change:
- **Never break existing data.** Opening, rendering, and saving a design created by any earlier version must keep working. If a change cannot preserve existing data, it does not ship in that form.
- **Every schema change is additive-first.** Add optional fields and new node types; do not repurpose, rename, or narrow an existing field's meaning. Additive changes need only a `CURRENT_SCHEMA_VERSION` bump, because older files omit the field and `UnknownNode.raw` preserves a newer client's nodes losslessly.
- **Never widen an enum on an existing node type.** It looks additive and is not: `UnknownNodeSchema` refuses any KNOWN node type, so a file carrying a new enum member fails both its own schema branch and the unknown-node fallback, and `validate()` rejects the WHOLE FILE on an older client. The Go write boundary is structural only, so the newer client saves it happily and the previous binary can then never open it. Put the new behavior on a new node type instead, and give that type a baked fallback (see below) so older clients still render something correct.
- **A bump touches two files or the write boundary rejects the file.** Raise `CURRENT_SCHEMA_VERSION` in `packages/schema/src/schema.ts` AND the Go mirror `currentSchemaVersion` in `backend/internal/persistence/file.go` in the same change, or `persistence/validate.go` returns 422 and nothing persists. Append the version-history line in `schema.ts`.
- **Provide the forward migration.** Register the migration step in `migrate.ts` keyed on the source version. Migrations are forward-only, idempotent, and never drop unrecognized data.
- **Destructive SQL is forbidden by default.** No `DROP COLUMN`, `DROP TABLE`, destructive `ALTER`, or backfill that overwrites user content. Additive columns are nullable or defaulted. If a genuinely destructive migration is unavoidable, it needs an explicit expand/migrate/contract plan, a verified backup, and the user's explicit approval before it is written.
- **An optional field survives an older client, but a rebuilt node does not.** Unknown keys are preserved end to end (`validate()` only judges and never replaces, a loaded file is the raw parse, migrations spread, and the CRDT is key-driven: `reconcileMap` iterates `Object.keys`), so adding an optional field is safe by default. The exception that actually loses data: `reconcileMap` deletes keys the source no longer has, so any store action that REBUILDS a node object from its known fields drops an unknown key and the reconcile removes it for every collaborator. Mutate nodes in place, or keep a large new payload on its own node that no older action rebuilds.
- **A new node type needs a baked fallback when it produces visible artwork.** `UnknownNode.raw` preserves the data but nobody renders it, so a document authored on a newer client shows a hole on an older one. Carry the last evaluated output (flattened geometry or a raster proxy) alongside the parameters so a client that does not understand the type still draws the right thing.
- **Mixed versions must coexist.** During a rollout an old client and a new client may edit the same design. Neither may discard the other's data, and a rollback to the previous binary must leave existing designs openable.
- **Prove it before deploying.** Verify against a database seeded with pre-change designs (open, edit, save, export, restore an old version), not just fresh ones. A pure code change that touches no schema and no SQL should say so explicitly when reporting.

## Conventions

Naming:
- Describe code by what it does, not by whose product it resembles. "Floating selection toolbar", not "<competitor>-style toolbar"; "equal-spacing guides", not "<competitor>'s pink guides". This applies to source comments, commit messages, test names, and user-facing strings.
- HyCanvas is stated on its own terms: a full-featured, self-hostable design platform. Its positioning does not define it against another product.
- Market context in `docs/roadmap/` (what exists, where the capability bar sits, where a gap is) is how we decide what to build, and stays. We do not set our own goals by another product's feature list.

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

Theming and branding:
- The product/app accent (the application shell color identity) has ONE source of truth: `frontend/src/theme.config.mjs`. Edit colors there and run `npm run gen:theme`; it regenerates the CSS tokens, the canvas-overlay constants, and the Go presence palette. Never hardcode brand hex or raw `blue/indigo/sky/cyan` accent classes in components.
- The app accent is global (shipped with the binary) and intentionally INDEPENDENT of the per-workspace Brand Kit. The Brand Kit themes design content only; it must never repaint the app chrome, and an app-accent change must never touch a customer's design colors.
- Dark mode themes the APP CHROME only and is token-driven: the dark palette lives in `theme.config.mjs` (the generator emits a `.dark { }` override region into globals.css), and `lib/theme.ts` applies the stored preference as a `dark` class on `<html>`. Use `bg-surface` for elevated white cards (never raw `bg-white` on themable chrome), `text-brand-ink` for accent text on chrome, and the `light` class to pin a subtree light (document surfaces like sheets, docs, and present mode; the video editor's chrome follows the app theme). Design content is never dark-moded.

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
- `npm run build:dist` then `npm run deploy` - build the single binary and restart it via the built-in service daemon (`hycanvas service restart`).

## When Making Changes

- For shipped features, read the surrounding code and match it. For roadmap areas, read the relevant `docs/roadmap/` spec first.
- If a change adds or changes product scope in a roadmap area, update the relevant `docs/roadmap/` spec to keep it in sync.
- Verify before considering a change done; report honestly if tests fail or a step was skipped.
