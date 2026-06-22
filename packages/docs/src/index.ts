// @hc/docs - pure, framework-agnostic core for the F31 Docs feature.
//
// A "doc" is a DesignFile whose `meta.kind === "doc"`, whose content is an
// ordered list of typed content blocks (defined here, NOT scene-graph nodes).
// This package provides the block model and constructors, GitHub-flavored
// markdown round-trip, doc<->design conversion (heading-driven page split), and
// a block-level diff with inline word diff. No React/UI/transport deps.

export * from "./model";
export * from "./markdown";
export * from "./convert";
export * from "./diff";
export * from "./stats";
