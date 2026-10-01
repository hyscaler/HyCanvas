// The pure side of chat image attachments: which files count, what an image
// contributes as grounding, how the planner is told, and which one a step
// names. Reading pixels needs a browser canvas and is not covered here.
import { describe, expect, it } from "vitest";
import { imageAttachmentsNote, imageSource, isImageFile, nameFromUrl, paletteOf, pickAttachedImage, referencePalette, type AiImageAttachment } from "./aiImageAttachments";

const img = (over: Partial<AiImageAttachment>): AiImageAttachment => ({
  id: "a", name: "photo.jpg", url: "blob:x", width: 1200, height: 800, preview: "data:,", palette: ["#112233", "#445566"], ...over,
});

describe("isImageFile", () => {
  it("takes images by type or by extension and leaves documents alone", () => {
    expect(isImageFile({ name: "shot.PNG" })).toBe(true);
    expect(isImageFile({ name: "camera", type: "image/heic" })).toBe(true);
    expect(isImageFile({ name: "brief.pdf", type: "application/pdf" })).toBe(false);
    expect(isImageFile({ name: "notes.md" })).toBe(false);
  });
});

describe("nameFromUrl", () => {
  it("names a picture after the last path segment, or image for a blob", () => {
    expect(nameFromUrl("https://h.test/api/v1/uploads/ws/kiosk%20front.png?x=1")).toBe("kiosk front.png");
    expect(nameFromUrl("/api/v1/stock/proxy/abc")).toBe("abc");
    expect(nameFromUrl("blob:http://localhost/1234")).toBe("image");
  });
});

describe("imageSource", () => {
  it("grounds nothing until the provider has read the image", () => {
    expect(imageSource(img({}))).toBeNull();
  });
  it("carries what the image shows, its size and its colours", () => {
    const s = imageSource(img({ description: "A kiosk in a village square." }))!;
    expect(s.name).toBe("Image: photo.jpg");
    expect(s.text).toContain("1200 by 800");
    expect(s.text).toContain("#112233, #445566");
    expect(s.text).toContain("A kiosk in a village square.");
  });
});

describe("referencePalette", () => {
  it("takes the most recent image that has one, primary first", () => {
    expect(referencePalette([img({ palette: ["#AAAAAA"] }), img({ id: "b", palette: [] })])).toEqual(["#AAAAAA"]);
    expect(referencePalette([img({ palette: ["#111111", "#222222", "#333333", "#444444"] })])).toEqual(["#111111", "#222222", "#333333"]);
    expect(referencePalette([])).toEqual([]);
  });
});

describe("imageAttachmentsNote", () => {
  it("says nothing when no image is in the conversation", () => {
    expect(imageAttachmentsNote([])).toBe("");
  });
  it("names the image sent with the message, what it shows, and that it is context, not content", () => {
    const shot = img({ id: "s", name: "slide-2.png", description: "A slide whose two text boxes sit at different heights." });
    const note = imageAttachmentsNote([shot], [shot]);
    expect(note).toContain("an image with this message: slide-2.png (1200 by 800 px), which shows: A slide whose two text boxes");
    expect(note).toContain("Do NOT add it to the design unless the message explicitly asks");
    expect(note).toContain("placeAttachedImage");
    expect(note).not.toContain("Earlier in this conversation");
  });
  it("says when the provider could not read it", () => {
    const pic = img({});
    expect(imageAttachmentsNote([pic], [pic])).toContain("which the provider could not read");
  });
  it("lists earlier images as placeable by name, apart from the ones sent now", () => {
    const earlier = img({ id: "e", name: "logo.png", sentAt: 1 });
    const now = img({ id: "n", name: "photo.jpg", description: "x" });
    const note = imageAttachmentsNote([earlier, now], [now]);
    expect(note).toContain("with this message: photo.jpg");
    expect(note).toContain("Earlier in this conversation the user attached: logo.png");
    const onlyEarlier = imageAttachmentsNote([earlier], []);
    expect(onlyEarlier).toContain("logo.png");
    expect(onlyEarlier).not.toContain("with this message");
  });
});

describe("pickAttachedImage", () => {
  const a = img({ id: "a", name: "kiosk-front.jpg" });
  const b = img({ id: "b", name: "Team photo.png" });
  it("matches a name or part of it, else takes the most recent", () => {
    expect(pickAttachedImage([a, b], "kiosk")?.id).toBe("a");
    expect(pickAttachedImage([a, b], "team photo")?.id).toBe("b");
    expect(pickAttachedImage([a, b], "the kiosk-front picture")?.id).toBe("a");
    expect(pickAttachedImage([a, b])?.id).toBe("b");
    expect(pickAttachedImage([a, b], "nothing like it")?.id).toBe("b");
    expect(pickAttachedImage([], "x")).toBeNull();
  });
});

describe("paletteOf", () => {
  it("reads the dominant colours of a bitmap", () => {
    const px = [200, 30, 60, 255];
    const data = Array.from({ length: 64 }, () => px).flat();
    const palette = paletteOf({ width: 8, height: 8, data }, 3);
    expect(palette[0]).toBe("#C81E3C");
    // One flat colour yields one swatch, not the same hex three times.
    expect(new Set(palette).size).toBe(palette.length);
  });
});
