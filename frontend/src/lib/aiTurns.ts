// The assistant's conversation is restored from the server after the panel
// mounts, and a turn can land before that restore returns: a brief handed
// over from the dashboard is sent the moment the panel subscribes. Replacing
// the list with what the server had then wiped the user's prompt from view
// while the generation carried on underneath, and whether it happened turned
// on which request finished first.

export interface RestorableTurn {
  role: string;
  text: string;
}

/** The restored history followed by every turn added meanwhile, with a turn
 *  the server already persisted shown once. A fresh panel simply takes the
 *  history. */
export function mergeRestoredTurns<T extends RestorableTurn>(restored: T[], current: T[]): T[] {
  if (!current.length) return restored;
  if (!restored.length) return current;
  const seen = new Set(restored.map((t) => `${t.role}\n${t.text}`));
  return [...restored, ...current.filter((t) => !seen.has(`${t.role}\n${t.text}`))];
}
