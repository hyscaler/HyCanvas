import { describe, expect, it } from "vitest";
import { aiCapabilityGaps, newAiGaps } from "./aiCapabilityGaps";

const all = { text: true, image: true, describeImage: true, editImage: true };
const textOnly = { text: true, image: false, describeImage: false, editImage: false };
const seesButCannotDraw = { text: true, image: false, describeImage: true, editImage: false };

describe("aiCapabilityGaps", () => {
  it("reports nothing for a provider that can do everything", () => {
    expect(aiCapabilityGaps(all, undefined)).toEqual([]);
  });

  it("reports every image feature for a text-only provider with no image provider", () => {
    expect(aiCapabilityGaps(textOnly, undefined)).toEqual(["image", "editImage", "describeImage"]);
  });

  it("lets a dedicated image provider fill generation, editing and reading", () => {
    expect(aiCapabilityGaps(textOnly, all)).toEqual([]);
  });

  it("keeps reading on the main provider when it can see", () => {
    // The image provider cannot read images, but the main one can: no gap.
    expect(aiCapabilityGaps(seesButCannotDraw, { ...all, describeImage: false })).toEqual([]);
  });

  it("routes generation to the image provider even when the main one could draw", () => {
    // The server sends image calls to the dedicated provider when one is set,
    // so ITS limits are the ones that apply.
    expect(aiCapabilityGaps(all, { ...all, editImage: false })).toEqual(["editImage"]);
  });

  it("treats an unknown provider as capable, like the server", () => {
    expect(aiCapabilityGaps(undefined, undefined)).toEqual([]);
  });
});

describe("newAiGaps", () => {
  it("reports every gap on a first save", () => {
    expect(newAiGaps(["image"], null)).toEqual(["image"]);
  });

  it("reports only gaps the save introduces", () => {
    expect(newAiGaps(["image", "editImage"], ["image"])).toEqual(["editImage"]);
    expect(newAiGaps(["image"], ["image"])).toEqual([]);
  });
});
