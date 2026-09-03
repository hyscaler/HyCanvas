// Copying text has to keep working on a self-hosted instance reached over plain
// HTTP at a LAN address. `navigator.clipboard` is a secure-context api, so there
// it is simply absent, and reading `.writeText` off it throws synchronously,
// before any promise exists: a `.then(ok, err)` rejection handler never fires
// for that case, which is how a copy button ends up failing silently.
//
// The legacy textarea + execCommand path has no such restriction, so it stands
// in and the copy genuinely succeeds rather than merely failing politely.

/** Copy text to the clipboard, falling back to a hidden textarea + execCommand
 *  for insecure-context self-hosts where navigator.clipboard is unavailable.
 *  Never throws; returns whether the copy succeeded. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied, or the document is not focused: fall through and let
    // the legacy path try.
  }
  let ta: HTMLTextAreaElement | undefined;
  try {
    ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // In a finally, so a throwing execCommand cannot strand the node: every
    // failed copy would otherwise leave one more invisible textarea in the DOM.
    ta?.remove();
  }
}
