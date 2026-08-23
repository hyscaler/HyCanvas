// Deterministic avatars for collaborators: initials + a stable color derived
// from a person's id (or name as a fallback). Shared by the comments panel and
// the on-canvas comment pins so the same person reads the same everywhere.

import { avatarColors } from "@/lib/theme.generated";

// Single-sourced from theme.config.mjs (a distinct rainbow for telling people
// apart; not brand colors). Re-exported for avatar consumers.
export { avatarColors };

/** Up to two uppercase initials from a display name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A stable color from a seed (use the user id where possible, else the name). */
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return avatarColors[h % avatarColors.length];
}
