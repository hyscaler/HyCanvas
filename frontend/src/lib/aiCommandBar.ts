// Pure helpers for the AI command bar (F22 FR-13). The platform exposes only a
// free-text AI primitive (oc.aiText), so the command bar turns the user's
// natural-language request into a concrete editor action by sending the model a
// compact manifest of the executable commands (derived from the existing
// command registry) and asking it to pick the best match as strict JSON. These
// helpers (manifest building + system prompt + choice parsing) are framework-free
// and unit-tested; the CommandMenu maps the chosen action id back to a real
// Command and executes it through the editor store so it stays undoable.

import { parseModelJson } from "./magicDesign";

/** One executable action in the manifest sent to the model: a stable id and a
 *  short human description (label + category) so the model can match intent. */
export interface CommandManifestEntry {
  id: string;
  description: string;
}

/** Minimal shape of a command the manifest is derived from (the editor's
 *  Command satisfies this structurally, like @hc/commandmenu's MenuItem). */
export interface ManifestCommand {
  id: string;
  label: string;
  category?: string;
  keywords?: string[];
}

/** The model's parsed choice: an action id (or null when nothing matched), with
 *  optional free-text reason. `args` is reserved for future parameterized
 *  actions; today's commands take no args, so it is accepted but unused. */
export interface AiCommandChoice {
  action: string | null;
  args?: Record<string, unknown>;
  reason?: string;
}

/**
 * Build the compact action manifest from the command registry. Each entry is the
 * command id plus a one-line description (category + label + keywords) so the
 * model has enough signal to map intent without the full UI. Kept terse to limit
 * tokens.
 */
export function buildCommandManifest(commands: ManifestCommand[]): CommandManifestEntry[] {
  return commands.map((c) => {
    const parts = [c.category ? `${c.category}: ${c.label}` : c.label];
    const kw = (c.keywords ?? []).filter((k) => k.trim());
    if (kw.length) parts.push(`(${kw.join(", ")})`);
    return { id: c.id, description: parts.join(" ") };
  });
}

/**
 * The system prompt for the AI command bar: instructs the model to choose the
 * single best-matching action id from the manifest and return STRICT JSON
 * `{ "action": "<id>" | null, "reason"?: string }`, or null when nothing fits.
 * The manifest is embedded as an `id\tdescription` table to stay compact.
 */
export function buildCommandBarSystem(manifest: CommandManifestEntry[]): string {
  const table = manifest.map((m) => `${m.id}\t${m.description}`).join("\n");
  return [
    "You are a command router for a design editor. The user describes what they",
    "want; choose the SINGLE best-matching action from the list below.",
    'Respond with strict JSON only: {"action":"<id>","reason":"<short why>"}.',
    'If no action is a good match, respond {"action":null}.',
    "Use an id verbatim from the list; never invent an id. No prose, no code fences.",
    "",
    "Available actions (id<TAB>description):",
    table,
  ].join("\n");
}

/**
 * Parse the model's reply into an {@link AiCommandChoice}, validating the chosen
 * id against the set of known ids. Returns `{ action: null }` for a non-match,
 * unparseable output, or an id that is not in the registry, so a malformed model
 * response degrades gracefully rather than throwing. `validIds` is the set of
 * registry ids the choice must belong to.
 */
export function parseCommandChoice(raw: string, validIds: Iterable<string>): AiCommandChoice {
  const ids = validIds instanceof Set ? validIds : new Set(validIds);
  let parsed: unknown;
  try {
    parsed = parseModelJson(raw);
  } catch {
    return { action: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { action: null };
  }
  const o = parsed as Record<string, unknown>;
  const action = typeof o.action === "string" && ids.has(o.action) ? o.action : null;
  const reason = typeof o.reason === "string" ? o.reason : undefined;
  const args =
    o.args && typeof o.args === "object" && !Array.isArray(o.args)
      ? (o.args as Record<string, unknown>)
      : undefined;
  return { action, reason, args };
}
