// Which AI features a provider setup leaves unavailable, so the settings form
// can say so where it is saved (#46) instead of the gap turning up later as a
// failed generation.
//
// Mirrors the server's routing (backend/internal/ai): generation and editing
// go to the dedicated image provider when one is set, otherwise to the main
// provider; reading an image uses the main provider when it can see, and falls
// to the image provider when it cannot.

import type { AiCapabilities } from "@hc/sdk";

export type AiGap = "image" | "editImage" | "describeImage";

/** An unknown provider (a legacy row, or a custom endpoint) is treated as
 *  capable, the same permissive default the server applies. */
const PERMISSIVE: AiCapabilities = { text: true, image: true, describeImage: true, editImage: true };

export function aiCapabilityGaps(main: AiCapabilities | undefined, image: AiCapabilities | undefined): AiGap[] {
  const m = main ?? PERMISSIVE;
  const gaps: AiGap[] = [];
  if (!(image ? image.image : m.image)) gaps.push("image");
  if (!(image ? image.editImage : m.editImage)) gaps.push("editImage");
  if (!(m.describeImage || !!image?.describeImage)) gaps.push("describeImage");
  return gaps;
}

/** The gaps a save would ADD. A setup that has always lacked a capability is
 *  not news on every save; one that is about to lose it, or a first save, is. */
export function newAiGaps(next: AiGap[], stored: AiGap[] | null): AiGap[] {
  if (!stored) return next;
  return next.filter((g) => !stored.includes(g));
}
