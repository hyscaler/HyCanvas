import { describe, expect, it } from "vitest";
import { thumbUrl, thumbWidthFor } from "./thumbUrl";

describe("thumbUrl", () => {
  it("rewrites an asset content URL, relative or absolute", () => {
    expect(thumbUrl("/api/v1/assets/abc-123/content", 512)).toBe("/api/v1/assets/abc-123/thumb?w=512");
    expect(thumbUrl("https://x.example/api/v1/assets/abc/content", 256)).toBe("https://x.example/api/v1/assets/abc/thumb?w=256");
    expect(thumbUrl("http://localhost:8005/api/v1/assets/abc/content?v=2", 1024)).toBe("http://localhost:8005/api/v1/assets/abc/thumb?w=1024");
  });

  it("leaves everything else alone", () => {
    for (const u of ["", "data:image/png;base64,AAAA", "blob:http://x/1", "/stock/library/pack/a.svg", "https://cdn.example/photo.jpg", "/api/v1/assets/abc/proxy", "/api/v1/assets/abc/content/extra"]) {
      expect(thumbUrl(u, 512)).toBe(u);
    }
  });
});

describe("thumbWidthFor", () => {
  it("picks the smallest variant that covers the card", () => {
    expect(thumbWidthFor(120, 2)).toBe(256);
    expect(thumbWidthFor(260, 1)).toBe(512);
    expect(thumbWidthFor(260, 2)).toBe(1024);
    expect(thumbWidthFor(1000, 3)).toBe(1024);
  });
});
