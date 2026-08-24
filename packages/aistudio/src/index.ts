// @hc/aistudio: F39 AI Creative Studio core. Framework-agnostic, pure functions.
// The model returns a validated AiDesignSpec (content + roles + layout intent);
// layoutDesign turns it into a positioned page; qualityCheck verifies the result.
// No React, no network, no DOM - safe in browser, worker, and on the server.

export * from "./spec";
export * from "./layout";
export * from "./quality";
export * from "./outline";
export * from "./promptRules";
export * from "./theme";
export * from "./deck";
export * from "./prompts";
export * from "./assistant";
export * from "./transform";
