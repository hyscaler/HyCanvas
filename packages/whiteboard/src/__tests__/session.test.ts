import { describe, it, expect } from "vitest";
import {
  startTimer,
  pauseTimer,
  resetTimer,
  timerElapsedMs,
  timerRemainingMs,
  castVote,
  remainingBudget,
  tallyVotes,
  addSavedView,
  removeSavedView,
  stepSavedView,
  type TimerState,
  type VoteSession,
  type SavedView,
} from "../session";

describe("timer", () => {
  const base: TimerState = { running: false, durationMs: 60_000 };

  it("starts at the given now and remaining decreases with time", () => {
    const started = startTimer(base, 1000);
    expect(started.running).toBe(true);
    expect(started.startedAt).toBe(1000);
    expect(timerRemainingMs(started, 1000)).toBe(60_000);
    expect(timerRemainingMs(started, 11_000)).toBe(50_000); // 10s elapsed
  });

  it("pause/resume accumulates elapsed across segments", () => {
    let t = startTimer(base, 0);
    t = pauseTimer(t, 10_000); // 10s in segment 1
    expect(t.running).toBe(false);
    expect(timerElapsedMs(t, 999_999)).toBe(10_000); // paused: frozen
    t = startTimer(t, 20_000); // resume later
    expect(timerElapsedMs(t, 25_000)).toBe(15_000); // 10s + 5s
    expect(timerRemainingMs(t, 25_000)).toBe(45_000);
  });

  it("clamps remaining at zero when overrun", () => {
    const t = startTimer(base, 0);
    expect(timerRemainingMs(t, 120_000)).toBe(0);
  });

  it("reset clears elapsed and stops, preserving duration", () => {
    let t = startTimer(base, 0);
    t = pauseTimer(t, 5_000);
    const r = resetTimer(t);
    expect(r.running).toBe(false);
    expect(r.elapsedBeforeMs).toBe(0);
    expect(r.durationMs).toBe(60_000);
    expect(timerRemainingMs(r, 999)).toBe(60_000);
  });

  it("does not mutate the input state", () => {
    const frozen = JSON.stringify(base);
    startTimer(base, 1234);
    expect(JSON.stringify(base)).toBe(frozen);
  });

  it("starting an already running timer is idempotent on the segment", () => {
    const t = startTimer(base, 100);
    const again = startTimer(t, 5000);
    expect(again.startedAt).toBe(100);
  });
});

describe("voting", () => {
  const session = (over: Partial<VoteSession> = {}): VoteSession => ({
    id: "v1",
    open: true,
    budgetPerUser: 2,
    anonymous: false,
    revealed: false,
    votes: [],
    ...over,
  });

  it("casts a vote and decrements remaining budget", () => {
    const s = castVote(session(), "n1", "u1");
    expect(s.votes.length).toBe(1);
    expect(remainingBudget(s, "u1")).toBe(1);
  });

  it("enforces the per-user budget", () => {
    let s = session({ budgetPerUser: 2 });
    s = castVote(s, "n1", "u1");
    s = castVote(s, "n2", "u1");
    expect(remainingBudget(s, "u1")).toBe(0);
    const blocked = castVote(s, "n3", "u1");
    expect(blocked.votes.length).toBe(2); // rejected, unchanged count
  });

  it("toggles off an identical vote", () => {
    let s = castVote(session(), "n1", "u1");
    expect(s.votes.length).toBe(1);
    s = castVote(s, "n1", "u1");
    expect(s.votes.length).toBe(0);
    expect(remainingBudget(s, "u1")).toBe(2);
  });

  it("rejects votes on a closed session", () => {
    const s = castVote(session({ open: false }), "n1", "u1");
    expect(s.votes.length).toBe(0);
  });

  it("tallies votes per node", () => {
    let s = session({ budgetPerUser: 5 });
    s = castVote(s, "n1", "u1");
    s = castVote(s, "n1", "u2");
    s = castVote(s, "n2", "u1");
    expect(tallyVotes(s)).toEqual({ n1: 2, n2: 1 });
  });

  it("tracks budgets independently per user", () => {
    let s = session({ budgetPerUser: 1 });
    s = castVote(s, "n1", "u1");
    expect(remainingBudget(s, "u1")).toBe(0);
    expect(remainingBudget(s, "u2")).toBe(1);
    s = castVote(s, "n1", "u2");
    expect(s.votes.length).toBe(2);
  });

  it("carries the anonymity flag through unchanged", () => {
    const s = castVote(session({ anonymous: true }), "n1", "u1");
    expect(s.anonymous).toBe(true);
  });

  it("does not mutate the input session", () => {
    const s = session();
    const frozen = JSON.stringify(s);
    castVote(s, "n1", "u1");
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe("saved views (FR-3)", () => {
  const v = (id: string, name = id): SavedView => ({ id, name, viewport: { zoom: 1, panX: 0, panY: 0 } });

  it("adds, replaces by id, and removes without mutating the input", () => {
    const a = [v("a")];
    const frozen = JSON.stringify(a);
    const added = addSavedView(a, v("b"));
    expect(added.map((x) => x.id)).toEqual(["a", "b"]);
    // Re-saving id "a" replaces it in place (keeps a single entry).
    const replaced = addSavedView(added, { id: "a", name: "renamed", viewport: { zoom: 2, panX: 5, panY: 5 } });
    expect(replaced.filter((x) => x.id === "a")).toHaveLength(1);
    expect(replaced.find((x) => x.id === "a")?.name).toBe("renamed");
    expect(removeSavedView(replaced, "a").map((x) => x.id)).toEqual(["b"]);
    expect(JSON.stringify(a)).toBe(frozen); // input untouched
    expect(addSavedView(undefined, v("z")).map((x) => x.id)).toEqual(["z"]);
  });

  it("steps the agenda forward/backward with wraparound", () => {
    const list = [v("a"), v("b"), v("c")];
    expect(stepSavedView(list, "a", 1)?.id).toBe("b");
    expect(stepSavedView(list, "c", 1)?.id).toBe("a"); // wrap forward
    expect(stepSavedView(list, "a", -1)?.id).toBe("c"); // wrap backward
    expect(stepSavedView(list, null, 1)?.id).toBe("a"); // unknown -> first
    expect(stepSavedView(list, "gone", -1)?.id).toBe("c"); // unknown -> last on reverse
    expect(stepSavedView([], "a", 1)).toBeNull();
    expect(stepSavedView(undefined, null, 1)).toBeNull();
  });
});
