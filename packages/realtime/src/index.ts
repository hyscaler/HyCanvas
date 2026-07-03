// @hc/realtime - the pure, socket-free CRDT core for realtime collaboration.
// It reconciles the editor's plain-JS DesignFile into a live
// Y.Doc with minimal, conflict-free ops (so concurrent and offline edits merge
// with no lost intent), and provides the server-side room helpers (seed an
// empty room from a snapshot, project back for the last-client snapshot, and the
// viewer read-only gate). The client transport binding and the Go `/realtime` gateway
// compose this core; it has no React, DOM, or socket dependency, so it is unit
// tested without a live connection.

export * from "./reconcile";
export * from "./seed";
export * from "./enforce";
export * from "./historydiff";
