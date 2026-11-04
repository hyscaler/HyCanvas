/** @vitest-environment jsdom */
// Logo previews render whatever logoSrc returns as an <img src>. Only object,
// image data, and http(s) asset URLs may reach the DOM.

import { describe, it, expect } from "vitest";
import { safeLogoUrl } from "./BrandForms";

describe("safeLogoUrl", () => {
  it.each([
    "blob:http://localhost:3000/6f1c2b9e-0d7a-4a43-9a51-2f3a4b5c6d7e",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
    "https://cdn.example.com/a.png",
    "http://localhost:8005/api/v1/assets/abc/content",
  ])("keeps %s", (url) => {
    expect(safeLogoUrl(url)).toBe(url);
  });

  it("resolves a same-origin asset path", () => {
    expect(safeLogoUrl("/api/v1/assets/abc/content")).toBe(`${window.location.origin}/api/v1/assets/abc/content`);
  });

  it.each([
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ])("drops %s", (url) => {
    expect(safeLogoUrl(url)).toBeNull();
  });
});
