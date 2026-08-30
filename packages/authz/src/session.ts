// Refresh-token rotation with reuse detection. Each
// login starts a session "family"; every refresh rotates the token. Presenting
// an already-rotated token outside a short grace window means the token leaked
// and was replayed: the whole family is revoked (sign-out). A brief grace
// tolerates concurrent-tab races so a multi-tab user is not logged out.

export interface SessionState {
  familyId: string;
  currentTokenId: string;
  previousTokenId?: string; // the just-rotated token, valid within the grace window
  rotatedAt: number; // ms epoch of the last rotation
  revoked: boolean;
}

export const defaultGraceMs = 10_000;

export type RefreshOutcome =
  | { action: "rotate"; state: SessionState } // normal: issue newTokenId, advance the family
  | { action: "tolerate"; state: SessionState } // concurrent-tab race within grace; family intact: reissue an access token only, NEVER a new refresh token (racing tabs share one cookie jar; a second rotation would strand it on a dead token)
  | { action: "revoke-family"; state: SessionState } // reuse detected; sign the family out
  | { action: "reject"; state: SessionState }; // already revoked

/** Start a new session family on login. */
export function startSession(familyId: string, tokenId: string, now: number): SessionState {
  return { familyId, currentTokenId: tokenId, rotatedAt: now, revoked: false };
}

/**
 * Process a refresh attempt. `presentedTokenId` is the refresh token the client
 * sent; `newTokenId` is the id to rotate to on success.
 */
export function rotateRefresh(
  state: SessionState,
  presentedTokenId: string,
  newTokenId: string,
  now: number,
  graceMs = defaultGraceMs,
): RefreshOutcome {
  if (state.revoked) return { action: "reject", state };

  if (presentedTokenId === state.currentTokenId) {
    return {
      action: "rotate",
      state: { ...state, previousTokenId: state.currentTokenId, currentTokenId: newTokenId, rotatedAt: now },
    };
  }

  // The token just rotated away from: a concurrent tab may legitimately present
  // it within the grace window. Beyond that, it is a replay -> revoke.
  if (presentedTokenId === state.previousTokenId) {
    if (now - state.rotatedAt <= graceMs) return { action: "tolerate", state };
    return { action: "revoke-family", state: { ...state, revoked: true } };
  }

  // An older/unknown token -> definite reuse -> revoke the family.
  return { action: "revoke-family", state: { ...state, revoked: true } };
}
