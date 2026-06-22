import { describe, it, expect } from "vitest";
import {
  newProject,
  newTrack,
  clipDurationFrames,
  clipEndFrame,
  trackDurationFrames,
  projectDurationFrames,
  clipsOverlap,
  clipAtFrame,
  trim,
  splitClip,
  rippleDelete,
  moveClip,
  setSpeed,
  isReversed,
  sourceFrameAt,
  remapFps,
  addTransition,
  clampTransition,
  transitionOverlapRegion,
  wouldCreateCycle,
  nestClipRefsValid,
  snapFrameToBeats,
  type Clip,
  type Track,
  type VideoProject,
} from "../index";

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: over.id ?? "c1",
    startFrame: 0,
    inFrame: 0,
    outFrame: 100,
    speed: 1,
    ...over,
  };
}

function track(clips: Clip[], over: Partial<Track> = {}): Track {
  return { id: "t1", kind: "video", clips, ...over };
}

describe("model helpers", () => {
  it("newProject defaults stage/fps and computes duration", () => {
    const p = newProject();
    expect(p.stage).toEqual({ width: 1920, height: 1080 });
    expect(p.fps).toBe(30);
    expect(p.durationFrames).toBe(0);
    expect(p.master.gainDb).toBe(0);
  });

  it("newTrack creates an empty track of the requested kind", () => {
    const t = newTrack("audio", "Music");
    expect(t.kind).toBe("audio");
    expect(t.name).toBe("Music");
    expect(t.clips).toEqual([]);
    expect(t.id).toMatch(/^track_/);
  });

  it("clipDurationFrames derives from source span and speed", () => {
    expect(clipDurationFrames(clip({ inFrame: 0, outFrame: 100, speed: 1 }))).toBe(100);
    expect(clipDurationFrames(clip({ inFrame: 0, outFrame: 100, speed: 2 }))).toBe(50);
    // ceil: 100/3 = 33.33 -> 34
    expect(clipDurationFrames(clip({ inFrame: 0, outFrame: 100, speed: 3 }))).toBe(34);
    // 0.5x => doubles length
    expect(clipDurationFrames(clip({ inFrame: 0, outFrame: 100, speed: 0.5 }))).toBe(200);
    // reverse uses magnitude
    expect(clipDurationFrames(clip({ inFrame: 0, outFrame: 100, speed: -2 }))).toBe(50);
    // empty window
    expect(clipDurationFrames(clip({ inFrame: 10, outFrame: 10 }))).toBe(0);
  });

  it("clipEndFrame and track/project duration", () => {
    const a = clip({ id: "a", startFrame: 0, inFrame: 0, outFrame: 50, speed: 1 });
    const b = clip({ id: "b", startFrame: 60, inFrame: 0, outFrame: 40, speed: 1 });
    expect(clipEndFrame(a)).toBe(50);
    expect(clipEndFrame(b)).toBe(100);
    const t = track([a, b]);
    expect(trackDurationFrames(t)).toBe(100);
    const t2 = track([clip({ id: "x", startFrame: 0, outFrame: 30 })], { id: "t2" });
    const p = newProject({ tracks: [t, t2] });
    expect(projectDurationFrames(p)).toBe(100);
  });

  it("clipsOverlap detects half-open overlap", () => {
    const a = clip({ id: "a", startFrame: 0, outFrame: 50 }); // [0,50)
    const b = clip({ id: "b", startFrame: 50, outFrame: 50 }); // empty -> dur 0
    const c = clip({ id: "c", startFrame: 49, outFrame: 50 });
    expect(clipsOverlap(a, c)).toBe(true);
    // abutting at 50 should NOT overlap
    const d = clip({ id: "d", startFrame: 50, inFrame: 0, outFrame: 10 });
    expect(clipsOverlap(a, d)).toBe(false);
    void b;
  });

  it("clipAtFrame returns the covering clip or null", () => {
    const a = clip({ id: "a", startFrame: 0, outFrame: 50 });
    const b = clip({ id: "b", startFrame: 50, inFrame: 0, outFrame: 50 });
    const t = track([a, b]);
    expect(clipAtFrame(t, 0)?.id).toBe("a");
    expect(clipAtFrame(t, 49)?.id).toBe("a");
    expect(clipAtFrame(t, 50)?.id).toBe("b");
    expect(clipAtFrame(t, 1000)).toBeNull();
  });
});

describe("trim", () => {
  it("trims the out edge and keeps duration >= 1", () => {
    const t = track([clip({ inFrame: 0, outFrame: 100 })]);
    const t2 = trim(t, "c1", "out", -40);
    expect(t2.clips[0].outFrame).toBe(60);
    expect(t2).not.toBe(t); // new object
    expect(t.clips[0].outFrame).toBe(100); // input unchanged
    // over-trim clamps to >= 1 source frame
    const t3 = trim(t, "c1", "out", -1000);
    expect(t3.clips[0].outFrame).toBe(1); // inFrame(0)+1
    expect(clipDurationFrames(t3.clips[0])).toBeGreaterThanOrEqual(1);
  });

  it("trims the in edge and shifts startFrame to keep the body put", () => {
    const t = track([clip({ startFrame: 100, inFrame: 0, outFrame: 100 })]);
    const t2 = trim(t, "c1", "in", 30);
    expect(t2.clips[0].inFrame).toBe(30);
    expect(t2.clips[0].startFrame).toBe(130);
  });

  it("in-edge trim never pushes startFrame below 0", () => {
    const t = track([clip({ startFrame: 10, inFrame: 50, outFrame: 100 })]);
    const t2 = trim(t, "c1", "in", -40); // would move start to -30
    expect(t2.clips[0].startFrame).toBe(0);
    expect(t2.clips[0].inFrame).toBeGreaterThanOrEqual(0);
  });

  it("in-edge trim clamps so >= 1 source frame remains", () => {
    const t = track([clip({ startFrame: 0, inFrame: 0, outFrame: 100 })]);
    const t2 = trim(t, "c1", "in", 1000);
    expect(t2.clips[0].inFrame).toBe(99); // outFrame-1
    expect(clipDurationFrames(t2.clips[0])).toBeGreaterThanOrEqual(1);
  });
});

describe("splitClip", () => {
  it("produces two abutting clips that tile the original span (speed 1)", () => {
    const t = track([clip({ startFrame: 0, inFrame: 0, outFrame: 100, speed: 1 })]);
    const t2 = splitClip(t, "c1", 40);
    expect(t2.clips).toHaveLength(2);
    const [left, right] = t2.clips;
    // abutting on the timeline, no gap/overlap
    expect(clipEndFrame(left)).toBe(right.startFrame);
    expect(left.startFrame).toBe(0);
    expect(right.startFrame).toBe(40);
    // combined timeline span equals the original
    expect(clipDurationFrames(left) + clipDurationFrames(right)).toBe(100);
    // source in/out correct: left [0,40), right [40,100)
    expect(left.inFrame).toBe(0);
    expect(left.outFrame).toBe(40);
    expect(right.inFrame).toBe(40);
    expect(right.outFrame).toBe(100);
    // left keeps original id, right gets a new id
    expect(left.id).toBe("c1");
    expect(right.id).not.toBe("c1");
  });

  it("splits correctly under speed 2", () => {
    // duration = ceil(100/2) = 50; cut at timeline frame 20 (local 20)
    const t = track([clip({ startFrame: 0, inFrame: 0, outFrame: 100, speed: 2 })]);
    const t2 = splitClip(t, "c1", 20);
    const [left, right] = t2.clips;
    // source split point = in + round(20*2) = 40
    expect(left.inFrame).toBe(0);
    expect(left.outFrame).toBe(40);
    expect(right.inFrame).toBe(40);
    expect(right.outFrame).toBe(100);
    expect(right.startFrame).toBe(20);
    expect(clipEndFrame(left)).toBe(20); // ceil(40/2)=20 abuts right.start
    // combined source span preserved
    expect(
      left.outFrame - left.inFrame + (right.outFrame - right.inFrame),
    ).toBe(100);
  });

  it("returns the track unchanged when cut is outside the body", () => {
    const t = track([clip({ startFrame: 0, outFrame: 100, speed: 1 })]);
    expect(splitClip(t, "c1", 0)).toBe(t);
    expect(splitClip(t, "c1", 100)).toBe(t);
    expect(splitClip(t, "missing", 50)).toBe(t);
  });
});

describe("rippleDelete", () => {
  it("removes a clip and shifts later clips left to close the gap exactly", () => {
    const a = clip({ id: "a", startFrame: 0, inFrame: 0, outFrame: 30, speed: 1 }); // dur 30
    const b = clip({ id: "b", startFrame: 30, inFrame: 0, outFrame: 20, speed: 1 }); // dur 20
    const c = clip({ id: "c", startFrame: 50, inFrame: 0, outFrame: 40, speed: 1 }); // dur 40
    const t = track([a, b, c]);
    const t2 = rippleDelete(t, "b"); // removes 20 frames
    expect(t2.clips.map((x) => x.id)).toEqual(["a", "c"]);
    expect(t2.clips[0].startFrame).toBe(0); // a untouched
    expect(t2.clips[1].startFrame).toBe(30); // c shifted left by 20
    // no gap between a and c now
    expect(clipEndFrame(t2.clips[0])).toBe(t2.clips[1].startFrame);
    // input unchanged
    expect(t.clips).toHaveLength(3);
  });
});

describe("moveClip and setSpeed", () => {
  it("moveClip clamps to >= 0", () => {
    const t = track([clip({ startFrame: 10 })]);
    expect(moveClip(t, "c1", 200).clips[0].startFrame).toBe(200);
    expect(moveClip(t, "c1", -50).clips[0].startFrame).toBe(0);
  });

  it("setSpeed changes derived duration and clamps range", () => {
    const c = clip({ inFrame: 0, outFrame: 100 });
    expect(clipDurationFrames(setSpeed(c, 2))).toBe(50);
    expect(clipDurationFrames(setSpeed(c, 0.5))).toBe(200);
    // clamp magnitude
    expect(setSpeed(c, 1000).speed).toBe(100);
    expect(setSpeed(c, 0.001).speed).toBe(0.1);
    // 0 coerced to 1
    expect(setSpeed(c, 0).speed).toBe(1);
    // negative => reverse, magnitude clamped
    const r = setSpeed(c, -4);
    expect(r.speed).toBe(-4);
    expect(isReversed(r)).toBe(true);
    expect(isReversed(c)).toBe(false);
  });
});

describe("sourceFrameAt and remapFps", () => {
  it("maps forward at speed 1", () => {
    const c = clip({ startFrame: 100, inFrame: 10, outFrame: 60, speed: 1 });
    expect(sourceFrameAt(c, 100)).toBe(10); // first frame
    expect(sourceFrameAt(c, 105)).toBe(15);
    expect(sourceFrameAt(c, 149)).toBe(59); // last frame (dur 50)
  });

  it("maps forward at speed 2", () => {
    const c = clip({ startFrame: 0, inFrame: 0, outFrame: 100, speed: 2 });
    expect(sourceFrameAt(c, 0)).toBe(0);
    expect(sourceFrameAt(c, 10)).toBe(20);
    expect(sourceFrameAt(c, 49)).toBe(98);
  });

  it("maps reversed playback", () => {
    const c = clip({ startFrame: 0, inFrame: 0, outFrame: 100, speed: -1 });
    // first timeline frame reads last source frame
    expect(sourceFrameAt(c, 0)).toBe(99);
    expect(sourceFrameAt(c, 1)).toBe(98);
    expect(sourceFrameAt(c, 99)).toBe(0);
  });

  it("returns null outside the clip window", () => {
    const c = clip({ startFrame: 10, inFrame: 0, outFrame: 50, speed: 1 });
    expect(sourceFrameAt(c, 9)).toBeNull();
    expect(sourceFrameAt(c, 60)).toBeNull(); // dur 50 -> [10,60)
    expect(sourceFrameAt(c, 59)).not.toBeNull();
  });

  it("remapFps converts frame indices, frame 0 fixed", () => {
    expect(remapFps(0, 24, 30)).toBe(0);
    expect(remapFps(24, 24, 30)).toBe(30);
    expect(remapFps(30, 30, 30)).toBe(30);
    expect(remapFps(10, 30, 24)).toBe(8); // round(10*24/30)=8
  });
});

describe("transitions", () => {
  it("clampTransition bounds duration to clip length and >= 1", () => {
    const c = clip({ inFrame: 0, outFrame: 100, speed: 1 }); // dur 100
    expect(clampTransition({ type: "fade", durationFrames: 30 }, c).durationFrames).toBe(30);
    expect(clampTransition({ type: "fade", durationFrames: 500 }, c).durationFrames).toBe(100);
    expect(clampTransition({ type: "fade", durationFrames: 0 }, c).durationFrames).toBe(1);
  });

  it("addTransition attaches a clamped transition to the requested edge", () => {
    const t = track([clip({ inFrame: 0, outFrame: 100, speed: 1 })]);
    const t2 = addTransition(t, "c1", "out", { type: "crossDissolve", durationFrames: 999 });
    expect(t2.clips[0].transitionOut?.type).toBe("crossDissolve");
    expect(t2.clips[0].transitionOut?.durationFrames).toBe(100);
    expect(t.clips[0].transitionOut).toBeUndefined(); // input unchanged
    const t3 = addTransition(t, "c1", "in", { type: "fade", durationFrames: 10 });
    expect(t3.clips[0].transitionIn?.durationFrames).toBe(10);
  });

  it("transitionOverlapRegion returns the overlap range or null", () => {
    const a = clip({
      id: "a",
      startFrame: 0,
      inFrame: 0,
      outFrame: 50,
      speed: 1,
      transitionOut: { type: "crossDissolve", durationFrames: 10 },
    });
    const b = clip({ id: "b", startFrame: 50, inFrame: 0, outFrame: 50, speed: 1 });
    const region = transitionOverlapRegion(a, b);
    expect(region).toEqual({ startFrame: 40, endFrame: 50 });
    // no transition configured -> null
    const a2 = clip({ id: "a", startFrame: 0, outFrame: 50 });
    expect(transitionOverlapRegion(a2, b)).toBeNull();
  });
});

describe("nested sequences", () => {
  const proj = (id: string, refs: string[]): VideoProject =>
    newProject({
      tracks: [
        {
          id: `t_${id}`,
          kind: "video",
          clips: refs.map((r, i) => clip({ id: `${id}_${i}`, sequenceId: r, outFrame: 10 })),
        },
      ],
    });

  it("detects a direct self-cycle", () => {
    const map: Record<string, VideoProject> = {};
    const resolve = (id: string) => map[id] ?? null;
    const self = proj("A", []);
    map["A"] = self;
    expect(wouldCreateCycle(self, "A", resolve, "A")).toBe(true);
  });

  it("detects a transitive cycle", () => {
    const map: Record<string, VideoProject> = {};
    const resolve = (id: string) => map[id] ?? null;
    // A -> B -> C, and we ask: can A reference C? C -> A would be a cycle.
    map["A"] = proj("A", ["B"]);
    map["B"] = proj("B", ["C"]);
    map["C"] = proj("C", ["A"]); // C refers back to A
    expect(wouldCreateCycle(map["A"], "C", resolve, "A")).toBe(true);
  });

  it("allows acyclic nesting", () => {
    const map: Record<string, VideoProject> = {};
    const resolve = (id: string) => map[id] ?? null;
    map["A"] = proj("A", []);
    map["B"] = proj("B", []);
    expect(wouldCreateCycle(map["A"], "B", resolve, "A")).toBe(false);
  });

  it("nestClipRefsValid fails on unresolved refs and passes when acyclic", () => {
    const map: Record<string, VideoProject> = {};
    const resolve = (id: string) => map[id] ?? null;
    map["B"] = proj("B", []);
    const a = proj("A", ["B"]);
    expect(nestClipRefsValid(a, resolve)).toBe(true);
    const bad = proj("A", ["MISSING"]);
    expect(nestClipRefsValid(bad, resolve)).toBe(false);
  });

  it("nestClipRefsValid detects a cycle in the graph", () => {
    const map: Record<string, VideoProject> = {};
    const resolve = (id: string) => map[id] ?? null;
    map["A"] = proj("A", ["B"]);
    map["B"] = proj("B", ["A"]);
    expect(nestClipRefsValid(map["A"], resolve)).toBe(false);
  });
});

describe("snapFrameToBeats", () => {
  const beats = [0, 24, 48, 72, 96];
  it("snaps to the nearest beat within tolerance", () => {
    expect(snapFrameToBeats(26, beats, 3)).toBe(24);
    expect(snapFrameToBeats(70, beats, 3)).toBe(72);
  });
  it("leaves the frame alone when no beat is within tolerance", () => {
    expect(snapFrameToBeats(36, beats, 3)).toBe(36); // nearest beats are 12 away
  });
  it("picks the closer of two beats", () => {
    expect(snapFrameToBeats(13, beats, 20)).toBe(24); // 13->24 (11) vs ->0 (13)
  });
  it("tolerance 0 snaps only when exactly on a beat", () => {
    expect(snapFrameToBeats(48, beats, 0)).toBe(48);
    expect(snapFrameToBeats(49, beats, 0)).toBe(49);
  });
  it("returns frame unchanged with no beats", () => {
    expect(snapFrameToBeats(50, [], 100)).toBe(50);
  });
});
