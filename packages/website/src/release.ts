// Immutable-release / rollback helpers (FR-13). Pure, storage-free: the actual
// bundle upload and `current_release_id` repoint live in the backend; these
// compute version numbers and resolve which release is current.

import type { Site, SiteRelease } from "./types";

/** The next monotonic version number given the existing releases (1-based). */
export function nextVersion(releases: SiteRelease[]): number {
  let max = 0;
  for (const r of releases) {
    if (r.version > max) max = r.version;
  }
  return max + 1;
}

/** The site's current live release, resolved from `currentReleaseId`. Falls back
 *  to the highest-version release when the pointer is unset, and to null when
 *  there are no releases at all. */
export function currentRelease(site: Site, releases: SiteRelease[]): SiteRelease | null {
  if (site.currentReleaseId) {
    const byId = releases.find((r) => r.id === site.currentReleaseId);
    if (byId) return byId;
  }
  if (releases.length === 0) return null;
  return releases.reduce((a, b) => (b.version > a.version ? b : a));
}

/** Build a release record for a new publish (does not persist). */
export function makeRelease(
  site: Site,
  releases: SiteRelease[],
  fields: { id: string; bundleKey?: string; publishedBy?: string; publishedAt?: string },
): SiteRelease {
  return {
    id: fields.id,
    siteId: site.id ?? "",
    version: nextVersion(releases),
    bundleKey: fields.bundleKey,
    publishedBy: fields.publishedBy,
    publishedAt: fields.publishedAt,
  };
}

/** Resolve the release to roll back to, by id. Returns null when not found. */
export function releaseById(releases: SiteRelease[], releaseId: string): SiteRelease | null {
  return releases.find((r) => r.id === releaseId) ?? null;
}
