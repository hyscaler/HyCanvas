import { describe, expect, it } from "vitest";
import { currentRelease, makeRelease, nextVersion, releaseById } from "../release";
import type { SiteRelease } from "../types";
import { sampleSite } from "./fixtures";

const releases: SiteRelease[] = [
  { id: "r1", siteId: "s", version: 1 },
  { id: "r2", siteId: "s", version: 2 },
  { id: "r3", siteId: "s", version: 3 },
];

describe("nextVersion", () => {
  it("returns 1 for no releases", () => {
    expect(nextVersion([])).toBe(1);
  });
  it("returns max+1", () => {
    expect(nextVersion(releases)).toBe(4);
  });
});

describe("currentRelease", () => {
  it("resolves by currentReleaseId when set", () => {
    const site = { ...sampleSite(), currentReleaseId: "r2" };
    expect(currentRelease(site, releases)?.id).toBe("r2");
  });
  it("falls back to the highest version when unset", () => {
    const site = { ...sampleSite(), currentReleaseId: undefined };
    expect(currentRelease(site, releases)?.id).toBe("r3");
  });
  it("returns null when there are no releases", () => {
    expect(currentRelease(sampleSite(), [])).toBeNull();
  });
});

describe("makeRelease", () => {
  it("builds a release at the next version", () => {
    const site = { ...sampleSite(), id: "site1" };
    const rel = makeRelease(site, releases, { id: "r4", publishedBy: "u1" });
    expect(rel.version).toBe(4);
    expect(rel.siteId).toBe("site1");
    expect(rel.publishedBy).toBe("u1");
  });
});

describe("releaseById", () => {
  it("finds by id or returns null", () => {
    expect(releaseById(releases, "r2")?.version).toBe(2);
    expect(releaseById(releases, "nope")).toBeNull();
  });
});
