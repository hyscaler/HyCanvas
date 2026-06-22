// @hc/audio - pure, framework-agnostic audio mixing math and the ducking
// automation solver for the HyCanvas video editor. No real DSP,
// decoding, or I/O: this package computes gains, fade envelopes, mute/solo
// audibility, and a deterministic sidechain-ducking curve from integer-frame
// timeline data. Used by the editor mixer UI and the headless export audio path.

export * from "./fade";
export * from "./mix";
export * from "./ducking";
