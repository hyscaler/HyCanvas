<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes: APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# HyCanvas Frontend (agent guidance)

This is the `frontend` workspace of the HyCanvas monorepo. Read the repository root `CLAUDE.md` and `README.md` before building; for work not yet built, read the relevant spec in `docs/roadmap/`.

Key rules for this workspace:
- Router: Pages Router (`src/pages`). Keep the editor surface client-rendered; marketing/dashboard pages may use SSR/SSG.
- Styling: Tailwind v4 for UI chrome only. Never use Tailwind or CSS for canvas content; the design surface is rendered by `@hc/engine`.
- Backend: call the Go API at `NEXT_PUBLIC_BACKEND_URL` (`http://localhost:8005/api` in dev, `/api` in the dist build). Use `src/lib/sdk.ts` (the shared `oc` client) and `@hc/sdk`; do not hardcode URLs.
- Shared code: design types come from `@hc/schema`, rendering from `@hc/engine`, the API client from `@hc/sdk`, UI helpers from `@hc/ui`. Do not duplicate engine or schema logic in the app.
- Production: the app is statically exported (`output: "export"`); the backend serves it. Do not add server-only Next.js features that break static export without flagging it.
- Never use longdash characters or standalone three-hyphen horizontal rules in markdown.
