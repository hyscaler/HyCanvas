// @hc/authz: framework-agnostic authorization + identity core for HyCanvas.
// Pure logic only: workspace roles + per-workspace isolation, identity linking
// by verified email, refresh-token rotation/reuse detection, invitation
// validation, workspace lifecycle invariants, and universal-search ranking.
// The Go backend's auth module and Postgres persistence build on this core;
// OIDC SSO and MFA ship, while SAML/SCIM/WebAuthn/LTI remain on the roadmap.

export * from "./types";
export * from "./roles";
export * from "./access";
export * from "./identity";
export * from "./session";
export * from "./invitation";
export * from "./workspace";
export * from "./search";
export * from "./totp";
