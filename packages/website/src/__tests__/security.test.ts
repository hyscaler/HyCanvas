import { describe, expect, it } from "vitest";
import { cssFontFamily, safeUrl, style } from "../html";
import { resolveElementLink, resolveNavHref, type NavContext } from "../nav";
import { renderNode } from "../render";
import { submissionsToCsv } from "../forms";
import type { FormField, FormSubmission } from "../types";
import type { Node } from "@hc/schema";
import { rectNode, stickyNode, textNode, transform } from "./fixtures";

const navCtx: NavContext = { slugForPage: () => undefined, homePageId: "home" };

describe("safeUrl scheme allow-list", () => {
  it("neutralizes dangerous schemes to '#'", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("JAVASCRIPT:alert(1)")).toBe("#");
    expect(safeUrl("java\nscript:alert(1)")).toBe("#");
    expect(safeUrl("\tjavascript:alert(1)")).toBe("#");
    expect(safeUrl("java\tscript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBe("#");
    expect(safeUrl("vbscript:msgbox(1)")).toBe("#");
    expect(safeUrl("file:///etc/passwd")).toBe("#");
    expect(safeUrl("  javascript:alert(1)  ")).toBe("#");
  });

  it("preserves safe schemes and relative/anchor forms", () => {
    expect(safeUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(safeUrl("https://example.com/a?q=1#x")).toBe("https://example.com/a?q=1#x");
    expect(safeUrl("mailto:hi@example.com")).toBe("mailto:hi@example.com");
    expect(safeUrl("tel:+15551234")).toBe("tel:+15551234");
    expect(safeUrl("/about/")).toBe("/about/");
    expect(safeUrl("./page.html")).toBe("./page.html");
    expect(safeUrl("../up.html")).toBe("../up.html");
    expect(safeUrl("#section")).toBe("#section");
    expect(safeUrl("contact")).toBe("contact");
    expect(safeUrl("page/index.html")).toBe("page/index.html");
  });

  it("rejects protocol-relative urls and empties", () => {
    expect(safeUrl("//evil.example.com")).toBe("#");
    expect(safeUrl(undefined)).toBe("#");
    expect(safeUrl("")).toBe("#");
    expect(safeUrl("   ")).toBe("#");
  });
});

describe("link sanitization end to end", () => {
  it("renders an element link with a javascript: url as href='#'", () => {
    const node: Node = { ...rectNode("ln"), link: { kind: "url", target: "javascript:alert(1)" } };
    const html = renderNode(node, { resolveAssetUrl: (id) => id, navContext: navCtx });
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });

  it("resolveElementLink neutralizes a javascript: url target", () => {
    expect(resolveElementLink({ kind: "url", target: "javascript:alert(1)" }, navCtx)).toBe("#");
  });

  it("resolveNavHref neutralizes a javascript: external target", () => {
    const href = resolveNavHref(
      { id: "n", label: "x", target: { kind: "external", url: "javascript:alert(1)" } },
      navCtx,
    );
    expect(href).toBe("#");
  });

  it("neutralizes a javascript: image src", () => {
    const node: Node = {
      id: "i",
      type: "image",
      transform: transform(0, 0),
      size: { width: 10, height: 10 },
      opacity: 1,
      blendMode: "normal",
      source: { assetId: "a", naturalWidth: 1, naturalHeight: 1 },
      fit: "cover",
    } as unknown as Node;
    const html = renderNode(node, { resolveAssetUrl: () => "javascript:alert(1)" });
    expect(html).toContain('src="#"');
    expect(html).not.toContain("javascript:");
  });

  it("neutralizes a javascript: embed src", () => {
    const node = {
      id: "e",
      type: "embed",
      transform: transform(0, 0),
      size: { width: 10, height: 10 },
      opacity: 1,
      blendMode: "normal",
      src: "javascript:alert(1)",
    } as unknown as Node;
    const html = renderNode(node, { resolveAssetUrl: (id) => id });
    expect(html).toContain('src="#"');
    expect(html).not.toContain("javascript:");
  });
});

describe("cssFontFamily / style attribute breakout", () => {
  it("strips quotes, brackets, semicolons, braces and backslashes", () => {
    // Each dangerous character (" ' < > ; { } \) is removed entirely.
    expect(cssFontFamily('Inter"; background:url(x)')).toBe("'Inter background:url(x)', sans-serif");
    expect(cssFontFamily("Inter'><script>")).toBe("'Interscript', sans-serif");
    expect(cssFontFamily("Inter;color:red")).toBe("'Intercolor:red', sans-serif");
    expect(cssFontFamily(undefined)).toBe("sans-serif");
    expect(cssFontFamily("   ")).toBe("sans-serif");
    // Confirm the result can never carry a breakout character.
    for (const out of [cssFontFamily('a";}<>\\'), cssFontFamily("b'{")]) {
      expect(out).not.toMatch(/["<>;{}\\]/);
    }
  });

  it("a hostile fontFamily cannot break out of a text node style attribute", () => {
    const node = textNode("t", "hello");
    node.content[0].runs[0].style.fontFamily = 'Evil"></div><img src=x onerror=alert(1)>';
    const html = renderNode(node, { resolveAssetUrl: (id) => id });
    // The breakout sequence is gone: no raw quote/bracket escapes the value.
    expect(html).not.toContain('"></div>');
    expect(html).not.toContain("<img");
    // No raw double-quote or angle bracket appears inside the font-family value.
    expect(html).not.toMatch(/font-family:'[^']*["<>]/);
  });

  it("a hostile sticky fontFamily cannot break out either", () => {
    const node = stickyNode("k", "note");
    (node as { fontFamily?: string }).fontFamily = 'X"; } body { display:none';
    const html = renderNode(node, { resolveAssetUrl: (id) => id });
    expect(html).not.toMatch(/font-family:[^;"]*"/);
  });

  it("style() never emits a raw double-quote", () => {
    const out = style({ "font-family": 'evil"break', color: "red" });
    expect(out).not.toContain('"');
  });
});

describe("text align clamping", () => {
  it("clamps a hostile align value to left", () => {
    const node = textNode("t", "hi");
    (node.content[0].style as { align: string }).align = 'right;} body{display:none';
    const html = renderNode(node, { resolveAssetUrl: (id) => id });
    expect(html).toContain("text-align:left");
    expect(html).not.toContain("display:none");
  });

  it("keeps a valid align value", () => {
    const node = textNode("t", "hi"); // fixture uses center
    const html = renderNode(node, { resolveAssetUrl: (id) => id });
    expect(html).toContain("text-align:center");
  });
});

describe("submissionsToCsv formula injection", () => {
  const fields: FormField[] = [
    { id: "f1", name: "name", label: "Name", kind: "text" },
    { id: "f2", name: "note", label: "Note", kind: "text" },
  ];

  function csvFor(values: Record<string, unknown>): string {
    const subs: FormSubmission[] = [{ id: "s1", values }];
    return submissionsToCsv(fields, subs);
  }

  it("prefixes leading = + - @ cells with an apostrophe", () => {
    expect(csvFor({ name: "=HYPERLINK(\"http://x\")", note: "ok" })).toContain("'=HYPERLINK");
    expect(csvFor({ name: "+1+2", note: "ok" })).toContain("'+1+2");
    expect(csvFor({ name: "-5", note: "ok" })).toContain("'-5");
    expect(csvFor({ name: "@SUM(A1)", note: "ok" })).toContain("'@SUM(A1)");
  });

  it("leaves a normal cell untouched", () => {
    const csv = csvFor({ name: "Alice", note: "hello" });
    expect(csv).toContain("Alice");
    expect(csv).not.toContain("'Alice");
  });

  it("neutralizes a formula inside a quoted (comma-containing) cell", () => {
    const csv = csvFor({ name: "=cmd,danger", note: "ok" });
    expect(csv).toContain('"\'=cmd,danger"');
  });
});
