// resolveAssetUrl must never mangle a self-contained URL.
//
// Pasted and dropped images enter the document as `data:` URLs (the paste and
// drop handlers store the FileReader result directly), and the old resolver
// only recognized http(s) as absolute: everything else got the API origin
// prefixed. `http://localhost:8005data:image/png;...` is not a parseable URL,
// so every consumer that fetches asset bytes first - background removal, the
// export dialog - failed specifically on pasted images, the most common kind.

import { describe, expect, it } from "vitest";
import { apiOrigin, resolveAssetUrl } from "./sdk";

describe("resolveAssetUrl", () => {
  it("prefixes a server-relative content path with the API origin", () => {
    expect(resolveAssetUrl("/api/v1/assets/a1/content")).toBe(`${apiOrigin}/api/v1/assets/a1/content`);
  });

  it("returns absolute http(s) URLs untouched", () => {
    expect(resolveAssetUrl("https://cdn.example.com/x.png")).toBe("https://cdn.example.com/x.png");
    expect(resolveAssetUrl("http://cdn.example.com/x.png")).toBe("http://cdn.example.com/x.png");
  });

  it("returns a pasted image's data URL untouched, and the result stays parseable", () => {
    const pasted = "data:image/png;base64,iVBORw0KGgo=";
    expect(resolveAssetUrl(pasted)).toBe(pasted);
    expect(() => new URL(resolveAssetUrl(pasted))).not.toThrow();
  });

  it("returns blob URLs untouched", () => {
    const blob = "blob:http://localhost:3000/8c9d5f00-1a2b";
    expect(resolveAssetUrl(blob)).toBe(blob);
  });
});
