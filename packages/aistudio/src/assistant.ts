// F39 Phase 3 - the agentic design assistant (pure core). The model is given a
// typed catalog of editor capabilities and a compact summary of the current
// design, and returns an ordered plan of tool calls (or one clarifying
// question). This module defines the catalog, builds the system prompt, and
// validates the model's reply against the catalog so the executor (the store)
// only ever runs known, well-typed actions - never raw scene JSON (FR-6/7/10).

export type ToolParamType = "string" | "number" | "color" | "stringArray" | "series";

export interface ToolParam {
  name: string;
  type: ToolParamType;
  required?: boolean;
  description?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  params: ToolParam[];
  /** Whether this action meaningfully changes the document (for plan preview /
   *  confirmation of large or destructive turns, FR-8). */
  mutates: boolean;
}

/** The catalog of actions the assistant may plan. Each maps 1:1 onto an editor
 *  store capability in the executor; keep names stable - they are the contract. */
export function toolCatalog(): ToolDef[] {
  return [
    { name: "addPage", description: "Add a new blank page after the current one.", params: [], mutates: true },
    { name: "duplicatePage", description: "Duplicate the current page.", params: [], mutates: true },
    { name: "setPageBackground", description: "Set the current page's background to a solid color, or a linear gradient when a second color is given.", params: [
      { name: "color", type: "color", required: true, description: "hex like #1a2b3c (the only color, or the gradient's start)" },
      { name: "color2", type: "color", required: false, description: "a second hex color; when set the background becomes a linear gradient from color to color2" },
      { name: "angle", type: "number", required: false, description: "gradient angle in degrees (default 135)" },
    ], mutates: true },
    { name: "setSelectedText", description: "Replace the text of the currently selected text box.", params: [{ name: "text", type: "string", required: true }], mutates: true },
    { name: "recolorSelection", description: "Set the fill color of the selected element(s).", params: [{ name: "color", type: "color", required: true }], mutates: true },
    { name: "applyBrand", description: "Apply the workspace brand kit (colors, fonts) across the design.", params: [], mutates: true },
    { name: "harmonize", description: "Harmonize fonts, colors, and corner radii across the current page for visual consistency.", params: [], mutates: true },
    { name: "tidyLayout", description: "Auto-align and tidy the elements on the current page.", params: [], mutates: true },
    { name: "animatePage", description: "Apply tasteful entrance animations and a page transition to the current page.", params: [], mutates: true },
    { name: "insertChart", description: "Insert an editable chart.", params: [
      { name: "chartType", type: "string", required: true, description: "bar|line|area|pie|donut|scatter|radar" },
      { name: "categories", type: "stringArray", required: true },
      { name: "series", type: "series", required: true, description: "[{name, values:[...]}]" },
    ], mutates: true },
    { name: "resizePage", description: "Resize the current page to new pixel dimensions, recomposing the layout.", params: [
      { name: "width", type: "number", required: true },
      { name: "height", type: "number", required: true },
    ], mutates: true },
    // Content-creation tools. For these the model passes through the user's INTENT
    // as the prompt/instruction arg (not the finished content); the executor calls
    // the AI provider to produce the text/image and applies the result.
    { name: "writeText", description: "Generate copy and place it into the selected text box, or a new one if nothing suitable is selected. Use for 'write/add a headline/tagline/paragraph'.", params: [
      { name: "prompt", type: "string", required: true, description: "what to write, e.g. 'a punchy headline for a coffee shop launch'" },
    ], mutates: true },
    { name: "rewriteSelectedText", description: "Rewrite/transform the currently selected text box per an instruction (shorten, change tone, translate, fix grammar, etc.).", params: [
      { name: "instruction", type: "string", required: true, description: "how to rewrite, e.g. 'make it punchier' or 'translate to Spanish'" },
    ], mutates: true },
    { name: "translateDeck", description: "Translate the ENTIRE design into a target language: every text box on every page, sticky notes, and speaker notes, preserving layout and styling. Use for 'translate this deck/design/presentation to X'.", params: [
      { name: "language", type: "string", required: true, description: "target language, e.g. 'Spanish', 'Japanese', 'pt-BR'" },
    ], mutates: true },
    { name: "generateSpeakerNotes", description: "Write presenter speaker notes for EVERY slide, stored in each page's notes (shown in presenter view and the notes panel). Use for 'write/generate speaker notes / talking points'.", params: [
      { name: "instruction", type: "string", required: false, description: "optional guidance, e.g. 'keep each to 3 short bullet points' or 'formal tone'" },
    ], mutates: true },
    { name: "generateImage", description: "Generate an image from a description and place it on the current page (fills the selected frame if one is selected).", params: [
      { name: "prompt", type: "string", required: true, description: "what the image shows" },
      { name: "style", type: "string", required: false, description: "'logo' for a flat vector logo; otherwise omit" },
    ], mutates: true },
    { name: "generateBackgroundImage", description: "Generate a full-bleed background image and place it behind the current page's content.", params: [
      { name: "prompt", type: "string", required: true, description: "the background scene/texture" },
    ], mutates: true },
    { name: "editSelectedImage", description: "Edit the currently selected image by instruction (e.g. 'remove the background', 'make it night-time').", params: [
      { name: "instruction", type: "string", required: true },
    ], mutates: true },
    { name: "generateDesign", description: "Create a complete, finished design from scratch - a single poster, flyer, or social post, or a multi-page document or deck - with text, images, shapes, and layout composed for you. On a document that already has content the generated pages are APPENDED; replacement is destructive and never the default. Use this whenever the user asks to create/make/design/build/generate something with content or a 'fresh layout'.", params: [
      { name: "prompt", type: "string", required: true, description: "the brief, e.g. 'a 5-slide pitch deck for an eco water bottle'" },
      { name: "designType", type: "string", required: false, description: "deck|doc|social|poster (inferred if omitted)" },
      { name: "pageCount", type: "number", required: false },
      { name: "mode", type: "string", required: false, description: "'append' adds the generated pages (already the default when the document has content); 'replace' DESTROYS and replaces every existing page - pass it ONLY when the user explicitly asks to replace/wipe/start over (they are asked to confirm)" },
    ], mutates: true },
    { name: "generateDiagram", description: "Create a flowchart or mind map ON THE BOARD from a description - native sticky notes + connectors, auto-laid-out. Also accepts pasted Mermaid source verbatim. Use for 'draw/make a flowchart/diagram/mind map of X'.", params: [
      { name: "prompt", type: "string", required: true, description: "what to diagram (a plain description, or Mermaid flowchart source pasted verbatim)" },
      { name: "kind", type: "string", required: false, description: "flowchart|mindmap (default flowchart)" },
    ], mutates: true },
    { name: "clusterStickies", description: "Group the board's sticky notes into labeled theme frames (affinity clustering): each theme becomes a titled frame with its stickies arranged inside. Use for 'cluster/group the stickies by theme'.", params: [
      { name: "instruction", type: "string", required: false, description: "optional guidance, e.g. 'cluster by customer segment'" },
    ], mutates: true },
    { name: "summarizeStickies", description: "Summarize the board's sticky notes into a text note on the canvas: key themes, decisions, and action items. Use for 'summarize the board / the stickies / this brainstorm'.", params: [], mutates: true },
    { name: "critique", description: "Analyze the current page and report design issues (no changes).", params: [], mutates: false },
  ];
}

export interface PlanStep {
  action: string;
  args: Record<string, unknown>;
  status: "planned" | "done" | "skipped" | "failed";
  reason?: string;
}

export interface AssistantResponse {
  /** A short natural-language reply to show the user. */
  reply: string;
  /** One focused clarifying question; when set, plan is empty (FR-10). */
  clarify?: string;
  plan: PlanStep[];
}

export class AssistantError extends Error {}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Coerce/validate one arg by declared type; returns undefined if invalid. */
function coerceArg(type: ToolParamType, v: unknown): unknown {
  switch (type) {
    case "string":
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case "color":
      return typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : undefined;
    case "stringArray":
      return Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.trim()) : undefined;
    case "series": {
      if (!Array.isArray(v)) return undefined;
      const out: { name: string; values: number[] }[] = [];
      for (const s of v) {
        if (!s || typeof s !== "object") continue;
        const o = s as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name : "Series";
        const values = Array.isArray(o.values) ? o.values.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
        if (values.length) out.push({ name, values });
      }
      return out.length ? out : undefined;
    }
  }
}

/** Validate a single step's args against its tool. Returns null if the action is
 *  unknown or a required arg is missing/invalid. */
function validateStep(action: string, rawArgs: unknown, byName: Map<string, ToolDef>): PlanStep | null {
  const tool = byName.get(action);
  if (!tool) return null;
  const src = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  const args: Record<string, unknown> = {};
  for (const p of tool.params) {
    const coerced = coerceArg(p.type, src[p.name]);
    if (coerced === undefined) {
      if (p.required) return null;
      continue;
    }
    args[p.name] = coerced;
  }
  return { action, args, status: "planned" };
}

/** Parse the model's reply into a validated AssistantResponse. Invalid steps are
 *  dropped (degrade gracefully); a clarify question short-circuits the plan. */
export function parseAssistantReply(parsed: unknown, catalog: ToolDef[]): AssistantResponse {
  const byName = new Map(catalog.map((t) => [t.name, t] as const));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AssistantError("The assistant reply wasn't in the expected format.");
  }
  const root = parsed as Record<string, unknown>;
  const reply = typeof root.reply === "string" ? root.reply.trim() : "";
  const clarify = typeof root.clarify === "string" && root.clarify.trim() ? root.clarify.trim() : undefined;
  if (clarify) return { reply: reply || clarify, clarify, plan: [] };

  const rawPlan = Array.isArray(root.plan) ? root.plan : [];
  const plan: PlanStep[] = [];
  for (const item of rawPlan) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const action = typeof o.action === "string" ? o.action : "";
    const step = validateStep(action, o.args, byName);
    if (step) plan.push(step);
  }
  return { reply: reply || (plan.length ? "Done." : "I couldn't map that to an action."), plan };
}

/** True when a plan contains a mutating step, used to gate confirmation. */
export function planMutates(plan: PlanStep[], catalog: ToolDef[]): boolean {
  const byName = new Map(catalog.map((t) => [t.name, t] as const));
  return plan.some((s) => byName.get(s.action)?.mutates);
}

// --- Design summary (compact context, not the raw file) --------------------

interface SummaryPage {
  name?: string;
  width: number;
  height: number;
  children: { type: string; name?: string }[];
}
interface SummaryDoc {
  title?: string;
  pages: SummaryPage[];
}

/** A compact, token-bounded summary of the design for assistant context: page
 *  list, sizes, selection, and per-page element-type counts. Never the raw
 *  scene file (cost + privacy). */
export function summarizeDesign(doc: SummaryDoc, activePage: number, selectionCount: number): string {
  const lines: string[] = [];
  if (doc.title) lines.push(`Title: ${doc.title}`);
  lines.push(`Pages: ${doc.pages.length}; active page: ${activePage + 1}; selected elements: ${selectionCount}.`);
  doc.pages.forEach((p, i) => {
    const counts = new Map<string, number>();
    for (const c of p.children) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
    const parts = Array.from(counts.entries()).map(([t, n]) => `${n} ${t}`).join(", ") || "empty";
    lines.push(`${i + 1}. ${p.name || `Page ${i + 1}`} (${p.width}x${p.height}): ${parts}`);
  });
  return lines.join("\n");
}

/** System prompt for the assistant: choose actions from the catalog, return a
 *  validated JSON plan or one clarifying question. */
export function assistantSystemPrompt(catalog: ToolDef[], designSummary: string): string {
  const tools = catalog
    .map((t) => {
      const params = t.params.map((p) => `${p.name}:${p.type}${p.required ? "" : "?"}${p.description ? ` (${p.description})` : ""}`).join(", ");
      return `- ${t.name}(${params})${t.mutates ? "" : " [read-only]"}: ${t.description}`;
    })
    .join("\n");
  return [
    "You are an agentic design assistant inside a design editor. Decompose the user's request into an ordered plan of tool calls, choosing ONLY from the catalog below. Never invent tools or edit raw document JSON.",
    'Output ONLY a single JSON object, no prose/markdown/fences: {"reply": string, "plan": [{"action": string, "args": object}], "clarify"?: string}.',
    "You CAN create finished designs and add content - never reply that you cannot add text, shapes, images, or layouts. For any request to create/make/design/build/generate something with content from scratch (a poster, flyer, social post, document, presentation, or any 'fresh layout/content'), use generateDesign with an appropriate designType; it composes whole pages (text, shapes, images, layout), appending to a document that already has content. Pass mode:'replace' only when the user explicitly asks to replace or start over.",
    "For writeText/generateImage/generateBackgroundImage/editSelectedImage/rewriteSelectedText/generateDesign pass the user's INTENT as the prompt/instruction arg (never the finished text). writeText adds a new text box; generateImage adds an image. So you CAN add text, shapes, images, and full layouts.",
    "Strongly prefer producing a plan over asking. Do NOT ask the user about page size, theme, or whether to add content - just generate it. Use \"clarify\" ONLY when the request is truly ambiguous (you cannot tell what to make) or would destroy specific existing work in more than one plausible way; otherwise return an empty clarify and a real plan.",
    'Example - user: "professional marketing poster, fresh content and fresh layout" -> {"reply":"Creating a professional marketing poster.","plan":[{"action":"generateDesign","args":{"prompt":"professional marketing poster","designType":"poster"}}]}.',
    "Use action names verbatim from the catalog and provide every required arg with the correct type. Keep the plan minimal: only the steps needed. Prefer existing-selection actions (setSelectedText, recolorSelection) when the user refers to 'this' or 'the selected'.",
    "",
    "Tool catalog:",
    tools,
    "",
    "Current design:",
    designSummary,
  ].join("\n");
}
