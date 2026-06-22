// Shared test fixtures: minimal valid scene nodes, pages, and a site.

import type {
  ImageNode,
  LineNode,
  Node,
  Page,
  ShapeNode,
  StickyNode,
  TextNode,
  Transform,
} from "@hc/schema";
import type { FormBlock, Site } from "../types";

export function transform(x = 0, y = 0, extra: Partial<Transform> = {}): Transform {
  return { x, y, scaleX: 1, scaleY: 1, rotation: 0, ...extra };
}

const baseFields = {
  opacity: 1,
  blendMode: "normal" as const,
};

export function textNode(id: string, text: string, opts: Partial<TextNode> = {}): TextNode {
  return {
    id,
    type: "text",
    transform: transform(10, 20),
    size: { width: 200, height: 50 },
    ...baseFields,
    box: { mode: "fixed", width: 200, height: 50 },
    content: [
      {
        runs: [
          {
            text,
            style: {
              fontFamily: "Inter",
              fontStyle: "normal",
              fontSize: 24,
              fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.1, b: 0.1, a: 1 } } },
            },
          },
        ],
        style: { align: "center", direction: "ltr" },
      },
    ],
    ...opts,
  };
}

export function imageNode(id: string, assetId: string): ImageNode {
  return {
    id,
    type: "image",
    transform: transform(0, 0),
    size: { width: 300, height: 150 },
    ...baseFields,
    source: { assetId, naturalWidth: 600, naturalHeight: 300 },
    fit: "cover",
    focalPoint: { x: 0.5, y: 0.5 },
    alt: "A photo",
  };
}

export function rectNode(id: string): ShapeNode {
  return {
    id,
    type: "shape",
    transform: transform(40, 60),
    size: { width: 120, height: 80 },
    ...baseFields,
    shape: "rect",
    cornerRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
    fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
  };
}

export function ellipseNode(id: string): ShapeNode {
  return {
    id,
    type: "shape",
    transform: transform(0, 0),
    size: { width: 100, height: 100 },
    ...baseFields,
    shape: "ellipse",
    fills: [{ type: "solid", color: { srgb: { r: 0, g: 0.5, b: 1, a: 1 } } }],
  };
}

export function lineNode(id: string): LineNode {
  return {
    id,
    type: "line",
    transform: transform(0, 0),
    size: { width: 100, height: 10 },
    ...baseFields,
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    stroke: {
      fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } },
      width: 2,
      align: "center",
      cap: "butt",
      join: "miter",
    },
  };
}

export function stickyNode(id: string, text: string): StickyNode {
  return {
    id,
    type: "sticky",
    transform: transform(0, 0),
    size: { width: 150, height: 150 },
    ...baseFields,
    text,
    fill: { type: "solid", color: { srgb: { r: 1, g: 1, b: 0.6, a: 1 } } },
    textColor: { srgb: { r: 0, g: 0, b: 0, a: 1 } },
    fontScale: 1,
    autoSize: true,
  };
}

export function page(id: string, name: string, children: Node[] = []): Page {
  return { id, name, width: 1280, height: 720, children };
}

export function sampleForm(): FormBlock {
  return {
    id: "contact",
    fields: [
      { id: "f1", name: "fullName", label: "Full name", kind: "text", required: true },
      { id: "f2", name: "email", label: "Email", kind: "email", required: true },
      { id: "f3", name: "age", label: "Age", kind: "number", validation: { min: 18, max: 120 } },
      { id: "f4", name: "topic", label: "Topic", kind: "select", options: ["Sales", "Support"] },
      { id: "f5", name: "message", label: "Message", kind: "textarea", placeholder: "Hello" },
      { id: "f6", name: "submit", label: "Send", kind: "submit" },
    ],
    afterSubmit: { kind: "message", text: "Thanks!" },
    notifyEmails: ["owner@example.com"],
  };
}

export function sampleSite(homePageId = "home", otherId = "about"): Site {
  return {
    workspaceId: "ws1",
    designId: "d1",
    title: "Acme Co",
    slug: "acme",
    homePageId,
    pageOrder: [homePageId, otherId],
    nav: [
      { id: "n1", label: "Home", target: { kind: "page", pageId: homePageId }, visible: true },
      { id: "n2", label: "About", target: { kind: "page", pageId: otherId }, visible: true },
      { id: "n3", label: "Docs", target: { kind: "external", url: "https://docs.example.com" }, visible: true },
      { id: "n4", label: "Hidden", target: { kind: "page", pageId: otherId }, visible: false },
    ],
    settings: {
      seo: {
        title: "Acme Co - Home",
        description: "We build things",
        keywords: ["acme", "widgets"],
        canonical: "https://acme.hycanvas.site/",
        robots: "index,follow",
        perPage: {
          [otherId]: { title: "About Acme", description: "Our story" },
        },
      },
      faviconAssetId: "favicon1",
      social: {
        ogTitle: "Acme Social",
        ogImageAssetId: "og1",
        twitterCard: "summary_large_image",
      },
      password: { enabled: false },
      customCode: { head: "<!-- head-snippet -->", bodyEnd: "<!-- body-snippet -->" },
    },
    status: "draft",
  };
}
