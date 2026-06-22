# HyCanvas Frontend

The Next.js (Pages Router) web client for HyCanvas. This is the `frontend` workspace of the HyCanvas monorepo; see the repository root `README.md` and `CLAUDE.md` for the full picture.

## Running

Run from the repository root so the backend and shared packages come up too:

```bash
npm run dev          # backend on :8005, frontend on :3000
```

Or run just this workspace from the root:

```bash
npm run dev -w frontend
```

Open http://localhost:3000.

## How It Fits

- Router: Pages Router (`src/pages`). Marketing and dashboard pages can use SSR/SSG; the editor surface is client-rendered.
- Styling: Tailwind v4 for UI chrome only, never for canvas content.
- Backend: calls the NestJS API at `NEXT_PUBLIC_BACKEND_URL` (defaults to `http://localhost:8005/api`; resolves to `/api` in the production dist build). See `src/lib/api.ts`.
- Shared code: import design types from `@hc/schema`, rendering from `@hc/engine`, the API client from `@hc/sdk`, and UI helpers from `@hc/ui`. Do not reimplement engine or schema logic here.

## Production

The app is statically exported (`output: "export"` in `next.config.ts`). The root `scripts/build-dist.js` runs `build:dist` and the backend serves the export from `dist/public`.

## Structure

- `src/pages` - routes (`_app.tsx`, `_document.tsx`, `index.tsx`, `api/`).
- `src/lib` - client utilities (for example `api.ts`).
- `src/styles` - global styles.

## Conventions

- TypeScript strict mode; match surrounding patterns.
- Keep the rendering engine and file-format logic in `@hc/engine` and `@hc/schema`, not in app code.
- Never use longdash characters or standalone three-hyphen horizontal rules in markdown.
