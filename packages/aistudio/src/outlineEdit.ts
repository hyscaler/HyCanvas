// F28 T09 - the outline review step's pure core: the generation dials that
// shape an outline request, and the sanitizer that turns a user-edited outline
// back into a well-formed DesignOutline before layout. UI-free and tested.

import { normalizeNote, type DesignOutline, type OutlineItem, type VisualRole, visualRoles } from "./outline";
import { verbosityRule, type Verbosity } from "./promptRules";

/** Optional generation dials, all defaulting to auto (omitted from the prompt). */
export interface GenerationDials {
  /** Per-page text density; maps to the rule corpus's concrete word targets. */
  density?: Verbosity | "auto";
  tone?: string;
  audience?: string;
  scenario?: string;
}

export const dialTones = ["auto", "general", "persuasive", "inspiring", "instructive", "engaging"] as const;
export const dialAudiences = ["auto", "general", "business", "investor", "teacher", "student"] as const;
export const dialScenarios = ["auto", "general", "analysis-report", "teaching-training", "promotional-materials", "public-speeches"] as const;
export const dialDensities = ["auto", "concise", "standard", "detailed"] as const;

/** Render the chosen dials as an authoritative-settings clause for the brief
 *  (the system prompt's settings-authority rule makes these override anything
 *  embedded in the brief or a source). Auto/empty dials contribute nothing;
 *  all-auto returns "". */
export function dialsClause(dials: GenerationDials | undefined): string {
  if (!dials) return "";
  const parts: string[] = [];
  if (dials.density && dials.density !== "auto") parts.push(verbosityRule(dials.density));
  if (dials.tone && dials.tone !== "auto") parts.push(`Tone: ${dials.tone}.`);
  if (dials.audience && dials.audience !== "auto") parts.push(`Audience: ${dials.audience}.`);
  if (dials.scenario && dials.scenario !== "auto") parts.push(`Scenario: ${dials.scenario.replace(/-/g, " ")}.`);
  if (!parts.length) return "";
  return `Generation settings (authoritative): ${parts.join(" ")}`;
}

/** Hard ceiling on pages a review edit can grow an outline to. */
export const maxOutlinePages = 20;

/** Per-item caps applied to review edits (characters, defensive). */
export const maxOutlineTitleChars = 120;
export const maxOutlinePointChars = 300;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

/** Sanitize a user-edited outline back into a well-formed DesignOutline:
 *  clip titles and points, drop blank points and empty items, keep at most
 *  maxOutlinePages items, keep roles valid, and re-normalize notes. Returns a
 *  NEW outline; never mutates the input. Throws nothing: an outline emptied by
 *  the edit comes back with zero pages and the caller decides what that means. */
export function sanitizeEditedOutline(outline: DesignOutline): DesignOutline {
  const pages: OutlineItem[] = [];
  for (const item of outline.pages ?? []) {
    if (pages.length >= maxOutlinePages) break;
    const title = clip(item.title ?? "", maxOutlineTitleChars);
    const points = (item.points ?? []).map((p) => clip(p, maxOutlinePointChars)).filter(Boolean).slice(0, 8);
    if (!title && !points.length) continue;
    const visualRole: VisualRole = visualRoles.includes(item.visualRole) ? item.visualRole : "content";
    const note = normalizeNote(item.note);
    pages.push({ id: item.id, title: title || "Untitled", points, visualRole, ...(note ? { note } : {}) });
  }
  return { title: clip(outline.title ?? "", maxOutlineTitleChars) || "Untitled", theme: (outline.theme ?? "").trim(), pages };
}
