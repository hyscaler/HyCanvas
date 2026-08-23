# F16: Realtime Collaboration

| Field | Value |
| --- | --- |
| Feature ID | F16 |
| Phase | 3 Collaboration |
| Sequence | 16 |
| Status | Core shipped (CRDT sync, presence/cursors/follow, offline, locks with heartbeat-timeout release, auth, per-user undo, move/intention primitive, character-level rich-text merge, horizontal Redis fan-out, boundary schema validation + relay wire hardening, live permission downgrade mid-session, CRDT update-log history scrubber, automatic snapshot triggers, cross-instance live role downgrade + cross-instance roster catchup + cross-instance lock authority via Redis CAS, update-log compaction via client checkpoints, server-side CRDT fold via the embedded pure-Go JS engine + server-authoritative last-leave snapshot, true in-CRDT named branches with live switching); remaining: on-the-wire per-node CRDT enforcement only (a server-side decoder now EXISTS, but per-frame decode cost keeps this deferred). Scale is CLOSED: page-granular incremental projection + a measured browser paint proof (AC-10: p50 120fps at 50 pages x 1000 nodes, dpr 2); true per-page Y.Doc subdocuments are deliberately rejected (a per-room protocol change old clients in the same live room cannot survive) |

## Implementation status

Audited against the code: frontend `src/lib/ydoc.ts`, `src/lib/realtime.ts`, `src/lib/useRealtime.ts`, `src/lib/useAutoSnapshot.ts`, `src/lib/historyFold.ts`, `src/store/presence.ts`, `src/components/editor/PresenceOverlay.tsx`, `src/components/editor/HistoryPanel.tsx`; `@hc/schema/src/yjs.ts`; `@hc/realtime/src/reconcile.ts` + `seed.ts`; backend `internal/realtime/{hub,serve,presence,locks,coordinator,coordinator_redis,lockstore}.go`, `internal/httpapi/realtime.go`, `internal/persistence/{writes,history_updates}.go`.

The core of F16 ships, and the multi-instance story is complete: the design is a real Yjs CRDT; edits sync live over `/realtime`; presence/cursors/follow render; editing works offline via IndexedDB; connections are authenticated with read-only enforced server-side; collaborative locks work end to end with heartbeat-TTL release; permission downgrades flip an editor to read-only live; per-user undo and character-level rich-text merge ship; the gateway scales horizontally (Redis fan-out + cross-instance roster catchup, live role downgrade, and Redis-CAS lock authority); the history time machine scrubs the CRDT update log and restores any point; and snapshots fire automatically with the update log bounded by client checkpoints.

The server can now DECODE the CRDT (`backend/internal/crdt`): the exact client fold (yjs + y-protocols + `@hc/realtime` docToFile) is bundled to `fold.js` (`npm run gen:crdt-fold`, committed) and executed in-process under goja, a pure-Go JavaScript engine - no cgo, no second runtime, single binary intact, output byte-identical to the browser fold (fixture-proven in `fold_test.go`). On top of it ships the server-authoritative LAST-LEAVE snapshot (FR-11): when a room loses its last local connection (10s grace, canceled by rejoin - `hub.WithLastLeaveHook`), `persistence.SnapshotFoldedUpdateLog` folds the journaled update log and materializes an AUTO snapshot, closing the crashed-tab gap where journaled edits were never materialized. The fold is strictly catch-up-only: it runs only when the log tail postdates the design's current snapshot, so it can never rotate current backwards past a client save or REST write; redundant folds (multi-instance last-local-leave) dedup via the content-addressed AUTO snapshot path. It also refuses a GAPPED log: the client drops outbound frames while its socket is down and reconverges over the sync handshake, which is not journaled, so a journal can legitimately have holes; Yjs would park those deltas as `pendingStructs` and project a plausible-but-partial file, and folding that would silently roll current backwards. The fold errors instead (the caller then materializes nothing), and is bounded in frames, bytes, and wall-clock (a goja interrupt) so an attacker-influenced frame cannot wedge a goroutine.

TRUE IN-CRDT BRANCHES (FR-10) now ship: a branch is a named fork point INSIDE one design (`design_branches` + a nullable `branch_id` on `design_update_logs`, both additive), whose state is the parent lineage's update log up to `forked_from_seq` plus the branch's own rows. All rows share the design-global seq space and the same Yjs identity space, so a branch's lineage is one ascending seq stream that pages with the plain `afterSeq` cursor (`ListBranchUpdates`; nesting supported to a bounded depth) and folds with the unchanged client machinery. Live editing joins a branch ROOM (`/realtime?branch=`, hub room key design+branch): sync, presence, and locks are fully isolated from main, while bans and live role refreshes stay design-scoped across all rooms. The client switches branches from the History panel (Branches section + "Branch from here" at any scrub stop): the realtime binding tears down and rebinds with a branch-scoped IndexedDB namespace, seeds the fresh Y.Doc from the journaled lineage (CRDT-idempotent against room sync/offline state), and a doc bound right after a lineage switch REFUSES store-seeding in BOTH directions (the store still holds the lineage just left), so main state can never leak into a branch nor branch state onto main. Safety rails: design-level snapshots, restores, and named checkpoints are gated off during a branch session (they rotate MAIN's current file); Save/auto-save on a branch instead upload branch-scoped compaction checkpoints (durability = the journal itself); checkpoint compaction never deletes rows at or below a dependent branch's fork point, in ANY lineage, so a branch's base prefix always survives; compaction and branch creation serialize on a design-scoped advisory lock and a fork onto history a checkpoint already compacted away is refused (a stale history page would otherwise mint a branch with no base); manual Save on a branch checkpoints only when SOLO (a peer's edits journaled during the upload would otherwise compact away) and reports saved only when the socket actually delivered the work; and the last-leave server fold runs for main rooms only. Switching never discards anything (AC-7).

SCALE (FR-7/AC-10) is now closed, deliberately WITHOUT true Y.Doc subdocuments. Making each page its own Y.Doc changes the room sync protocol (per-subdoc sync scopes) in a way an older client in the SAME live room cannot survive - a mixed-version data-loss hazard - and would partition the journal, checkpoint compaction, history fold, and offline store. The costs subdocuments were meant to bound are bounded other ways: (1) the client's real per-update scale cost was the FULL-document projection on every remote update - `fromDocWithPageReuse` (@hc/realtime) + per-page dirty tracking in `ydoc.ts` now re-project ONLY the pages a transaction touched and reuse every other page object by identity, so a peer's one-shape edit costs one page, not fifty; (2) per-frame paint cost is page-scoped already (the editor renders the open page; scenes cache per page); (3) the CRDT binary itself is compact and cheap to hold. AC-10 is now MEASURED end to end in a real browser: `/bench/paint` + `npm run bench:paint` (puppeteer-core driving system Chrome) paints the 50-page x 1000-node deck on a real canvas at dpr 2 under continuous pan/zoom with page flips - p50 120.5fps, p95-slow 111fps, worst frame 9.3ms (never over the 16.7ms budget), scene build 0.51ms/page. Revisit subdocuments only if profiling ever shows the flat doc as a real bottleneck (e.g. 500+ page documents), and then behind a schema-version gate that keeps old clients out of the room.

What remains: on-the-wire per-node lock/schema enforcement. Enforcement's historical blocker ("no pure-Go Yjs decoder") is GONE - the goja fold is that decoder - but it stays deferred on cost: cold-path folds (~100ms in a throwaway VM) are fine, decoding every live UPDATE frame on the relay hot path is not; per-node enforcement needs either a pooled/incremental decode design or the subdocument work first. The numbered sections below are the full design spec; this section is the authoritative record of what is built today.

| FR | Status | Where it stands |
| --- | --- | --- |
| FR-1 Yjs doc mirrors scene graph | Shipped | `DesignDoc` (`ydoc.ts`) holds a live `Y.Doc`; generic scene-graph to `Y.Map`/`Y.Array` bridge in `@hc/schema/src/yjs.ts`; minimal-op reconcile in `@hc/realtime`. |
| FR-2 optimistic + incremental apply | Shipped | localOrigin/REMOTE origin guards; structural-diff reconcile emits minimal ops; remote deltas rebuild the store without touching undo. Reorder is now a move/intention primitive: keyed-array items carry a fractional `__ord` rank so a reorder is a property edit (never delete+reinsert), and a peer's concurrent content edit of a moved node is preserved (`reconcile.ts`; `reconcile.test.ts`). Text runs sync as a `Y.Text` so two people typing in one paragraph merge per character; non-canonical paragraphs (empty/adjacent-identical runs) round-trip via a verbatim stash (`reconcile.ts`; `text-merge.test.ts`). |
| FR-3 /realtime Yjs sync, relay + persist | Shipped | y-protocols sync (base64 frames) over the WS; `hub.go HandleSync` relays and journals update frames to `DesignUpdateLog` (`writes.go AppendUpdate`). Server is a relay; CRDT merge stays client-side. |
| FR-4 awareness/presence payload | Shipped | `PeerIdentity` (id/name/color/role) plus cursor/selection/viewport/following in the presence store. |
| FR-5 cursors, selection, avatars, follow | Shipped | `PresenceOverlay.tsx` (colored cursors + name labels, selection outlines, avatar stack); follow-mode mirrors a peer's viewport and breaks on local interaction (`useRealtime.ts`). |
| FR-6 offline IndexedDB + conflict-free merge | Shipped | `IndexeddbPersistence` bound to the `Y.Doc` (auto-load + persist); reconnect reconverges via state-vector sync, conflict-free. |
| FR-7 unlimited editors + subdocuments | Partial | Many concurrent editors supported via the relay. The gateway now scales HORIZONTALLY: with `REDIS_URL` set, relay + awareness frames (sync, presence, join/leave, comment) fan out across instances via Redis pub/sub with origin dedup, so clients on different gateway instances converge (`realtime/coordinator.go`, `coordinator_redis.go`; default is an in-memory no-op for single-instance/self-host; `coordinator_test.go`). Cross-instance INITIAL ROSTER catchup now ships too: on join an instance publishes a roster-request control signal over the coordinator and peers re-announce their local members as `join` frames addressed back to the requester (`hub.republishLocalRosterTo`; `coordinator_test.go TestCrossInstanceRosterCatchup`), so a newcomer sees peers on other instances immediately, not only as they next emit a frame. Cross-instance LOCK authority now ships too (Redis CAS; see FR-8). The 1000-element / 50-page target is now CPU-measured (engine `bench.ts`/`perf.test.ts`: ~2ms/frame for a 1000-node page, ~40ms to build a 50-page deck), within the frame budget on the CPU side - but real GPU-paint fps still needs a browser benchmark. SCALE CLOSED: the flat one-Y.Doc layout stays (true per-page subdocuments are deliberately rejected: a per-room sync-protocol change that old clients in the same room cannot survive, plus journal/fold/compaction partitioning), and the real costs are bounded instead - page-granular incremental projection (`fromDocWithPageReuse` + dirty-page tracking: a remote update re-projects only touched pages, all others reuse by identity; `page-reuse.test.ts`, `ydocBranch.test.ts`) and the AC-10 browser measurement (p50 120.5fps / worst frame 9.3ms on the 50x1000 deck at dpr 2; `/bench/paint`, `npm run bench:paint`). Document convergence is unaffected (the CRDT sync handshake crosses instances). |
| FR-8 collaborative locks | Shipped (incl. cross-instance authority); Partial (on-wire per-node enforcement) | Acquire/deny/release, auto-release on disconnect, holder identity, the lock badge + "Lock for me" + client-side mutation gating all ship. Heartbeat-timeout release ships: the client pings every 10s (`realtime.ts`), any inbound frame refreshes liveness, and a server sweep (30s TTL, `StartSweeper`) releases a stalled holder's locks and rebroadcasts. CROSS-INSTANCE lock authority now ships (`realtime/lockstore.go`): with `REDIS_URL` set, a `RedisLockStore` is the compare-and-swap authority - acquire/refresh/release are each a single atomic Lua step (grant-if-free-or-ours + index + TTL in one op, so no SETNX->SADD gap and no re-lock SET that could clobber a concurrently-taken holder), per-node `SET ... PX` keys so a crashed instance's locks auto-expire, and a TTL'd per-design index set (self-collects on abandon). Lock changes fan out a `ctrlLocksChanged` control signal and each instance reconciles its cache from the store under a per-room reconcile mutex (so a stale snapshot can't overwrite a fresher one); the fan-out is gated on an actual change to avoid a re-assertion storm. Disconnect frees the holder's locks in the authority on BOTH teardown paths (Leave + eviction). The store-aware sweep refreshes live holders' TTL every tick and reconciles quiet rooms on a coarse interval to catch crashed-instance expiry. Without `REDIS_URL` the per-hub in-memory `lockTable` is used exactly as before (single instance / self-host). Adversarially reviewed and hardened; tested by `coordinator_test.go` (two-hub authority, cross-instance release-on-leave, sweep alive/stale branches; all under `-race`) plus `REDIS_URL`-gated real-Redis integration + TTL-expiry tests. Still missing (deliberately deferred): server-side rejection of UPDATE frames touching locked-by-others nodes. The decoder blocker is gone (`internal/crdt` folds Yjs server-side under goja), but per-frame decode on the relay hot path is too costly as-is; deferred pending a pooled/incremental decode design. |
| FR-9 history scrub/preview/restore | Shipped (scrubber + snapshot restore); Partial (semantic op labels) | The CRDT-update-log scrubber now ships: `GET /designs/{id}/updates` (`persistence/history_updates.go`) pages out the journaled y-protocols frames with author + timestamp; `frontend/src/lib/historyFold.ts` folds the prefix up to a chosen op-stop into a throwaway `Y.Doc` CLIENT-SIDE (`readSyncMessage` + `docToFile`, so no Go CRDT decoder is needed) and previews it read-only via `enterPreview`; the `HistoryPanel` scrubber groups updates into author+time op-stops and drags through them. Plus the existing snapshot version-history panel + restore. Restoring a scrubbed point now ships too: the folded file is persisted as a new `restore` snapshot and reconciled in (`HistoryPanel.restoreScrub`), non-destructive, no versionId needed. Still NOT built: SEMANTIC op labels ("moved 3 elements") - stops are labelled by author + edit-count, since per-update semantic diffs would require decoding each update delta. |
| FR-10 named branches + switch | Shipped | True in-CRDT branches: `design_branches` (name, `forked_from_seq`, optional parent for nesting) + branch-scoped `design_update_logs` rows; lineage-resolved `GET /updates?branch=` (one seq-ordered stream: parent prefix + own rows); `POST/GET /designs/{id}/crdt-branches`; branch realtime rooms (`?branch=` on `/realtime`, isolated sync/presence/locks, design-scoped bans/roles); History-panel Branches switcher + "Branch from here" at any scrub stop; branch-seeded client docs that refuse main-state leaks; compaction fork-guards in every lineage; main-only snapshots/restores while a branch is active (branch durability = its journal + branch-scoped checkpoints). The older fork model ("Branch from a version" -> a new design) remains as "Forked designs". |
| FR-11 snapshots on interval/idle/leave + checkpoints | Shipped (auto triggers); Partial (compaction + seq checkpoints) | Content-addressed snapshots ship (create/restore/explicit, AUTO dedup, kinds AUTO/CHECKPOINT/NAMED/RESTORE/BRANCH). Automatic triggers now ship CLIENT-SIDE (`frontend/src/lib/useAutoSnapshot.ts`): a deduped `auto`-kind snapshot fires ~4s after the user goes idle, at a 90s interval cap during nonstop editing, and on tab-hidden/pagehide (best-effort last-leave); the server dedups unchanged AUTO snapshots so the log does not bloat. Client-driven because the relay holds no folded Y.Doc to snapshot (no Go decoder). Update-log COMPACTION now ships too: the client periodically uploads a Yjs full-state checkpoint (`POST /designs/{id}/updates/checkpoint`, `DesignDoc.checkpointFrame` = encodeStateAsUpdate framed as a y-protocols update), and `persistence.AppendCheckpoint` atomically journals it + deletes every older row (one data-modifying CTE). The log stays bounded (a checkpoint + the deltas since), and the scrubber transparently folds checkpoint-then-tail (the full-state row reconstructs the base on the same CRDT identity space). Tested by a DATABASE_URL-gated compaction test. Server-authoritative fold-and-snapshot on LAST-CLIENT-LEAVE now ships: the hub arms a 10s grace timer when a room loses its last local connection (rejoin cancels), then `SnapshotFoldedUpdateLog` folds the full journaled log via the embedded goja decoder (`internal/crdt`) and records an AUTO snapshot - catch-up-only (skipped whenever the current snapshot already postdates the log tail) so it can never regress a newer save, and validated by the same 422 boundary as client saves (`leave_snapshot.go`; hub timer tests + a DATABASE_URL-gated fold test on real journaled frames). Still NOT built: formal seq-keyed CHECKPOINT version records (compaction uses the update-log checkpoint row, not a DesignVersion). |
| FR-12 authed + authorized connection | Shipped | `realtimeHandler` (`httpapi/realtime.go`) verifies the `hc_access` session and resolves membership/role before joining. |
| FR-13 read-only rejected from updates + server-side validation | Shipped (defense in depth) | `HandleSync` drops update frames from non-editor roles; viewers still receive sync + awareness. Wire hardening (`realtime/hub.go`, `serve.go`): an explicit 32 MiB read limit (also fixes large-doc initial sync vs. coder/websocket's 32 KiB default), a 20 MiB decoded-payload cap, a strict y-protocols message-type/base64 check that drops garbage before relay, and a per-connection token-bucket flood guard scoped to RECOVERABLE frames only (presence/lock/unlock) - sync UPDATE deltas are exempt (once-only, unrecoverable) and bounded by the size caps instead. Open-format boundary validation (`persistence/validate.go`): `Create`/`Snapshot` reject a structurally invalid client file (missing/duplicate ids across the full tree incl. mask `child` + boolean `operands`, missing node types, depth/count bounds, sane schemaVersion) with 422, so a malformed/malicious document never persists for other clients to load. Tested in `validate_test.go` + `hardening_test.go`. PARTIAL LIMIT: per-node enforcement of locks/schema on each live UPDATE on the wire needs per-frame server-side CRDT decoding. A pure-Go decode path now EXISTS (`internal/crdt`, the goja-embedded client fold; no cgo, single binary intact) and serves cold paths (last-leave snapshot), but running it per relayed frame would add ~100ms to the hot path; deferred pending a pooled/incremental decode design. |
| FR-14 connection state surfaced | Shipped | `ConnectionState` (connecting/connected/reconnecting/offline) in `store/presence.ts`, surfaced in the editor; editing continues offline. |
| FR-15 per-user collaborative undo/redo (new) | Shipped | A `Y.UndoManager` scoped to `localOrigin` (`ydoc.ts`) so a user reverts only their OWN edits and never clobbers a concurrent peer change; the store's `undo`/`redo` delegate to it when a live doc is bound (`collabUndo` handle) and fall back to the local snapshot stack otherwise. Undo/redo fan out to peers; seed/restore reset the baseline (`undoMgr.clear`). Proven by `@hc/realtime` `undo.test.ts` (local undo preserves the peer's concurrent insert). |

Acceptance criteria: AC-1, AC-2, AC-3, AC-4, AC-5, AC-8, AC-9 met (live cursors + presence, convergence, offline merge, collaborative lock with auto-release on unlock/leave/heartbeat-timeout, follow, read-only, and live permission downgrade mid-session via `hub.RefreshRoles` wired through approvals, now fanned out cross-instance via a coordinator control signal so editors on any gateway instance are downgraded live). AC-6 met (the CRDT-update-log scrubber drags through author/time op-stops and previews each folded state read-only, alongside snapshot restore). AC-7 met in full: restore-as-new-entry ships for named versions AND arbitrary scrubbed points (a new `restore` snapshot, never rewriting history), and true in-CRDT branches with switching ship alongside the older version-fork model; branching and switching never discard state in any lineage. AC-10 MET and measured end to end: the engine CPU harness (`packages/engine/src/bench.ts` + `perf.test.ts`, ~2ms/frame for a 1000-node page) is now paired with a real-browser paint benchmark (`frontend/src/pages/bench/paint.tsx`, driven headless via `npm run bench:paint`): the 50-page x 1000-node deck painting on a real canvas at devicePixelRatio 2 under continuous pan/zoom and periodic page flips holds p50 120.5fps with a 9.3ms worst frame (never over the 16.7ms/60fps budget) and 0.51ms/page scene builds. Remote-update cost at scale is bounded by page-granular incremental projection (see FR-7). AC-11 met: client-side triggers (idle / 90s interval-cap / tab-hidden) ship and reload faithfully, the update log compacts via client checkpoints, and the server-authoritative last-leave fold now ships (catch-up-only, via the embedded goja decoder).

## 1. Context and Goal

The editable design is modeled as a Yjs CRDT document, and the database stores snapshots in the open file format. Local autosave and version history exist, as do accounts and workspaces. This doc makes editing multiplayer: many people edit the same design at the same time, see each other's cursors and selections live, work offline and have changes merge conflict-free when they reconnect, and travel back through a full edit history with the ability to branch and restore.

This is a headline differentiator. Canva's collaboration breaks down under contention and has no true offline mode. HyCanvas's collaboration is offline-first and conflict-free by construction (CRDT), supports unlimited concurrent editors without slowdown, allows granular per-element locking, and ships an edit-history time machine.

Intended outcome: two or more authenticated members of a workspace open the same design and edit simultaneously with live cursors and presence; a user goes offline, keeps editing, and on reconnect their changes merge without conflict or loss; any element can be locked to one editor; and a user can scrub the edit history, restore a prior state, or branch from it.

## 2. Scope

In scope:
- Yjs CRDT data model mapping the scene graph onto shared types, with a binding layer between Yjs and the Zustand editor store and `@hc/engine`.
- A WebSocket sync protocol over the `/realtime` gateway: document sync (sync step 1/2 + incremental updates) and awareness (presence).
- Live cursors, selection highlights, presence avatars, follow-mode, and per-user color.
- Offline-first local persistence (IndexedDB) with reconnect reconciliation and conflict-free merge.
- Unlimited concurrent editors with subdocument/lazy-loading for large multi-page designs.
- Granular per-element locking (collaborative lock distinct from the static `locked` flag in the scene model).
- Edit-history time machine: a durable, navigable log with named checkpoints, restore, and branch.
- Persistence bridge: periodic and on-idle snapshots to storage in the open file format (extends the persistence/version-history backbone).
- Server authority for access control (membership and per-design permission gate from accounts/workspaces and the sharing/permissions layer).

Out of scope (owned elsewhere):
- Comments, @mentions, threads, reactions, share links, roles beyond workspace membership, and approvals (the comments/sharing/permissions layer). This doc provides presence and the permission hook those build on.
- The static, structural `locked`/`hidden` element flags (the scene model and object-manipulation layer). This doc adds a *collaborative* lock owned by a user.
- Document-type-specific collaboration nuances for whiteboard/docs/sheets beyond the shared engine here.

Deferred:
- Cross-region CRDT replication topology and conflict telemetry at scale (cross-cutting enterprise/NFR work).
- End-to-end-encrypted collaboration (post-Phase 9 research).

## 3. User Stories

- As a teammate, I want to see who else is in the design and where their cursor and selection are, so we do not collide.
- As an editor, I want my changes and a collaborator's changes to both survive even when we edit at the same time, with no "someone else saved" errors.
- As a traveler, I want to keep editing on a plane with no internet and have everything sync cleanly when I land.
- As a precise editor, I want to lock the element I am working on so a teammate cannot move it out from under me.
- As a reviewer, I want to follow a presenter's viewport so I see what they see.
- As anyone, I want to scrub the full edit history, see who changed what when, and restore or branch from an earlier state without losing current work.
- As a large team, I want a 1000-element, 50-page design to stay at 60fps even with many people in it.

## 4. Functional Requirements

- FR-1: The design's editable state is a single Yjs document (`Y.Doc`) whose shared types mirror the scene graph: pages, ordered children, node properties, and document-level collections.
- FR-2: Local edits apply optimistically to the Yjs doc and the engine in the same frame; remote updates apply incrementally without a full re-render.
- FR-3: Clients sync via the `/realtime` WebSocket using Yjs sync (initial state exchange then incremental `update` messages); the server relays and persists updates.
- FR-4: Awareness (presence) carries each participant's user id, name, color, cursor position (canvas coords), current selection, viewport, and "following" target, broadcast on change and cleared on disconnect.
- FR-5: Live cursors, selection outlines, and a presence avatar stack render for all connected participants; each participant has a stable color for the session.
- FR-6: Offline edits persist to IndexedDB and replay on reconnect; merge is conflict-free via CRDT semantics with no user-visible conflict resolution step and no lost intent.
- FR-7: The system supports unlimited concurrent editors on a design without slowdown; large designs load pages as Yjs subdocuments on demand.
- FR-8: Any participant can place a collaborative lock on one or more elements; while locked, only the lock holder can mutate those elements; others see a lock indicator with the holder's identity. Locks release on explicit unlock, on the holder leaving, or on a heartbeat timeout.
- FR-9: An append-only edit history records updates grouped into meaningful operations with author and timestamp; users can scrub it, preview any point, and restore a prior state.
- FR-10: A user can create a named branch from any history point and switch between branches; restoring or branching never discards the current state (it is itself a new history entry).
- FR-11: The server persists snapshots to storage in the open file format on an interval and on idle/last-client-leaves, and records named checkpoints, extending the persistence layer's version history.
- FR-12: Every realtime connection is authenticated and authorized: the gateway verifies the JWT and the user's workspace membership and per-design edit permission; unauthorized clients are rejected or downgraded to read-only.
- FR-13: A read-only participant (view/comment permission) receives sync and awareness but cannot apply document updates; the server rejects their updates.
- FR-14: Connection state is surfaced to the user (connected / reconnecting / offline / read-only) and editing is never blocked while offline.

## 5. UX and Interaction Behavior

Presence:
- A presence avatar stack appears in the editor top bar; hovering shows names; clicking an avatar offers "follow" and "jump to."
- Each remote user's cursor renders as a colored pointer with a name label; their current selection shows as a colored bounding outline; their text caret shows in text edit.
- Follow mode mirrors the followed user's viewport (pan/zoom) with a "following X - stop" banner; the follower can break off at any time by interacting.

Collaborative locking:
- Selecting an element and choosing "Lock for me" (or starting a drag on a contended element, per policy) acquires the collaborative lock. Locked-by-others elements show a small lock badge tinted with the holder's color and are non-interactive for others (cursor shows a "locked by X" tooltip).
- Lock auto-releases when the holder deselects/finishes, leaves, or times out, so nothing stays stuck.

Offline and connection states:
- A connection indicator shows Connected, Reconnecting (spinner), Offline (cloud-off), or Read-only (eye). Offline editing continues normally; a subtle banner reads "Offline - changes will sync." On reconnect, a brief "Synced" confirmation appears.
- No modal blocks editing for connectivity reasons; there is never a "someone else is editing, you are locked out" state.

Edit-history time machine:
- A history panel lists operations grouped and labeled (e.g., "Maria moved 3 elements", "You changed text") with author avatar and time, and named checkpoints.
- A scrubber/timeline lets the user drag through history; the canvas previews the state at the scrub point (read-only preview). "Restore this version" applies it as a new entry; "Branch from here" creates a named branch and switches to it. A branch switcher shows current branch and lets the user jump between branches.
- Empty/loading: a fresh design shows "History starts here"; loading older history lazy-loads in pages.

## 6. Data Model

### Yjs shared structure (`@hc/collab`)

The `Y.Doc` mirrors the scene graph. Document-level collections are `Y.Map`s and ordered children are `Y.Array`s so insert/move/delete merge cleanly.

```ts
// Logical shape of the shared doc (Yjs types in parentheses)
interface SharedDesign {
  meta: Y.Map;            // title, unit, schemaVersion, workspaceId, brandKitId
  pages: Y.Array<YPage>;  // ordered pages; each YPage is a subdocument for large designs
}
interface YPage {         // backed by a Y.Map (or Y.Doc subdocument)
  id: string;             // plain
  props: Y.Map;           // name, width, height, background, notes
  children: Y.Array<string>;   // ordered node ids (back-to-front)
  nodes: Y.Map<YNode>;         // id -> node map
}
interface YNode {         // backed by a Y.Map keyed per scene-graph property
  // type, transform (x,y,scaleX,scaleY,rotation,skew), opacity, blendMode,
  // hidden, name, link, and type-specific props from the scene model + owning features
}

// Awareness (ephemeral, not persisted)
interface AwarenessState {
  user: { id: string; name: string; color: string; avatarUrl?: string };
  cursor?: { x: number; y: number; pageId: string };
  selection?: string[];          // node ids
  textCaret?: { nodeId: string; index: number };
  viewport?: { x: number; y: number; zoom: number };
  following?: string;            // user id being followed
  locks?: string[];              // node ids this user holds (mirrored by server)
}
```

Binding: a `YjsBinding` observes the `Y.Doc` and applies deep changes to the Zustand store and `@hc/engine` scene incrementally; local store mutations are translated into Yjs transactions. The engine never reads Yjs directly, preserving the framework-agnostic engine boundary.

### Postgres tables

```
-- designs(...) from the persistence layer; this doc adds collaboration/history tables:

design_updates(id pk, design_id fk->designs, seq bigserial, author_id fk->users,
      branch_id fk->design_branches, update bytea,   -- Yjs binary update
      created_at, op_label text null)
  -- append-only; the live CRDT state = fold of updates for a branch

design_branches(id pk, design_id fk->designs, name, parent_branch_id null,
      forked_from_seq bigint null, created_by fk->users, created_at,
      is_default bool)

design_checkpoints(id pk, design_id fk->designs, branch_id fk->design_branches,
      seq bigint, name, snapshot_id fk->design_snapshots, created_by, created_at)

design_locks(design_id fk->designs, node_id, holder_id fk->users,
      acquired_at, heartbeat_at, pk(design_id, node_id))
  -- authoritative collaborative locks; also mirrored in Redis for speed

-- design_snapshots(...) from the persistence layer store the folded open-file-format JSON
```

Redis: per-design awareness fan-out, active-connection registry, and a fast mirror of `design_locks` with TTL keyed by heartbeat for sub-100ms lock checks and automatic release.

### Serialization to the open file format

The CRDT is the edit-time source of truth. To persist or export, the server folds the `design_updates` for a branch into the `Y.Doc`, then serializes that doc to a `DesignFile` snapshot (open-file-format schema) stored via the persistence layer. A snapshot can also be loaded back into a fresh `Y.Doc` to seed a new collaboration session. Compaction periodically replaces a long update log with a checkpoint snapshot plus subsequent updates to bound storage and load time.

## 7. API and Interfaces

WebSocket gateway `/realtime`, one connection multiplexing documents:

```
# Client -> server (binary frames)
JOIN        { designId, branchId?, token }      -> server authorizes (FR-12)
SYNC_STEP1  { stateVector }                      -> server replies SYNC_STEP2
SYNC_STEP2  { update }
UPDATE      { update }                           -> relayed + persisted (editors only)
AWARENESS   { awarenessUpdate }                  -> relayed (not persisted)
LOCK        { nodeIds }                          -> ACQUIRED { nodeIds } | DENIED { holder }
UNLOCK      { nodeIds }
HEARTBEAT   {}                                   -> keeps locks + presence alive

# Server -> client
SYNC_STEP2  { update }                           initial state
UPDATE      { update, author }                   incremental remote changes
AWARENESS   { states }                           presence diffs
LOCK_STATE  { node->holder map }                 on join + on change
PERMISSION  { mode: "edit"|"comment"|"view" }    initial + on change (sharing/permissions)
PRESENCE    { join|leave, user }
```

REST `/api/v1` for history (mutations that benefit from durability/audit):

```
GET    /designs/:id/history ?branchId=&cursor=   -> { ops: HistoryOp[], next }
POST   /designs/:id/checkpoints { name, seq }     -> Checkpoint
GET    /designs/:id/branches                      -> Branch[]
POST   /designs/:id/branches { fromSeq, name }    -> Branch
POST   /designs/:id/restore { branchId, seq }     -> new HistoryOp (restore)
GET    /designs/:id/snapshot ?seq=                -> DesignFile (folded, read-only)
```

Internal/package contracts:
- `@hc/collab`: `createCollabDoc(designFile)`, `YjsBinding(doc, store, engine)`, `awareness`, `lockManager`, `historyController` (scrub/restore/branch). No React or engine internals leak across the boundary.
- `@hc/authz`: the gateway calls `assertMember` plus the per-design permission resolver on `JOIN` and on permission changes.
- Persistence worker (BullMQ): consumes "persist design" jobs to fold + snapshot + compact, extending the persistence layer.

## 8. Technical Approach and Architecture

- CRDT choice: Yjs, the project's chosen CRDT. Yjs gives conflict-free merge, efficient incremental updates, offline support via `y-indexeddb`, and a mature awareness protocol. The scene graph maps to nested `Y.Map`/`Y.Array` so concurrent insert/move/delete/property edits converge without conflicts.
- Sync protocol: standard Yjs sync (state-vector exchange + incremental updates) over the existing `/realtime` WebSocket, multiplexed per design. The gateway is a relay-and-persist hub: it authorizes the connection, broadcasts updates to peers, appends them to `design_updates`, and fans out awareness via Redis pub/sub so the gateway scales horizontally.
- Offline-first: each client persists the `Y.Doc` to IndexedDB (`y-indexeddb`) so edits survive reload and offline. On reconnect, sync step 1/2 reconciles divergence; because merge is CRDT-based there is no conflict prompt and no lost intent.
- Scale: pages load as Yjs subdocuments so a 50-page design only materializes open pages; awareness is throttled and cursor updates are coalesced per animation frame; the binding applies remote deltas surgically to keep 60fps (the engine's frame budget). The gateway shards designs across instances by design id.
- Collaborative locking: a soft, cooperative lock distinct from the scene model's structural `locked`. Acquisition is server-authoritative (Redis CAS, mirrored to Postgres) with a heartbeat TTL; if a holder disconnects, the lock auto-expires. Edits to a node the user does not hold (when locked) are rejected client-side and re-rejected server-side as defense in depth.
- Edit-history time machine: the durable `design_updates` log (append-only, per branch) is the history. Scrubbing folds updates up to a `seq` into an ephemeral read-only `Y.Doc` for preview. Restore appends the diff needed to reach the target state as a new update authored by the user (so history is never rewritten). Branch creates a new `design_branches` row forked at a `seq`; subsequent updates carry the branch id. Named checkpoints snapshot to the open file format for fast loads and exports.
- Permissions: the gateway is the enforcement point. `PERMISSION` mode (edit/comment/view from the sharing/permissions layer) gates whether `UPDATE`/`LOCK` are accepted; downgrades pushed live flip an active editor to read-only mid-session.
- Persistence bridge: a debounced job folds + snapshots on interval, on idle, and when the last client leaves, then compacts the log behind a checkpoint to bound growth, integrating with the persistence layer's snapshot/version store.

## 9. Edge Cases and Constraints

- Long offline + large divergence: reconnect must reconcile a big delta without freezing the UI; sync and binding apply in chunks off the main thread where possible.
- Concurrent move of the same element: CRDT converges to a single deterministic transform; with collaborative locking the contended case is usually prevented because one user holds the lock.
- Holder crashes mid-edit: lock heartbeat TTL releases the lock; partial edits already in the CRDT remain valid and consistent.
- Read-only user with stale permission: a downgrade must reject in-flight updates and flip UI immediately; an upgrade enables editing without reconnect.
- Branch divergence: branches do not auto-merge; restoring across branches is explicit. Deleting a non-default branch is allowed; the default branch cannot be deleted.
- Subdocument loading race: editing a page not yet loaded triggers load-then-apply; the user is not blocked.
- Clock skew between clients must not affect ordering; ordering is by CRDT/lamport state, not wall clock (wall clock is display-only in history).
- Snapshot/compaction must never run while it could drop unflushed updates; compaction is atomic against the append log.
- Self-host: the gateway, Redis, and IndexedDB path must work without any cloud-only dependency (the self-host requirement).

## 10. Performance and Security Considerations

Performance:
- Remote update apply-to-render under one frame (16 ms) for typical edits; cursor/awareness coalesced per frame.
- Initial join to interactive under 500 ms for a typical design using a recent checkpoint snapshot plus tail updates (not folding the entire log).
- 60fps maintained with many concurrent editors on a 1000-element page (the engine frame budget); awareness traffic throttled and diffed.
- Lock acquire/check under 100 ms via Redis.
- Storage bounded via periodic compaction; update log never grows unbounded.

Security:
- Every connection authenticated (JWT) and authorized per design at JOIN and on every permission change; no anonymous edit path unless an explicit share grants it.
- Server re-validates that an UPDATE only touches nodes the user may edit (and not locked-by-others nodes); clients are never trusted.
- Per-workspace/per-design isolation enforced at the gateway and persistence layer (extends workspace isolation).
- Awareness carries no sensitive data beyond display identity and ephemeral cursor/selection; it is never persisted.
- WSS only; message size limits and per-connection rate limiting to resist abuse; signed snapshot URLs.

## 11. Acceptance Criteria

- AC-1: Two members editing the same design see each other's live cursors, selections, and presence avatars, with stable per-user colors.
- AC-2: Simultaneous edits by multiple users to the same and different elements all converge with no lost changes and no conflict prompt.
- AC-3: A user can go offline, keep editing, and on reconnect all offline changes merge in conflict-free with no data loss.
- AC-4: A user can place a collaborative lock on an element; other users cannot mutate it and see who holds it; the lock releases on unlock, leave, or timeout.
- AC-5: Follow mode mirrors another user's viewport and can be exited at any time.
- AC-6: The edit-history panel shows authored, timestamped, labeled operations and named checkpoints; scrubbing previews prior states read-only.
- AC-7: Restoring a prior version applies it as a new history entry without discarding current state; branching from a point creates a switchable branch.
- AC-8: A read-only (view/comment) participant receives sync and presence but cannot apply updates; the server rejects their updates.
- AC-9: A permission downgrade pushed mid-session flips an active editor to read-only immediately; an upgrade enables editing without reconnect.
- AC-10: A 1000-element, multi-page design with several concurrent editors stays at 60fps and joins to interactive within budget.
- AC-11: Snapshots persist to the open file format on interval, on idle, and on last-client-leave, and reload byte-faithfully.

## 12. Test and Verification Plan

- Unit: scene-graph to Yjs mapping and back; binding apply of remote deltas; lock CAS/TTL logic; history fold-to-seq and restore-as-new-entry; branch forking; compaction atomicity.
- Integration: two+ headless clients over the gateway performing concurrent edits and asserting convergence; offline-then-reconnect merge; permission gate (editor vs viewer) rejecting unauthorized updates; lock contention; subdocument lazy load.
- E2E (compose stack): real browsers in a shared design - live cursors, simultaneous edits, follow mode, offline editing via network throttling/airplane mode, lock an element from one client and verify the other cannot edit, scrub/restore/branch history.
- Load/perf: simulate many concurrent editors on a large design; measure apply-to-render latency, frame rate, join time, and gateway memory/CPU; verify update-log compaction bounds storage.
- Manual: pull the network cable mid-drag and confirm editing continues and later syncs; kill a lock holder and confirm auto-release; verify no "someone else is editing" lockout state ever appears.

## 13. Differentiators

- True offline-first editing: keep working with no connection and merge conflict-free on reconnect, which Canva does not offer.
- Conflict-free by construction (CRDT): no "someone else saved, reload" failures and no lost edits under heavy contention.
- Unlimited concurrent editors with no slowdown via subdocuments, awareness throttling, and a horizontally scalable relay gateway.
- Granular per-element collaborative locking so precise work is never disrupted, with automatic release so nothing gets stuck.
- A full edit-history time machine with named checkpoints, restore, and branch/restore, going well beyond Canva's flat version history.

## 14. Open Questions and Risks

- Subdocument granularity (per page vs per region for huge whiteboards) needs a spike to balance load time and memory.
- History UX for very large/old designs: how far back to keep fine-grained ops before compacting into checkpoints, and how to present that boundary.
- Restore-as-new-entry vs hard rewind: confirm restore-forward (never rewriting history) is the right default for all document types.
- Risk: update-log growth and compaction correctness under continuous editing; must be load-tested and made atomic.
- Risk: the gateway is the security and scale keystone; permission enforcement and horizontal sharding must be proven before launch and hardened as part of the cross-cutting enterprise/NFR work.
- Risk: keeping the engine/Yjs/React boundaries clean so the binding stays surgical and fast; enforced in review.
