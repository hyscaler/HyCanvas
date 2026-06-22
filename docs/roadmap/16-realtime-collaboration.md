# F16: Realtime Collaboration

| Field | Value |
| --- | --- |
| Feature ID | F16 |
| Phase | 3 Collaboration |
| Sequence | 16 |
| Status | In progress |

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

## 13. Better than Canva

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
