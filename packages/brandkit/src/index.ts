// @hc/brandkit: framework-agnostic brand-governance core for HyCanvas.
// A pure brand linter that runs unchanged in the editor (live + on
// demand) and on the server (the pre-export/publish gate), plus the violation
// and applyable-fix model. No IO, no React, no Nest. The brand KIT storage,
// versioning, pin/track, and locked-region template wiring live in the backend +
// app; this package owns only the rules.

export * from "./types";
export * from "./lint";
export * from "./gate";
