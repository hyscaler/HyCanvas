// Guards for right-to-left layout (F38 FR-9). These are source-level checks
// rather than rendering tests on purpose: the failure they catch is someone
// adding a physical utility or a new design surface months from now, and no
// unit test of a component would notice. There is no left-to-right reviewer
// who can see the damage either, which is exactly why it needs a machine.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Surfaces that render DESIGN CONTENT and must not mirror with the shell.
 * Adding a new one without the pin is the regression this catches: it looks
 * fine to a left-to-right developer and detaches every overlay for everyone
 * else.
 */
const PINNED = [
  "components/editor/Canvas.tsx", // the design surface and all its overlays
  "components/editor/EditorApp.tsx", // the <main> wrapping doc/sheet/video/whiteboard
  "components/editor/PresentMode.tsx",
  "components/editor/AudienceStage.tsx",
  "components/DeckPlayer.tsx",
  "components/SharedViewer.tsx",
  "components/VideoWatch.tsx",
];

/**
 * Files exempt from the logical-property rule, and why. Everything else is
 * interface chrome and must mirror.
 */
const PHYSICAL_BY_DESIGN = new Set([
  ...PINNED,
  // Pinned to left-to-right by their parent, and positioned in the design's
  // own coordinate space.
  "components/editor/PageOverlays.tsx",
  "components/editor/Gizmo.tsx",
  "components/editor/CropOverlay.tsx",
  "components/editor/PathEditor.tsx",
  "components/editor/PresenceOverlay.tsx",
  "components/editor/CommentPins.tsx",
  "components/editor/MiniMap.tsx",
  "components/editor/SlideThumb.tsx",
  "components/editor/DocSurface.tsx",
  "components/editor/SheetSurface.tsx",
  "components/editor/VideoSurface.tsx",
  "components/editor/WhiteboardSurface.tsx",
  // Decorative background artwork: absolutely-placed shapes with no
  // relationship to reading order.
  "components/ui/CanvasBackdrop.tsx",
  "components/ui/CanvasFloor.tsx",
  // This file names the utilities in order to ban them.
  "lib/locale.pins.test.ts",
]);

/** Physical utilities and the logical utility that replaces each one. */
const BANNED: [RegExp, string][] = [
  [/\bml-(?=[\w.[])/, "ms-"],
  [/\bmr-(?=[\w.[])/, "me-"],
  [/\bpl-(?=[\w.[])/, "ps-"],
  [/\bpr-(?=[\w.[])/, "pe-"],
  [/\btext-left\b/, "text-start"],
  [/\btext-right\b/, "text-end"],
  [/\bborder-l\b|\bborder-l-(?=[\w.[])/, "border-s"],
  [/\bborder-r\b|\bborder-r-(?=[\w.[])/, "border-e"],
  [/\brounded-l\b|\brounded-l-(?=[\w.[])/, "rounded-s"],
  [/\brounded-r\b|\brounded-r-(?=[\w.[])/, "rounded-e"],
];

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Class strings only, so prose like "left-to-right" is never flagged. */
function classStrings(source: string): string[] {
  return source.match(/"[^"\n]*"|`[^`\n]*`|'[^'\n]*'/g) ?? [];
}

describe("design surfaces are pinned left-to-right", () => {
  for (const rel of PINNED) {
    it(`${rel} pins its surface`, () => {
      const src = readFileSync(join(SRC, rel), "utf8");
      expect(src, `${rel} must carry dir={DESIGN_SURFACE_DIR} on its design surface`).toContain(
        "dir={DESIGN_SURFACE_DIR}",
      );
    });
  }
});

describe("interface chrome uses logical properties", () => {
  it("has no physical spacing or alignment utilities left", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const rel = relative(SRC, file);
      if (PHYSICAL_BY_DESIGN.has(rel)) continue;
      for (const str of classStrings(readFileSync(file, "utf8"))) {
        for (const [rx, fix] of BANNED) {
          if (rx.test(str)) offenders.push(`${rel}: ${rx.source} -> use ${fix}`);
        }
      }
    }
    expect(offenders, `physical utilities do not mirror under dir="rtl"`).toEqual([]);
  });

  it("never mirrors the centring idiom, which has no direction", () => {
    // `left-1/2` with `-translate-x-1/2` centres an element. The translate stays
    // physical, so mirroring only the inset shifts it off-centre instead.
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      for (const str of classStrings(readFileSync(file, "utf8"))) {
        if (str.includes("start-1/2") && str.includes("-translate-x-1/2")) {
          offenders.push(relative(SRC, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
