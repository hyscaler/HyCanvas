// Whiteboard -> deck conversion (FR-13 extension). Turns an infinite
// whiteboard into a presentation: each top-level frame (or sectioned frame's
// child frames) becomes one slide, content localized and scaled to fit a uniform
// slide size. When the board has no frames, the whole board becomes a single
// slide. Pure and framework-agnostic; reuses extractRegion for the per-frame
// localization so deck pages composite identically to the source content.

import {
  createBlankDesign,
  newId,
  type DesignFile,
  type FrameNode,
  type Node,
  type Page,
} from "@hc/schema";
import { extractRegion } from "./region";

export interface DeckOptions {
  /** Slide width in px (default 1920, 16:9). */
  slideWidth?: number;
  /** Slide height in px (default 1080, 16:9). */
  slideHeight?: number;
  /** Title for the produced deck (default "<source> (deck)"). */
  title?: string;
}

function isFrame(node: Node): node is FrameNode {
  return node.type === "frame";
}

function topLevelFrames(design: DesignFile): FrameNode[] {
  const frames: FrameNode[] = [];
  for (const page of design.pages) {
    for (const node of page.children) {
      if (isFrame(node)) frames.push(node);
    }
  }
  return frames;
}

function nodeBox(node: Node): { x: number; y: number; width: number; height: number } {
  return {
    x: node.transform?.x ?? 0,
    y: node.transform?.y ?? 0,
    width: node.size?.width ?? 0,
    height: node.size?.height ?? 0,
  };
}

function unionBounds(nodes: Node[]): { x: number; y: number; width: number; height: number } {
  if (nodes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const b = nodeBox(n);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * Scale + center an already-localized page (children at 0,0, page sized to the
 * content bounds) onto a uniform slide. Geometry is scaled uniformly through the
 * node transforms so nothing distorts; the slide gets a white background.
 */
function fitPageToSlide(page: Page, w: number, h: number): Page {
  const cw = Math.max(1, page.width || 1);
  const ch = Math.max(1, page.height || 1);
  const s = Math.min(w / cw, h / ch);
  const offX = (w - cw * s) / 2;
  const offY = (h - ch * s) / 2;
  const children = page.children.map((node) => {
    const t = node.transform ?? { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    return {
      ...node,
      transform: {
        ...t,
        x: t.x * s + offX,
        y: t.y * s + offY,
        scaleX: t.scaleX * s,
        scaleY: t.scaleY * s,
      },
    };
  });
  return {
    ...page,
    width: w,
    height: h,
    background: { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } },
    children,
  };
}

/**
 * Convert a whiteboard design into a presentation deck (a normal multi-page
 * DesignFile; present mode treats each page as a slide). Frames drive the slide
 * split; a frameless board yields a single fitted slide.
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Regenerate ids across a cloned node tree so the deck never shares ids. */
function regenIds(node: Node): void {
  node.id = newId();
  const any = node as unknown as { children?: Node[]; child?: Node };
  if (Array.isArray(any.children)) for (const c of any.children) regenIds(c);
  if (any.child) regenIds(any.child);
}

/** Whether a node's center lies within a frame's box (spatial containment). */
function centerInside(
  b: { x: number; y: number; width: number; height: number },
  fb: { x: number; y: number; width: number; height: number },
): boolean {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return cx >= fb.x && cx <= fb.x + fb.width && cy >= fb.y && cy <= fb.y + fb.height;
}

/**
 * Build a slide from a hand-drawn section (a frame with no children): the slide
 * content is every top-level node whose center sits inside the frame's bounds
 * (excluding other frames and connectors), localized to the frame origin. This
 * is the spatial-containment path - sections don't reparent their contents, so
 * the deck reads what is visually inside them.
 */
function spatialSectionSlide(design: DesignFile, frame: FrameNode, w: number, h: number): Page {
  const fb = nodeBox(frame);
  const inside = design.pages
    .flatMap((p) => p.children)
    .filter((n) => n.id !== frame.id && !isFrame(n) && n.type !== "connector" && centerInside(nodeBox(n), fb));
  const children = inside.map((n) => {
    const c = deepClone(n);
    regenIds(c);
    if (c.transform) c.transform = { ...c.transform, x: c.transform.x - fb.x, y: c.transform.y - fb.y };
    return c;
  });
  const page: Page = {
    id: newId(),
    name: frame.name ?? "Slide",
    width: Math.max(1, fb.width),
    height: Math.max(1, fb.height),
    children,
  };
  return fitPageToSlide(page, w, h);
}

export function whiteboardToDeck(design: DesignFile, opts: DeckOptions = {}): DesignFile {
  const w = opts.slideWidth ?? 1920;
  const h = opts.slideHeight ?? 1080;

  const deck = createBlankDesign({ title: opts.title ?? `${design.title} (deck)`, width: w, height: h });
  // A deck is a plain presentation design: drop the whiteboard surface kind so
  // the editor mounts the design canvas and present mode iterates the slides.
  const meta = { ...design.meta } as Record<string, unknown>;
  delete meta.kind;
  delete meta.whiteboard;
  deck.meta = meta;

  const frames = topLevelFrames(design);
  const pages: Page[] = [];
  if (frames.length > 0) {
    for (const frame of frames) {
      // Frames that already contain children (templates/programmatic) keep the
      // child-based extraction; hand-drawn sections (no children) gather the
      // nodes spatially inside them so the slide isn't empty.
      if ((frame.children?.length ?? 0) > 0) {
        const extracted = extractRegion(design, { frameId: frame.id });
        for (const page of extracted.pages) pages.push(fitPageToSlide(page, w, h));
      } else {
        pages.push(spatialSectionSlide(design, frame, w, h));
      }
    }
  } else {
    const all = design.pages.flatMap((p) => p.children);
    const extracted = extractRegion(design, { rect: unionBounds(all) });
    for (const page of extracted.pages) pages.push(fitPageToSlide(page, w, h));
  }

  deck.pages = pages.length > 0 ? pages : deck.pages;
  return deck;
}
