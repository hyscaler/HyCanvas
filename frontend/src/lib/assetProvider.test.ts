// The asset provider must resolve server-relative content URLs.
//
// Upload responses carry a relative url unless the backend has a publicURL
// configured, and documents store what the caller passed. A relative url
// loaded from the editor resolves against the FRONTEND origin, which is a
// different server in dev: the request 404s, the asset reads as permanently
// "missing", and the engine (by design) draws the image unmasked. That chain
// is exactly how a freshly removed background showed no visible effect.

import { describe, expect, it } from "vitest";
import { imageAssets } from "./assetProvider";
import { apiOrigin, resolveAssetUrl } from "./sdk";

describe("imageAssets.register", () => {
  it("resolves a server-relative content path against the API origin", () => {
    imageAssets.register("t-rel", "/api/v1/assets/t-rel/content");
    expect(imageAssets.url("t-rel")).toBe(`${apiOrigin}/api/v1/assets/t-rel/content`);
  });

  it("stores absolute and data URLs untouched", () => {
    imageAssets.register("t-abs", "https://cdn.example.com/x.png");
    expect(imageAssets.url("t-abs")).toBe("https://cdn.example.com/x.png");
    imageAssets.register("t-data", "data:image/png;base64,AAAA");
    expect(imageAssets.url("t-data")).toBe("data:image/png;base64,AAAA");
  });

  it("stays idempotent across raw and resolved spellings of the same url", () => {
    // registerAll re-registers every doc asset on each rev; if the dedupe
    // compared the RAW incoming url against the stored RESOLVED one, every
    // rev would restart the image load.
    imageAssets.register("t-idem", "/api/v1/assets/t-idem/content");
    const first = imageAssets.url("t-idem");
    imageAssets.register("t-idem", resolveAssetUrl("/api/v1/assets/t-idem/content"));
    expect(imageAssets.url("t-idem")).toBe(first);
  });
});
