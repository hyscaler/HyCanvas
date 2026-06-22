// Asset status state machine. An asset is unusable until
// it passes scanning/processing; Trash is a reversible terminal-ish state. This
// captures the legal transitions so the backend and UI agree.

import type { AssetStatus } from "./types";

const TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  queued: ["uploading", "failed"],
  uploading: ["scanning", "failed"],
  scanning: ["processing", "failed"], // failed scan = quarantined
  processing: ["ready", "failed"],
  ready: ["trashed"],
  failed: ["queued"], // retry
  trashed: ["ready"], // restore
};

export function canTransition(from: AssetStatus, to: AssetStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Apply a transition, throwing on an illegal one. */
export function transition(from: AssetStatus, to: AssetStatus): AssetStatus {
  if (!canTransition(from, to)) {
    throw new Error(`illegal asset status transition: ${from} -> ${to}`);
  }
  return to;
}

/** Only `ready` assets are placeable/shareable/searchable (FR-4, FR-16). */
export function isUsable(status: AssetStatus): boolean {
  return status === "ready";
}

/** Whether an asset is still being ingested (UI shows a spinner). */
export function isProcessing(status: AssetStatus): boolean {
  return status === "queued" || status === "uploading" || status === "scanning" || status === "processing";
}
