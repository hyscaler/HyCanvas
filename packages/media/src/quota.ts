// Storage quota accounting. Pure math over a workspace's
// StorageUsage: applying uploads, deletes, and version replacements keeps the
// total and the per-kind breakdown consistent, and an over-quota upload is
// blocked without ever harming stored content.

import type { AssetKind, StorageUsage } from "./types";

function clampNonNeg(n: number): number {
  return n < 0 ? 0 : n;
}

function adjust(usage: StorageUsage, kind: AssetKind, delta: number): StorageUsage {
  const byKind = { ...usage.byKind };
  byKind[kind] = clampNonNeg((byKind[kind] ?? 0) + delta);
  return {
    quotaBytes: usage.quotaBytes,
    usedBytes: clampNonNeg(usage.usedBytes + delta),
    byKind,
  };
}

/** Whether `byteSize` more bytes fits within quota (FR-11). quota <= 0 = unlimited. */
export function canUpload(usage: StorageUsage, byteSize: number): boolean {
  if (usage.quotaBytes <= 0) return true;
  return usage.usedBytes + byteSize <= usage.quotaBytes;
}

/** Remaining free bytes (Infinity when unlimited). */
export function remainingBytes(usage: StorageUsage): number {
  return usage.quotaBytes <= 0 ? Infinity : clampNonNeg(usage.quotaBytes - usage.usedBytes);
}

/** Account for a new upload (caller checks {@link canUpload} first). */
export function applyUpload(usage: StorageUsage, kind: AssetKind, byteSize: number): StorageUsage {
  return adjust(usage, kind, byteSize);
}

/** Account for hard-deleting an asset (Trash soft-delete does not free quota). */
export function applyHardDelete(usage: StorageUsage, kind: AssetKind, byteSize: number): StorageUsage {
  return adjust(usage, kind, -byteSize);
}

/**
 * Account for replacing an asset in place (FR-17): all versions are retained,
 * so the new version's bytes are added on top of the old.
 */
export function applyVersionAdd(usage: StorageUsage, kind: AssetKind, newByteSize: number): StorageUsage {
  return adjust(usage, kind, newByteSize);
}
