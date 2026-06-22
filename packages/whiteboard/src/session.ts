// Facilitation session accounting: countdown timer (FR-7) and dot voting
// (FR-8). Pure value transforms only: no network, no Date.now. Callers pass an
// explicit `now` (epoch ms) so timer math is deterministic and testable. All
// helpers return new objects and never mutate their inputs.

export interface TimerState {
  running: boolean;
  durationMs: number;
  startedAt?: number; // epoch ms the current run segment started
  elapsedBeforeMs?: number; // accumulated elapsed across prior segments
}

export interface Vote {
  nodeId: string;
  userId: string;
}

export interface VoteSession {
  id: string;
  open: boolean;
  budgetPerUser: number;
  anonymous: boolean;
  revealed: boolean;
  votes: Vote[];
}

export interface WhiteboardMeta {
  kind: "whiteboard";
  grid: { size: number; snap: boolean };
  vote?: VoteSession;
  timer?: TimerState;
}

// --- timer (FR-7) -----------------------------------------------------------

/** Start (or resume) the timer at `now`. No-op shape change if already running. */
export function startTimer(s: TimerState, now: number): TimerState {
  if (s.running) return { ...s };
  return {
    ...s,
    running: true,
    startedAt: now,
    elapsedBeforeMs: s.elapsedBeforeMs ?? 0,
  };
}

/** Pause the timer at `now`, folding the running segment into elapsedBeforeMs. */
export function pauseTimer(s: TimerState, now: number): TimerState {
  if (!s.running) return { ...s };
  const segment = s.startedAt !== undefined ? Math.max(0, now - s.startedAt) : 0;
  return {
    ...s,
    running: false,
    startedAt: undefined,
    elapsedBeforeMs: (s.elapsedBeforeMs ?? 0) + segment,
  };
}

/** Reset to a stopped timer with zero elapsed, preserving duration. */
export function resetTimer(s: TimerState): TimerState {
  return {
    running: false,
    durationMs: s.durationMs,
    startedAt: undefined,
    elapsedBeforeMs: 0,
  };
}

/** Total elapsed milliseconds as of `now`. */
export function timerElapsedMs(s: TimerState, now: number): number {
  const before = s.elapsedBeforeMs ?? 0;
  if (s.running && s.startedAt !== undefined) {
    return before + Math.max(0, now - s.startedAt);
  }
  return before;
}

/** Remaining milliseconds, clamped to >= 0. */
export function timerRemainingMs(s: TimerState, now: number): number {
  return Math.max(0, s.durationMs - timerElapsedMs(s, now));
}

// --- voting (FR-8) ----------------------------------------------------------

/** How many votes a user has spent in this session. */
function votesByUser(session: VoteSession, userId: string): number {
  let count = 0;
  for (const v of session.votes) if (v.userId === userId) count++;
  return count;
}

/** Remaining vote budget for a user (never negative). */
export function remainingBudget(session: VoteSession, userId: string): number {
  return Math.max(0, session.budgetPerUser - votesByUser(session, userId));
}

/**
 * Cast (or toggle off) a vote. Returns a new session.
 *  - If the session is closed, the session is returned unchanged.
 *  - If the same (nodeId,userId) vote already exists, it is removed (toggle).
 *  - Otherwise the vote is added unless the user is over budget, in which case
 *    the session is returned unchanged.
 */
export function castVote(session: VoteSession, nodeId: string, userId: string): VoteSession {
  if (!session.open) return { ...session, votes: [...session.votes] };

  const existingIdx = session.votes.findIndex(
    (v) => v.nodeId === nodeId && v.userId === userId,
  );
  if (existingIdx >= 0) {
    const votes = session.votes.filter((_, i) => i !== existingIdx);
    return { ...session, votes };
  }

  if (remainingBudget(session, userId) <= 0) {
    return { ...session, votes: [...session.votes] };
  }
  return { ...session, votes: [...session.votes, { nodeId, userId }] };
}

/** Tally votes per node id. */
export function tallyVotes(session: VoteSession): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const v of session.votes) {
    tally[v.nodeId] = (tally[v.nodeId] ?? 0) + 1;
  }
  return tally;
}
