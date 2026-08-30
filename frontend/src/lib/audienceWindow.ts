// Second-display presenter view plumbing (doc 28 FR-15, AC-3).
//
// The presenter keeps the primary window (canvas + HUD) and opens a separate
// AUDIENCE window that mirrors the slide for the projector. The two windows are
// coupled by a BroadcastChannel carrying only tiny state messages (the slide
// index and playback flags); the audience window loads the design itself, so no
// document ever crosses the channel.
//
// Popups can be blocked. `openAudienceWindow` returns null in that case and the
// caller falls back to the shipped same-window overlay, which is why the HUD
// must never assume a second display exists.

/** The channel both windows join. Scoped per design so two decks never cross. */
export function audienceChannelName(designId: string): string {
  return `hc-present-${designId}`;
}

/** State the presenter pushes to the audience display. */
export interface AudienceState {
  /** The slide to show (a page index into the design file). */
  index: number;
  /** Blank the projection: "black" / "white" screen (B / W in present mode). */
  blank?: "black" | "white" | null;
  /** The presenter closed present mode; the audience window should close too. */
  closed?: boolean;
  /** Live caption text mirrored onto the audience display (C17); empty/absent
   *  hides the band. */
  caption?: string;
}

export type AudienceMessage =
  | { type: "state"; state: AudienceState }
  /** The audience window announces itself so the presenter can push initial state. */
  | { type: "hello" };

/**
 * Open the audience display for `designId`, focused on the given slide.
 *
 * Returns the window handle, or null when the popup was blocked (the caller
 * then keeps the same-window overlay). The URL is a normal shared route so the
 * window survives a reload on its own.
 */
export function openAudienceWindow(designId: string, index: number): Window | null {
  if (typeof window === "undefined") return null;
  const url = `/present/${encodeURIComponent(designId)}/?slide=${index}`;
  // A named window means re-opening focuses the existing display instead of
  // stacking duplicates on the projector.
  const win = window.open(url, `hc-audience-${designId}`, "noopener=no,popup=yes,width=1280,height=720");
  if (!win) return null;
  try {
    win.focus();
  } catch {
    /* focus can be refused; the window still opened */
  }
  return win;
}

/** Presenter side: a channel that pushes state and answers `hello`. */
export class AudienceLink {
  private channel: BroadcastChannel | null = null;
  private last: AudienceState | null = null;

  constructor(private designId: string) {
    if (typeof BroadcastChannel === "undefined") return;
    this.channel = new BroadcastChannel(audienceChannelName(designId));
    this.channel.onmessage = (e: MessageEvent<AudienceMessage>) => {
      // A newly opened (or reloaded) audience window asks for the current state.
      if (e.data?.type === "hello" && this.last) this.post(this.last);
    };
  }

  /** Push the current slide/blank state to the audience display. */
  post(state: AudienceState): void {
    this.last = state;
    this.channel?.postMessage({ type: "state", state } satisfies AudienceMessage);
  }

  close(): void {
    if (this.last) this.post({ ...this.last, closed: true });
    this.channel?.close();
    this.channel = null;
  }
}

/** Audience side: subscribe to presenter state. Returns a disposer. */
export function subscribeAudience(designId: string, onState: (s: AudienceState) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(audienceChannelName(designId));
  channel.onmessage = (e: MessageEvent<AudienceMessage>) => {
    if (e.data?.type === "state") onState(e.data.state);
  };
  // Announce so the presenter replays the current slide (covers a late open or
  // a reload of the audience display).
  channel.postMessage({ type: "hello" } satisfies AudienceMessage);
  return () => channel.close();
}
