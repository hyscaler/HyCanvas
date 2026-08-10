// @hc/procgraph: the procedural graph evaluation core (F40 Phase 1).
//
// Pure and framework-agnostic by requirement, not by preference: FR-12 says the
// same code must run in the browser, in a worker, and headless on the server,
// so there is no React, no DOM, and no browser-only API here, and the package
// has no runtime dependencies at all.
//
// FR-13 goes further and asks for the same RESULT in all three, which is what
// canonical.ts (one serialization, one hash) and prng.ts (position-independent
// seeded streams) exist to make possible. Anything added here has to keep that
// promise; see the note at the top of catalog.ts for what the op interface
// deliberately withholds.

export * from "./types";
export * from "./canonical";
export * from "./prng";
export * from "./graph";
export * from "./catalog";
export * from "./cache";
export * from "./evaluate";
