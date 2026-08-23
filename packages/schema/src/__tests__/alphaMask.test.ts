// Non-destructive background removal: ImageNode.alphaMask (schema v20).
//
// Removal used to overwrite `source` with the flattened cutout, so the original
// pixels left the document. Keeping the original and storing the alpha beside
// it makes the cutout a view rather than a replacement, which is what lets it
// be undone and later refined by hand.

import { describe, expect, it } from "vitest";
import { currentSchemaVersion, ImageNodeSchema } from "../schema";
import { migrate } from "../migrate";
import { validate } from "../validate";
import { createBlankDesign } from "../factory";

const image = (extra: Record<string, unknown> = {}) => ({
  id: "img", type: "image",
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  size: { width: 100, height: 80 }, opacity: 1, blendMode: "normal",
  source: { assetId: "a1", naturalWidth: 100, naturalHeight: 80 }, fit: "cover",
  ...extra,
});

describe("the field is additive", () => {
  it("accepts an image with no mask, exactly as before", () => {
    expect(ImageNodeSchema.safeParse(image()).success).toBe(true);
  });

  it("accepts a mask referencing an asset", () => {
    const r = ImageNodeSchema.safeParse(image({ alphaMask: { assetId: "m1", width: 100, height: 80 } }));
    expect(r.success).toBe(true);
  });

  it("refuses inline pixel data in place of an asset id", () => {
    // Deliberate: a data URL here would land in the CRDT, every snapshot, and
    // IndexedDB, and be re-sent to every collaborator. The type is an id so
    // that mistake cannot be made quietly.
    const r = ImageNodeSchema.safeParse(image({ alphaMask: { assetId: 123, width: 100, height: 80 } }));
    expect(r.success).toBe(false);
  });
});

describe("migration to v20", () => {
  it("is a pure no-op on a v19 document", () => {
    const before = { ...createBlankDesign(), schemaVersion: 19 } as Record<string, unknown>;
    const after = migrate(structuredClone(before) as never, 20) as unknown as Record<string, unknown>;
    // Only the version moves. An image with no mask must render identically,
    // and absence of a mask means fully opaque.
    expect(after.schemaVersion).toBe(20);
    expect({ ...after, schemaVersion: 19 }).toEqual(before);
  });

  it("is idempotent", () => {
    const once = migrate({ ...createBlankDesign(), schemaVersion: 19 } as never, 20);
    const twice = migrate(structuredClone(once) as never, 20);
    expect(twice).toEqual(once);
  });

  it("leaves a mask that is already present untouched", () => {
    const d = createBlankDesign() as unknown as { schemaVersion: number; pages: { children: unknown[] }[] };
    d.schemaVersion = 19;
    d.pages[0].children = [image({ alphaMask: { assetId: "m1", width: 10, height: 10 } })];
    const out = migrate(d as never, 20) as unknown as { pages: { children: { alphaMask?: unknown }[] }[] };
    expect(out.pages[0].children[0].alphaMask).toEqual({ assetId: "m1", width: 10, height: 10 });
  });
});

describe("the version bump is coherent", () => {
  it("declares v20 and validates a document at that version", () => {
    expect(currentSchemaVersion).toBe(20);
    const d = createBlankDesign() as unknown as { pages: { children: unknown[] }[] };
    d.pages[0].children = [image({ alphaMask: { assetId: "m1", width: 100, height: 80 } })];
    expect(validate(d).ok).toBe(true);
  });
});
