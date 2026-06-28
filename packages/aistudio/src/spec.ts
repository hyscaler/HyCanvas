// F39 AI Creative Studio - the structured design spec the model returns, plus a
// robust validator/normalizer and a JSON Schema for it. The spec carries content
// + roles + a layout intent ONLY; concrete geometry is computed by the layout
// engine (layout.ts), so the model never guesses pixel positions. This is the
// quality win over the old fraction-positioned approach.

/** A layout intent the engine arranges blocks into. */
export type DesignLayout = "centered" | "left" | "title-top" | "split";
export const DESIGN_LAYOUTS: DesignLayout[] = ["centered", "left", "title-top", "split"];

/** The role of a content block; drives the type scale and styling. */
export type BlockRole = "eyebrow" | "heading" | "subheading" | "body" | "accent";
export const BLOCK_ROLES: BlockRole[] = ["eyebrow", "heading", "subheading", "body", "accent"];

export interface DesignBlock {
  role: BlockRole;
  /** Required for text roles; ignored for "accent" (a decorative bar). */
  text?: string;
  /** Optional hex color hint; the quality pass overrides it if contrast is poor. */
  color?: string;
}

export interface DesignBackground {
  kind: "solid" | "gradient";
  color?: string; // solid fill, or gradient start
  color2?: string; // gradient end
  angle?: number; // gradient angle (deg)
}

/** Brand fonts for generated text, by role. Falls back to "system" (FR-17). */
export interface DesignFonts {
  heading?: string;
  body?: string;
}

export interface AiDesignSpec {
  layout: DesignLayout;
  background: DesignBackground;
  blocks: DesignBlock[];
  /** Reading direction; drives alignment and anchoring. Defaults to "ltr". */
  dir?: "ltr" | "rtl";
  /** Brand font families to use for headings/body (FR-17). */
  fonts?: DesignFonts;
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const hex = (v: unknown): string | undefined =>
  typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : undefined;

export class DesignSpecError extends Error {}

/** Validate + normalize a parsed model value into an AiDesignSpec. Drops unusable
 *  blocks, defaults safe values, and throws DesignSpecError when nothing usable
 *  remains (the caller surfaces a friendly retry message). */
export function normalizeDesignSpec(parsed: unknown): AiDesignSpec {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DesignSpecError("The AI response wasn't in the expected format.");
  }
  const root = parsed as Record<string, unknown>;
  const layout = DESIGN_LAYOUTS.includes(root.layout as DesignLayout) ? (root.layout as DesignLayout) : "centered";

  const bgRaw = (root.background && typeof root.background === "object" ? root.background : {}) as Record<string, unknown>;
  const background: DesignBackground = {
    kind: bgRaw.kind === "gradient" ? "gradient" : "solid",
    color: hex(bgRaw.color) ?? "#ffffff",
    color2: hex(bgRaw.color2),
    angle: typeof bgRaw.angle === "number" && Number.isFinite(bgRaw.angle) ? bgRaw.angle : 135,
  };

  const rawBlocks = Array.isArray(root.blocks) ? root.blocks : [];
  const blocks: DesignBlock[] = [];
  for (const item of rawBlocks) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const role = BLOCK_ROLES.includes(b.role as BlockRole) ? (b.role as BlockRole) : "body";
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (role !== "accent" && !text) continue; // text roles need content
    blocks.push({ role, text: role === "accent" ? undefined : text, color: hex(b.color) });
  }
  if (!blocks.some((b) => b.role !== "accent")) {
    throw new DesignSpecError("The AI didn't return any usable text. Try a more specific prompt.");
  }
  const dir = root.dir === "rtl" ? "rtl" : "ltr";
  return { layout, background, blocks, dir };
}

/** JSON Schema for AiDesignSpec - embedded in the generation prompt and ready to
 *  drive provider structured-output / tool-calling once the backend exposes it. */
export const designSpecJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["layout", "background", "blocks"],
  properties: {
    layout: { type: "string", enum: DESIGN_LAYOUTS },
    background: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["solid", "gradient"] },
        color: { type: "string", description: "hex, e.g. #1a2b3c" },
        color2: { type: "string", description: "hex; gradient end" },
        angle: { type: "number", description: "gradient angle in degrees" },
      },
    },
    blocks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role"],
        properties: {
          role: { type: "string", enum: BLOCK_ROLES },
          text: { type: "string" },
          color: { type: "string", description: "hex" },
        },
      },
    },
  },
} as const;
