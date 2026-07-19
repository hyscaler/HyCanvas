import { describe, it, expect } from "vitest";
import {
  gainAtFrame,
  dbToGain,
  gainToDb,
  mixGains,
  soloActive,
  isAudible,
  effectiveClipGain,
  msToFrames,
  voiceActivityFromCues,
  solveDucking,
} from "../index";
import type { AudioMaster, Clip, Track } from "@hc/timeline";

function clip(over: Partial<Clip> = {}): Clip {
  return { id: "c1", startFrame: 0, inFrame: 0, outFrame: 100, speed: 1, ...over };
}
function track(over: Partial<Track> = {}): Track {
  return { id: "t1", kind: "audio", clips: [], ...over };
}

describe("fade.gainAtFrame", () => {
  it("is 1 across the clip when no fades configured", () => {
    const c = clip();
    expect(gainAtFrame(c, 0, 100)).toBe(1);
    expect(gainAtFrame(c, 50, 100)).toBe(1);
    expect(gainAtFrame(c, 99, 100)).toBe(1);
  });

  it("ramps fade-in 0..1 and reaches 1 at the end of the ramp", () => {
    const c = clip({ fadeInFrames: 10 });
    expect(gainAtFrame(c, 0, 100)).toBe(0);
    expect(gainAtFrame(c, 5, 100)).toBeCloseTo(0.5, 6);
    expect(gainAtFrame(c, 10, 100)).toBe(1); // ramp complete
    expect(gainAtFrame(c, 50, 100)).toBe(1);
  });

  it("ramps fade-out 1..0 reaching 0 at the last frame", () => {
    const c = clip({ fadeOutFrames: 10 });
    const dur = 100;
    expect(gainAtFrame(c, 50, dur)).toBe(1);
    // last frame index is 99 -> fromEnd 0 -> gain 0
    expect(gainAtFrame(c, 99, dur)).toBe(0);
    // 5 frames from the end
    expect(gainAtFrame(c, 94, dur)).toBeCloseTo(0.5, 6);
    // just as the fade-out region begins (fromEnd === fadeOut) gain still ~1
    expect(gainAtFrame(c, 89, dur)).toBe(1); // fromEnd = 10, not < 10
  });

  it("returns 0 outside the clip window", () => {
    const c = clip({ fadeInFrames: 5 });
    expect(gainAtFrame(c, -1, 100)).toBe(0);
    expect(gainAtFrame(c, 100, 100)).toBe(0);
  });

  it("overlapping fades take the lower ramp", () => {
    const c = clip({ fadeInFrames: 8, fadeOutFrames: 8 });
    const dur = 10; // ramps overlap
    // at frame 5: fade-in gives 5/8=0.625; fade-out fromEnd=4 -> 4/8=0.5 -> min 0.5
    expect(gainAtFrame(c, 5, dur)).toBeCloseTo(0.5, 6);
  });
});

describe("mix gain math", () => {
  it("dbToGain/gainToDb round-trip", () => {
    expect(dbToGain(0)).toBeCloseTo(1, 9);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
    for (const db of [-20, -6, 0, 3]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 6);
    }
    expect(gainToDb(0)).toBe(-Infinity);
    expect(gainToDb(1)).toBeCloseTo(0, 9);
  });

  it("mixGains multiplies, floors at 0, and passes boosts above unity", () => {
    expect(mixGains(0.5, 0.5)).toBeCloseTo(0.25, 9);
    // Boosts pass through so the preview matches the server export mix.
    expect(mixGains(2, 2)).toBe(4);
    expect(mixGains(1, -0.5)).toBe(0); // floored
    expect(mixGains()).toBe(1);
  });

  it("soloActive and isAudible obey mute/solo", () => {
    const a = track({ id: "a" });
    const b = track({ id: "b" });
    expect(soloActive([a, b])).toBe(false);
    // mute removes audibility
    const muted = track({ id: "m", muted: true });
    expect(isAudible(muted, [a, b, muted])).toBe(false);
    // when solo active, only soloed tracks audible
    const soloed = track({ id: "s", solo: true });
    const all = [a, b, soloed];
    expect(soloActive(all)).toBe(true);
    expect(isAudible(soloed, all)).toBe(true);
    expect(isAudible(a, all)).toBe(false); // non-soloed muted by solo
  });

  it("effectiveClipGain combines clip+track+master and respects solo/mute", () => {
    const master: AudioMaster = { gainDb: 0 };
    const t = track({ gainDb: -6 });
    const c = clip({ audioGainDb: -6 });
    // -6 dB clip * -6 dB track = ~0.501 * ~0.501 = ~0.251
    expect(effectiveClipGain(c, t, master, [t])).toBeCloseTo(0.251, 2);
    // muted track -> 0
    const tm = track({ gainDb: 0, muted: true });
    expect(effectiveClipGain(c, tm, master, [tm])).toBe(0);
    // solo elsewhere mutes this track
    const other = track({ id: "other", solo: true });
    expect(effectiveClipGain(c, t, master, [t, other])).toBe(0);
    // master gain folds in; a +6 dB boost is audible, matching the export
    const loudMaster: AudioMaster = { gainDb: 6 };
    const plain = track({ gainDb: 0 });
    const plainClip = clip({ audioGainDb: 0 });
    expect(effectiveClipGain(plainClip, plain, loudMaster, [plain])).toBeCloseTo(Math.pow(10, 6 / 20), 9);
    // a master cut folds in unclamped
    const quietMaster: AudioMaster = { gainDb: -6 };
    expect(effectiveClipGain(plainClip, plain, quietMaster, [plain])).toBeCloseTo(
      dbToGain(-6),
      3,
    );
  });
});

describe("ducking solver", () => {
  const fps = 30;
  const master: AudioMaster = {
    gainDb: 0,
    ducking: {
      musicTrackId: "music",
      voiceTrackId: "voice",
      amountDb: -12,
      attackMs: 100, // 3 frames @30
      releaseMs: 200, // 6 frames @30
    },
  };

  it("msToFrames converts at fps", () => {
    expect(msToFrames(100, 30)).toBe(3);
    expect(msToFrames(200, 30)).toBe(6);
    expect(msToFrames(0, 30)).toBe(0);
  });

  it("returns a flat 0 dB curve with no config or no activity", () => {
    expect(solveDucking({ gainDb: 0 }, [], 300, fps)).toEqual([
      { frame: 0, musicGainDb: 0 },
    ]);
    expect(solveDucking(master, [], 300, fps)).toEqual([{ frame: 0, musicGainDb: 0 }]);
  });

  it("ramps down to amountDb during voice and back to 0 after", () => {
    const pts = solveDucking(master, [{ startFrame: 30, endFrame: 90 }], 300, fps);
    // rest at start
    expect(pts[0]).toEqual({ frame: 0, musicGainDb: 0 });
    // hits full duck at attack completion (30 + 3 = 33)
    const full = pts.find((p) => p.musicGainDb === -12);
    expect(full).toBeDefined();
    const attackStart = pts.find((p) => p.frame === 30);
    expect(attackStart?.musicGainDb).toBe(0); // begins attack at rest
    const attackEnd = pts.find((p) => p.frame === 33);
    expect(attackEnd?.musicGainDb).toBe(-12);
    // holds at -12 until voice ends at 90
    const hold = pts.find((p) => p.frame === 90);
    expect(hold?.musicGainDb).toBe(-12);
    // released back to 0 at 90 + 6 = 96
    const released = pts.find((p) => p.frame === 96);
    expect(released?.musicGainDb).toBe(0);
    // sorted ascending by frame
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].frame).toBeGreaterThanOrEqual(pts[i - 1].frame);
    }
  });

  it("keeps music ducked between windows closer than the release time", () => {
    // two windows 2 frames apart (< release of 6): no full release between them
    const pts = solveDucking(
      master,
      [
        { startFrame: 30, endFrame: 60 },
        { startFrame: 62, endFrame: 90 },
      ],
      300,
      fps,
    );
    // there should be no point returning to 0 dB strictly between frame 60 and 90
    const midRest = pts.find((p) => p.frame > 60 && p.frame < 90 && p.musicGainDb === 0);
    expect(midRest).toBeUndefined();
    // and it eventually releases to 0 after the last window
    const finalRest = pts.find((p) => p.frame === 96 && p.musicGainDb === 0);
    expect(finalRest).toBeDefined();
  });

  it("voiceActivityFromCues merges overlapping/touching cues", () => {
    const cues = [
      { startFrame: 10, endFrame: 20 },
      { startFrame: 20, endFrame: 30 }, // touches previous
      { startFrame: 100, endFrame: 110 },
      { startFrame: 5, endFrame: 8 }, // out of order, separate
    ];
    expect(voiceActivityFromCues(cues)).toEqual([
      { startFrame: 5, endFrame: 8 },
      { startFrame: 10, endFrame: 30 },
      { startFrame: 100, endFrame: 110 },
    ]);
  });
});
