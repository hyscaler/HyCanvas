// User-facing errors with stable codes (F38 FR-9).
//
// A thrown `new Error("Couldn't read that file.")` puts prose in two places at
// once: the LOG, where it must stay English and greppable, and the TOAST,
// where it must follow the user's language. Translating the thrown string
// breaks the log; not translating it breaks the toast. The split: throw a
// CODE alongside the English message, and translate the code at the display
// boundary only.
//
// `message` stays the English text, so console traces, server logs, and
// `expect(...).toThrow(/pattern/)` tests all keep working unchanged. `code` is
// a catalog key under `errors.*` that `userMessage` resolves at render time.
//
// This module is a LEAF on purpose (imports only i18n): it is thrown from
// lib/ code that must not drag UI modules in.

import { tr } from "./i18n";

export class CodedError extends Error {
  /** Catalog key under `errors.*`, resolved at display time. */
  readonly code: string;
  /** Interpolation values for the catalog string's `{placeholders}` (an HTTP
   *  status, a byte count), so a translated message can still carry the
   *  variable detail the English message embeds. */
  readonly params?: Record<string, unknown>;

  constructor(code: string, englishMessage: string, params?: Record<string, unknown>) {
    super(englishMessage);
    this.name = "CodedError";
    this.code = code;
    this.params = params;
  }
}

/**
 * Translate an API problem+json body's stable `code`, or null when the code
 * is absent or has no catalog entry. Codes live under `errors.api_*`, so the
 * backend can add codes freely and each becomes translatable the moment its
 * catalog entry lands, with the server's English detail as the fallback.
 */
export function apiCodeMessage(body: unknown): string | null {
  const code = (body as { code?: string } | null | undefined)?.code;
  if (!code) return null;
  const key = `errors.api_${code}`;
  const translated = tr(key);
  return translated === key ? null : translated;
}

/**
 * The message to SHOW for a failure, in the user's language.
 *
 * - CodedError: the translated catalog string for its code, falling back to
 *   the English message if the key is somehow missing.
 * - API error (an error carrying a problem+json `body`): the translated
 *   `errors.api_<code>` when the server sent a code, else the server's
 *   English `detail`, else the caller's fallback. The error's own `.message`
 *   ("HyCanvas API 413 on /path") is never shown; it names the request, not
 *   the problem.
 * - Plain Error: its `.message`, unchanged. This matches what every call site
 *   did before (`e instanceof Error ? e.message : fallback`), so adopting this
 *   helper is behavior-preserving for errors that have not been coded yet.
 * - Anything else: the caller's fallback.
 */
export function userMessage(e: unknown, fallback: string): string {
  if (e instanceof CodedError) {
    const translated = tr(e.code, e.params);
    return translated === e.code ? e.message : translated;
  }
  if (e && typeof e === "object" && "body" in e) {
    const body = (e as { body?: { detail?: string } | null }).body;
    return apiCodeMessage(body) ?? body?.detail ?? fallback;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
