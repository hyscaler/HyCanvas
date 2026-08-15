// Video starter templates (P5.1): so the video editor does not open on an empty
// timeline. Each template builds a list of contiguous SCENES from footage-free
// design elements (a background + text, with entrance animations), using the same
// element-node model (`Clip.element`) the toolbar +Background / +Text actions
// produce. The editor lays these out as scenes on overlay tracks; they render in
// preview, the exact export, and the server MP4 like any other element.

import { createNode, type Node } from "@hc/schema";
import { tr } from "@/lib/i18n";

/** One scene (page) of a template: a stack of element nodes shown for a duration.
 *  layers[0] is the bottom (background); later entries draw on top. */
export interface TemplateScene {
  durationFrames: number;
  layers: Node[];
}

export interface VideoTemplate {
  id: string;
  name: string;
  description: string;
  /** Build the scenes for a given stage size and frame rate. */
  build: (width: number, height: number, fps: number) => TemplateScene[];
}

type SRGB = { r: number; g: number; b: number; a: number };

function bg(width: number, height: number, color: SRGB): Node {
  return createNode("shape", {
    shape: "rect",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width, height },
    fills: [{ type: "solid", color: { srgb: color } }],
  } as Partial<Node>);
}

/** A centered text element. `yFrac`/`hFrac` place its box; `sizeFrac` scales the
 *  font to the stage height; `entrance` is an optional NodeAnimation preset. */
function text(
  width: number,
  height: number,
  opts: {
    text: string;
    yFrac: number;
    hFrac?: number;
    sizeFrac: number;
    color: SRGB;
    weight?: number;
    align?: "left" | "center" | "right";
    entrance?: string;
    entranceDelayMs?: number;
  },
): Node {
  const fontSize = Math.max(14, Math.round(height * opts.sizeFrac));
  const boxH = Math.round(height * (opts.hFrac ?? 0.2));
  const node = createNode("text", {
    transform: { x: Math.round(width * 0.08), y: Math.round(height * opts.yFrac), scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: Math.round(width * 0.84), height: boxH },
    box: { mode: "fixed", width: Math.round(width * 0.84), height: boxH, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "middle" },
    content: [
      {
        runs: [{ text: opts.text, style: { fontFamily: "system", fontStyle: "Regular", fontSize, axes: { wght: opts.weight ?? 700 }, fill: { type: "solid", color: { srgb: opts.color } } } }],
        style: { align: opts.align ?? "center", direction: "auto" },
      },
    ],
  } as Partial<Node>);
  if (opts.entrance) {
    (node as unknown as { animation?: unknown }).animation = {
      entrance: { preset: opts.entrance, durationMs: 600, delayMs: opts.entranceDelayMs ?? 0, easing: "ease-out" },
    };
  }
  return node;
}

const INK: SRGB = { r: 0.1, g: 0.12, b: 0.16, a: 1 };
const WHITE: SRGB = { r: 1, g: 1, b: 1, a: 1 };
const ACCENT: SRGB = { r: 0.23, g: 0.51, b: 0.96, a: 1 };
const DEEP: SRGB = { r: 0.09, g: 0.11, b: 0.2, a: 1 };
const WARM: SRGB = { r: 0.99, g: 0.62, b: 0.2, a: 1 };

export const VIDEO_TEMPLATES: VideoTemplate[] = [
  {
    id: "title-intro",
    name: "Title intro",
    description: "A single titled opener: heading and subtitle on a solid page.",
    build: (w, h, fps) => [
      {
        durationFrames: Math.round(fps * 4),
        layers: [
          bg(w, h, WHITE),
          text(w, h, { text: tr("app.your_title"), yFrac: 0.36, sizeFrac: 0.11, color: INK, weight: 800, entrance: "rise" }),
          text(w, h, { text: tr("app.a_short_subtitle_goes_here"), yFrac: 0.54, sizeFrac: 0.05, color: { r: 0.35, g: 0.38, b: 0.44, a: 1 }, weight: 500, entrance: "fade", entranceDelayMs: 300 }),
        ],
      },
    ],
  },
  {
    id: "promo",
    name: tr("app.promo_3_scenes"),
    description: tr("app.hook_feature_and_call_to_action_scenes_on_bo"),
    build: (w, h, fps) => [
      {
        durationFrames: Math.round(fps * 3),
        layers: [bg(w, h, DEEP), text(w, h, { text: tr("app.introducing"), yFrac: 0.42, sizeFrac: 0.12, color: WHITE, weight: 800, entrance: "pop" })],
      },
      {
        durationFrames: Math.round(fps * 3),
        layers: [bg(w, h, ACCENT), text(w, h, { text: "Everything you need,\nnothing you don't", yFrac: 0.36, hFrac: 0.3, sizeFrac: 0.07, color: WHITE, weight: 700, entrance: "rise" })],
      },
      {
        durationFrames: Math.round(fps * 3),
        layers: [
          bg(w, h, INK),
          text(w, h, { text: tr("app.get_started_today"), yFrac: 0.4, sizeFrac: 0.09, color: WHITE, weight: 800, entrance: "zoom-in" }),
          text(w, h, { text: "yoursite.example", yFrac: 0.56, sizeFrac: 0.045, color: WARM, weight: 600, entrance: "fade", entranceDelayMs: 400 }),
        ],
      },
    ],
  },
  {
    id: "slideshow",
    name: tr("app.animated_slideshow"),
    description: tr("app.three_light_content_pages_with_animated_head"),
    build: (w, h, fps) => {
      const pages = [
        { title: tr("app.first_point"), body: tr("app.say_something_worth_remembering") },
        { title: tr("app.second_point"), body: tr("app.keep_each_slide_to_one_idea") },
        { title: tr("app.third_point"), body: tr("app.end_on_the_thing_you_want_them_to_do") },
      ];
      return pages.map((p) => ({
        durationFrames: Math.round(fps * 3.5),
        layers: [
          bg(w, h, WHITE),
          text(w, h, { text: p.title, yFrac: 0.3, sizeFrac: 0.09, color: INK, weight: 800, align: "left", entrance: "rise" }),
          text(w, h, { text: p.body, yFrac: 0.48, hFrac: 0.3, sizeFrac: 0.05, color: { r: 0.35, g: 0.38, b: 0.44, a: 1 }, weight: 500, align: "left", entrance: "fade", entranceDelayMs: 250 }),
        ],
      }));
    },
  },
  {
    id: "lower-third",
    name: tr("app.bold_statement"),
    description: tr("app.one_full_bleed_color_page_with_a_large_cente"),
    build: (w, h, fps) => [
      {
        durationFrames: Math.round(fps * 4),
        layers: [bg(w, h, ACCENT), text(w, h, { text: "Make it\nunmissable", yFrac: 0.32, hFrac: 0.4, sizeFrac: 0.13, color: WHITE, weight: 900, entrance: "pop" })],
      },
    ],
  },
];
