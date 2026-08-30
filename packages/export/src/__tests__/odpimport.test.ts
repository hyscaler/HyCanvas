// ODP import (F28 completion C25): fixtures are minimal in-memory ODF zips.

import { describe, expect, it } from "vitest";
import { validate } from "@hc/schema";
import { odfLengthPx, odpToDesign } from "../odpimport";
import { zipStore } from "../zipstore";

const enc = (s: string) => new TextEncoder().encode(s);

const STYLES = `<?xml version="1.0"?>
<office:document-styles xmlns:office="o" xmlns:style="s" xmlns:fo="f">
  <office:automatic-styles>
    <style:page-layout style:name="PM0">
      <style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/>
    </style:page-layout>
  </office:automatic-styles>
</office:document-styles>`;

function contentXml(body: string, autoStyles = ""): string {
  return `<?xml version="1.0"?>
<office:document-content xmlns:office="o" xmlns:draw="d" xmlns:text="t" xmlns:svg="v" xmlns:style="s" xmlns:fo="f" xmlns:xlink="x">
  <office:automatic-styles>${autoStyles}</office:automatic-styles>
  <office:body><office:presentation>${body}</office:presentation></office:body>
</office:document-content>`;
}

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("odfLengthPx", () => {
  it("converts cm/mm/in/pt/px at 96dpi", () => {
    expect(odfLengthPx("2.54cm")).toBeCloseTo(96, 5);
    expect(odfLengthPx("25.4mm")).toBeCloseTo(96, 5);
    expect(odfLengthPx("1in")).toBeCloseTo(96, 5);
    expect(odfLengthPx("72pt")).toBeCloseTo(96, 5);
    expect(odfLengthPx("50px")).toBe(50);
    expect(odfLengthPx("garbage")).toBeNull();
  });
});

describe("odpToDesign", () => {
  it("imports slides, text frames (styled sizes), images, and page background", async () => {
    const body = `
    <draw:page draw:name="Opening" draw:style-name="dp1">
      <draw:frame svg:x="2.54cm" svg:y="1.27cm" svg:width="12.7cm" svg:height="2.54cm">
        <draw:text-box><text:p text:style-name="P1"><text:span text:style-name="T1">Hello ODP</text:span></text:p><text:p>Second line</text:p></draw:text-box>
      </draw:frame>
      <draw:frame svg:x="1in" svg:y="2in" svg:width="2in" svg:height="1.5in">
        <draw:image xlink:href="Pictures/pic1.png"/>
      </draw:frame>
    </draw:page>
    <draw:page draw:name="Two">
      <draw:frame svg:x="0cm" svg:y="0cm" svg:width="5cm" svg:height="2cm">
        <draw:text-box><text:p>Page two</text:p></draw:text-box>
      </draw:frame>
    </draw:page>`;
    const autoStyles = `
      <style:style style:name="T1" style:family="text"><style:text-properties fo:font-size="24pt"/></style:style>
      <style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill-color="#123456"/></style:style>`;
    const bytes = zipStore([
      { name: "content.xml", data: enc(contentXml(body, autoStyles)) },
      { name: "styles.xml", data: enc(STYLES) },
      { name: "Pictures/pic1.png", data: PNG_STUB },
    ]);
    const file = await odpToDesign(bytes, { title: "Fixture" });

    // Page size from styles.xml (28cm x 15.75cm at 96dpi).
    expect(file.pages[0].width).toBe(Math.round((28 / 2.54) * 96));
    expect(file.pages[0].height).toBe(Math.round((15.75 / 2.54) * 96));
    expect(file.pages).toHaveLength(2);
    expect(file.pages[0].name).toBe("Opening");

    const kids = file.pages[0].children;
    const text = kids.find((n) => n.type === "text")! as unknown as {
      transform: { x: number }; content: { runs: { text: string; style: { fontSize: number } }[] }[];
    };
    expect(text.transform.x).toBeCloseTo(96, 0); // 2.54cm
    expect(text.content[0].runs[0].text).toBe("Hello ODP");
    expect(text.content[0].runs[0].style.fontSize).toBeCloseTo(32, 0); // 24pt = 32px
    expect(text.content[1].runs[0].text).toBe("Second line");

    const image = kids.find((n) => n.type === "image")! as unknown as { source: { assetId: string } };
    const asset = file.assets.find((a) => a.id === image.source.assetId);
    expect(asset?.url.startsWith("data:image/png;base64,")).toBe(true);

    const bg = (file.pages[0] as unknown as { background?: { type: string; color: { srgb: { r: number } } } }).background;
    expect(bg?.type).toBe("solid");
    expect(bg!.color.srgb.r).toBeCloseTo(0x12 / 255, 5);

    // The imported file must satisfy the OPEN FORMAT.
    const check = validate(file);
    expect(check.ok, "ok" in check && !check.ok ? `${check.pointer}: ${check.message}` : "").toBe(true);
  });

  it("skips empty placeholder frames and missing pictures without failing", async () => {
    const body = `
    <draw:page draw:name="P">
      <draw:frame svg:x="0cm" svg:y="0cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p/></draw:text-box></draw:frame>
      <draw:frame svg:x="0cm" svg:y="3cm" svg:width="5cm" svg:height="2cm"><draw:image xlink:href="Pictures/missing.png"/></draw:frame>
      <draw:frame svg:x="0cm" svg:y="6cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>Real</text:p></draw:text-box></draw:frame>
    </draw:page>`;
    const bytes = zipStore([{ name: "content.xml", data: enc(contentXml(body)) }]);
    const file = await odpToDesign(bytes);
    expect(file.pages[0].children).toHaveLength(1);
  });

  it("rejects a non-presentation archive cleanly", async () => {
    await expect(odpToDesign(zipStore([{ name: "unrelated.txt", data: enc("x") }]))).rejects.toThrow(/content\.xml/);
    const textDoc = `<?xml version="1.0"?><office:document-content xmlns:office="o"><office:body><office:text/></office:body></office:document-content>`;
    await expect(odpToDesign(zipStore([{ name: "content.xml", data: enc(textDoc) }]))).rejects.toThrow(/office:presentation/);
  });
});
