import { describe, it, expect } from "vitest";
import {
  acceptUpload,
  applyHardDelete,
  applyUpload,
  applyVersionAdd,
  averageHash,
  buildFolderTree,
  canMoveFolder,
  canTransition,
  canUpload,
  classifyDuplicate,
  createFidelityReport,
  descendantIds,
  fidelityStatus,
  folderDeleteCascade,
  folderPath,
  hammingDistance,
  isNearDuplicate,
  isPrivateIp,
  isUsable,
  matchAsset,
  mergeFidelity,
  recordFontSubstitution,
  remainingBytes,
  searchAssets,
  sniffType,
  transition,
  validateImportUrl,
  type Asset,
  type Bitmap,
  type Folder,
  type StorageUsage,
} from "../index";

// --- sniff -----------------------------------------------------------------

describe("type sniffing (FR-3)", () => {
  it("recognizes formats by magic bytes, not extension", () => {
    expect(sniffType([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).toEqual({ mime: "image/png", kind: "image" });
    expect(sniffType([0xff, 0xd8, 0xff, 0xe0])).toEqual({ mime: "image/jpeg", kind: "image" });
    expect(sniffType([0x25, 0x50, 0x44, 0x46, 0x2d])).toEqual({ mime: "application/pdf", kind: "document" });
    expect(sniffType([0x50, 0x4b, 0x03, 0x04])).toEqual({ mime: "application/zip", kind: "document" });
  });

  it("recognizes RIFF/WEBP and ISO-BMFF brands", () => {
    const webp = [...Array.from("RIFF").map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from("WEBP").map((c) => c.charCodeAt(0))];
    expect(sniffType(webp)?.mime).toBe("image/webp");
    const avif = [0, 0, 0, 0, ...Array.from("ftypavif").map((c) => c.charCodeAt(0))];
    expect(sniffType(avif)).toEqual({ mime: "image/avif", kind: "image" });
  });

  it("detects SVG text and rejects unknown bytes", () => {
    const svg = Array.from('<?xml version="1.0"?><svg></svg>').map((c) => c.charCodeAt(0));
    expect(sniffType(svg)).toEqual({ mime: "image/svg+xml", kind: "vector" });
    expect(sniffType([0x00, 0x01, 0x02, 0x03, 0x99])).toBeNull();
    expect(acceptUpload([0x00, 0x99]).ok).toBe(false);
  });
});

// --- perceptual hash + dedupe ----------------------------------------------

function solidBitmap(w: number, h: number, v: number): Bitmap {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function halfBitmap(w: number, h: number): Bitmap {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = x < w / 2 ? 0 : 255;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe("perceptual hashing (FR-7, AC-3)", () => {
  it("produces a 16-hex-char hash and zero distance to itself", () => {
    const h = averageHash(halfBitmap(32, 32));
    expect(h).toHaveLength(16);
    expect(hammingDistance(h, h)).toBe(0);
  });

  it("a resized version of the same image is a near-duplicate", () => {
    const a = averageHash(halfBitmap(64, 64));
    const b = averageHash(halfBitmap(32, 32));
    expect(isNearDuplicate(a, b)).toBe(true);
  });

  it("a clearly different image is not a near-duplicate", () => {
    const a = averageHash(halfBitmap(32, 32));
    const b = averageHash(solidBitmap(32, 32, 0));
    expect(isNearDuplicate(a, b)).toBe(false);
  });
});

function asset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    workspaceId: "w",
    ownerId: "u",
    kind: "image",
    status: "ready",
    name: id,
    mimeType: "image/png",
    byteSize: 1000,
    storageKey: `k/${id}`,
    checksum: `sum-${id}`,
    tags: [],
    favorite: false,
    meta: {},
    currentVersionId: `v-${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("duplicate classification (FR-7, AC-3)", () => {
  const lib = [
    asset("a", { checksum: "abc", perceptualHash: "ffffffffffffffff" }),
    asset("b", { checksum: "xyz", perceptualHash: "0000000000000000" }),
  ];

  it("flags an exact checksum match", () => {
    const r = classifyDuplicate({ checksum: "abc" }, lib);
    expect(r.kind).toBe("exact");
    expect(r.match?.id).toBe("a");
    expect(r.actions).toContain("use-existing");
  });

  it("flags a near perceptual match and offers replace", () => {
    const r = classifyDuplicate({ checksum: "new", perceptualHash: "fffffffffffffffe" }, lib);
    expect(r.kind).toBe("near");
    expect(r.match?.id).toBe("a");
    expect(r.actions).toContain("replace-version");
  });

  it("returns none when nothing matches and ignores trashed", () => {
    const trashed = [asset("a", { checksum: "abc", status: "trashed" })];
    expect(classifyDuplicate({ checksum: "abc" }, trashed).kind).toBe("none");
  });
});

// --- quota -----------------------------------------------------------------

describe("quota accounting (FR-11, AC-10)", () => {
  const base: StorageUsage = { usedBytes: 0, quotaBytes: 1000, byKind: {} };

  it("tracks used bytes and per-kind breakdown across upload/version/delete", () => {
    let u = applyUpload(base, "image", 300);
    u = applyUpload(u, "video", 200);
    u = applyVersionAdd(u, "image", 100);
    expect(u.usedBytes).toBe(600);
    expect(u.byKind.image).toBe(400);
    expect(u.byKind.video).toBe(200);
    u = applyHardDelete(u, "image", 400);
    expect(u.usedBytes).toBe(200);
    expect(u.byKind.image).toBe(0);
  });

  it("blocks an over-quota upload without harming usage; unlimited when quota<=0", () => {
    const near: StorageUsage = { usedBytes: 950, quotaBytes: 1000, byKind: { image: 950 } };
    expect(canUpload(near, 100)).toBe(false);
    expect(canUpload(near, 50)).toBe(true);
    expect(remainingBytes(near)).toBe(50);
    expect(canUpload({ usedBytes: 9e9, quotaBytes: 0, byKind: {} }, 1e9)).toBe(true);
  });
});

// --- status ----------------------------------------------------------------

describe("asset status machine (FR-4, FR-16)", () => {
  it("permits the ingest path and trash/restore, rejects illegal jumps", () => {
    expect(canTransition("queued", "uploading")).toBe(true);
    expect(canTransition("scanning", "processing")).toBe(true);
    expect(canTransition("ready", "trashed")).toBe(true);
    expect(canTransition("trashed", "ready")).toBe(true);
    expect(canTransition("queued", "ready")).toBe(false);
    expect(() => transition("queued", "ready")).toThrow(/illegal/);
  });

  it("only ready assets are usable", () => {
    expect(isUsable("ready")).toBe(true);
    expect(isUsable("processing")).toBe(false);
  });
});

// --- folders ---------------------------------------------------------------

describe("folder tree ops (FR-8)", () => {
  const folders: Folder[] = [
    { id: "root", workspaceId: "w", parentId: null, name: "Root", createdAt: "t" },
    { id: "a", workspaceId: "w", parentId: "root", name: "A", createdAt: "t" },
    { id: "b", workspaceId: "w", parentId: "a", name: "B", createdAt: "t" },
    { id: "c", workspaceId: "w", parentId: "root", name: "C", createdAt: "t" },
  ];

  it("builds a tree, path, and descendants", () => {
    const tree = buildFolderTree(folders);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((n) => n.id).sort()).toEqual(["a", "c"]);
    expect(folderPath(folders, "b").map((f) => f.id)).toEqual(["root", "a", "b"]);
    expect(descendantIds(folders, "a").sort()).toEqual(["a", "b"]);
  });

  it("prevents moving a folder into itself or a descendant (cycle)", () => {
    expect(canMoveFolder(folders, "a", "b")).toBe(false);
    expect(canMoveFolder(folders, "a", "a")).toBe(false);
    expect(canMoveFolder(folders, "a", "c")).toBe(true);
    expect(canMoveFolder(folders, "a", null)).toBe(true);
  });

  it("computes the delete cascade of folders and contained assets", () => {
    const assets = [asset("x", { folderId: "b" }), asset("y", { folderId: "c" })];
    const cascade = folderDeleteCascade(folders, "a", assets);
    expect(cascade.folderIds.sort()).toEqual(["a", "b"]);
    expect(cascade.assetIds).toEqual(["x"]);
  });
});

// --- fidelity --------------------------------------------------------------

describe("fidelity report (FR-15, AC-5)", () => {
  it("dedupes substitutions and resolves succeeded vs partial", () => {
    const clean = createFidelityReport(3);
    expect(fidelityStatus(clean)).toBe("succeeded");
    const r = createFidelityReport(2);
    recordFontSubstitution(r, "Helvetica", 1);
    recordFontSubstitution(r, "Helvetica", 2);
    expect(r.fontsSubstituted).toEqual(["Helvetica"]);
    expect(r.warnings).toHaveLength(2);
    expect(fidelityStatus(r)).toBe("partial");
  });

  it("merges per-page reports", () => {
    const acc = createFidelityReport(0);
    const p = createFidelityReport(1);
    recordFontSubstitution(p, "Arial");
    mergeFidelity(acc, p);
    expect(acc.pages).toBe(1);
    expect(acc.fontsSubstituted).toEqual(["Arial"]);
  });
});

// --- SSRF ------------------------------------------------------------------

describe("SSRF URL validation (FR-12, AC-7)", () => {
  it("identifies private/reserved IPs", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("169.254.0.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("blocks loopback, private IPs, and bad schemes; allows public https", () => {
    expect(validateImportUrl("http://localhost/x").ok).toBe(false);
    expect(validateImportUrl("http://127.0.0.1/x").ok).toBe(false);
    expect(validateImportUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateImportUrl("https://example.com/a.png").ok).toBe(true);
  });

  it("enforces an optional host allowlist (incl. subdomains)", () => {
    const opts = { allowlist: ["cdn.example.com"] };
    expect(validateImportUrl("https://cdn.example.com/a.png", opts).ok).toBe(true);
    expect(validateImportUrl("https://img.cdn.example.com/a.png", opts).ok).toBe(true);
    expect(validateImportUrl("https://evil.com/a.png", opts).ok).toBe(false);
  });
});

// --- search ----------------------------------------------------------------

describe("asset search (FR-9, AC-4)", () => {
  const assets: Asset[] = [
    asset("red-shoe", { name: "Red Shoe", tags: [{ value: "shoe", source: "ai" }], meta: { width: 800, height: 600, dominantColors: ["#cc1111"] }, favorite: true, createdAt: "2026-02-01T00:00:00Z" }),
    asset("blue-bag", { name: "Blue Bag", tags: [{ value: "bag", source: "user" }], meta: { width: 400, height: 800, dominantColors: ["#1122cc"] }, createdAt: "2026-03-01T00:00:00Z" }),
    asset("gone", { status: "trashed", name: "Old" }),
    asset("pending", { status: "processing", name: "Processing" }),
  ];

  it("filters by text, tag, favorite, color, and orientation", () => {
    expect(searchAssets(assets, { text: "shoe" }).map((a) => a.id)).toEqual(["red-shoe"]);
    expect(searchAssets(assets, { favorite: true }).map((a) => a.id)).toEqual(["red-shoe"]);
    expect(searchAssets(assets, { color: "#cc0000" }).map((a) => a.id)).toEqual(["red-shoe"]);
    expect(searchAssets(assets, { orientation: "portrait" }).map((a) => a.id)).toEqual(["blue-bag"]);
  });

  it("excludes trashed and non-ready assets by default", () => {
    const ids = searchAssets(assets, {}).map((a) => a.id);
    expect(ids).toContain("red-shoe");
    expect(ids).not.toContain("gone");
    expect(ids).not.toContain("pending");
  });

  it("sorts by recent (newest first) and by name", () => {
    expect(searchAssets(assets, { sort: "recent" }).map((a) => a.id)).toEqual(["blue-bag", "red-shoe"]);
    expect(searchAssets(assets, { sort: "name" }).map((a) => a.id)).toEqual(["blue-bag", "red-shoe"]);
  });

  it("matchAsset gates a single asset", () => {
    expect(matchAsset(assets[0], { text: "red" })).toBe(true);
    expect(matchAsset(assets[0], { kind: "video" })).toBe(false);
  });
});
