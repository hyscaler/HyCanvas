// Pure-logic tests for the video editor's preview/export math: caption
// serialization, transition effects, ducking interpolation, and the per-clip
// mix gain. No DOM, no media elements.

import { describe, it, expect } from "vitest";
import { newProject, newTrack, type Clip, type Track } from "@hc/timeline";
import { cueAt, formatCaptionTime, toSrt, toVtt, withCues, addCaptionTrack, removeCaptionTrack, setCaptionLang } from "./captions";
import {
  activeClipsAt,
  activeTitleClipsAt,
  applyEasing,
  applyMotionPreset,
  setTrackEasing,
  clipGainAt,
  colorFilter,
  colorIsNeutral,
  COLOR_PRESETS,
  duckDbAtFrame,
  evalKeyframes,
  gainEnvelopeDb,
  titleAnimAt,
  transitionFxAt,
  upsertPoseKeyframe,
  visibleVideoClipsAt,
  xfadeWindow,
} from "./compositor";
import { captionStyleOf, withCaptionStyle } from "./captions";

function clip(partial: Partial<Clip>): Clip {
  return { id: "c1", startFrame: 0, inFrame: 0, outFrame: 90, speed: 1, assetId: "a1", ...partial };
}

describe("captions", () => {
  const cues = [
    { id: "q1", startFrame: 0, endFrame: 60, text: "Hello" },
    { id: "q2", startFrame: 60, endFrame: 150, text: "World\ntwo lines" },
  ];

  it("formats SRT/VTT timestamps at the project fps", () => {
    expect(formatCaptionTime(0, 30, ",")).toBe("00:00:00,000");
    expect(formatCaptionTime(90, 30, ",")).toBe("00:00:03,000");
    expect(formatCaptionTime(45, 30, ".")).toBe("00:00:01.500");
    // An hour-plus timestamp carries into the hours field.
    expect(formatCaptionTime(30 * 3661, 30, ",")).toBe("01:01:01,000");
  });

  it("serializes SRT with indices and comma milliseconds", () => {
    const srt = toSrt(cues, 30);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:02,000\nHello");
    expect(srt).toContain("2\n00:00:02,000 --> 00:00:05,000\nWorld\ntwo lines");
  });

  it("serializes VTT with a header and dot milliseconds", () => {
    const vtt = toVtt(cues, 30);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:02.000\nHello");
  });

  it("cueAt finds the covering cue; end frame is exclusive", () => {
    expect(cueAt(cues, 0)?.id).toBe("q1");
    expect(cueAt(cues, 59)?.id).toBe("q1");
    expect(cueAt(cues, 60)?.id).toBe("q2");
    expect(cueAt(cues, 150)).toBeNull();
    expect(cueAt(undefined, 0)).toBeNull();
  });

  it("withCues creates the caption track once and keeps cues sorted", () => {
    const p1 = newProject({});
    const p2 = withCues(p1, [cues[1], cues[0]]);
    expect(p2.captions).toHaveLength(1);
    expect(p2.captions?.[0].cues.map((c) => c.id)).toEqual(["q1", "q2"]);
    const p3 = withCues(p2, []);
    expect(p3.captions).toHaveLength(1);
  });

  it("supports multiple language tracks addressed by id (P7.2)", () => {
    const withEn = withCues(newProject({}), [cues[0]]); // creates track 0
    const enId = withEn.captions![0].id;
    const { project: withEs, track: es } = addCaptionTrack(withEn, "es");
    expect(withEs.captions).toHaveLength(2);
    // Editing the es track by id leaves the en track's cues untouched.
    const edited = withCues(withEs, [cues[0], cues[1]], es.id);
    expect(edited.captions?.find((t) => t.id === enId)?.cues).toHaveLength(1);
    expect(edited.captions?.find((t) => t.id === es.id)?.cues).toHaveLength(2);
    // Rename by id, then remove by id.
    const renamed = setCaptionLang(edited, es.id, "es-MX");
    expect(renamed.captions?.find((t) => t.id === es.id)?.lang).toBe("es-MX");
    const removed = removeCaptionTrack(renamed, es.id);
    expect(removed.captions).toHaveLength(1);
    expect(removed.captions?.[0].id).toBe(enId);
  });
});

describe("evalKeyframes", () => {
  it("interpolates linearly, clamps opacity, holds beyond the ends", () => {
    const tracks = [
      { property: "opacity", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] },
      { property: "scale", keyframes: [{ frame: 0, value: 1 }, { frame: 20, value: 2 }] },
      { property: "dx", keyframes: [{ frame: 5, value: -0.5 }] },
    ];
    expect(evalKeyframes(tracks, 5).opacity).toBeCloseTo(0.5, 5);
    expect(evalKeyframes(tracks, 999).opacity).toBe(1);
    expect(evalKeyframes(tracks, 10).scale).toBeCloseTo(1.5, 5);
    expect(evalKeyframes(tracks, 0).dx).toBe(-0.5); // single keyframe holds
    expect(evalKeyframes(undefined, 3)).toEqual({ opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0 });
    // Non-numeric values are ignored, unknown properties too.
    const junk = [
      { property: "opacity", keyframes: [{ frame: 0, value: "x" }] },
      { property: "rotate", keyframes: [{ frame: 0, value: 1 }] },
    ];
    expect(evalKeyframes(junk, 0)).toEqual({ opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0 });
  });
});

describe("xfade overlap", () => {
  function xfadeTrack(): Track {
    const left = clip({ id: "L", startFrame: 0, inFrame: 0, outFrame: 60, transitionOut: { type: "crossDissolve", durationFrames: 12 } });
    const right = clip({ id: "R", startFrame: 60, inFrame: 0, outFrame: 60, transitionIn: { type: "crossDissolve", durationFrames: 12 } });
    return { ...newTrack("video", "V1"), clips: [left, right] };
  }

  it("xfadeWindow needs crossDissolve on BOTH edges of an exact cut", () => {
    const t = xfadeTrack();
    expect(xfadeWindow(t, t.clips[0])).toBe(12);
    const gap: Track = { ...t, clips: [t.clips[0], { ...t.clips[1], startFrame: 61 }] };
    expect(xfadeWindow(gap, gap.clips[0])).toBe(0);
    const fadeOnly: Track = { ...t, clips: [{ ...t.clips[0], transitionOut: { type: "fade", durationFrames: 12 } }, t.clips[1]] };
    expect(xfadeWindow(fadeOnly, fadeOnly.clips[0])).toBe(0);
  });

  it("emits the left clip's tail under the incoming clip inside the window", () => {
    const p = { ...newProject({ tracks: [xfadeTrack()] }), durationFrames: 200 };
    const inside = visibleVideoClipsAt(p, 66); // 6 frames past the cut
    expect(inside.map((a) => `${a.clip.id}${a.xfadeTail ? ":tail" : ""}`)).toEqual(["L:tail", "R"]);
    // Tail keeps rolling source: out 60 + 6 extra = 66.
    expect(inside[0].sourceFrame).toBe(66);
    // The left clip inside its own span carries the suppression flag.
    const before = visibleVideoClipsAt(p, 55);
    expect(before[0].clip.id).toBe("L");
    expect(before[0].suppressOutFade).toBe(true);
    // Past the window, only the right clip remains.
    expect(visibleVideoClipsAt(p, 80).map((a) => a.clip.id)).toEqual(["R"]);
  });
});

describe("nested sequences", () => {
  it("expands sequence clips into child actives with folded gain", () => {
    const childVideo: Track = { ...newTrack("video", "CV"), clips: [clip({ id: "cv1", outFrame: 120 })] };
    const childAudio: Track = { ...newTrack("audio", "CA"), gainDb: -6, clips: [clip({ id: "ca1", outFrame: 120, audioGainDb: 0 })] };
    const child = { ...newProject({ tracks: [childVideo, childAudio] }), durationFrames: 120 };
    const parentTrack: Track = {
      ...newTrack("video", "PV"),
      clips: [{ id: "seqclip", sequenceId: "s1", startFrame: 50, inFrame: 0, outFrame: 120, speed: 1, audioGainDb: -6 }],
    };
    const p = { ...newProject({ tracks: [parentTrack] }), durationFrames: 300 };
    const resolveSequence = (id: string) => (id === "s1" ? child : null);
    const actives = activeClipsAt(p, 60, { resolveSequence });
    expect(actives.map((a) => a.clip.id)).toEqual(["cv1", "ca1"]);
    expect(actives[0].fromSequence).toBe(true);
    expect(actives[0].localFrame).toBe(10); // child frame = 60 - 50
    // Gain fold: child track -6 dB x parent clip -6 dB = 10^(-12/20).
    expect(actives[1].mixGain).toBeCloseTo(Math.pow(10, -12 / 20), 4);
    // Without a resolver the sequence clip passes through unexpanded.
    const raw = activeClipsAt(p, 60);
    expect(raw[0].clip.id).toBe("seqclip");
  });
});

describe("gain envelope", () => {
  it("keyframed gain (dB) folds into clipGainAt", () => {
    const c = clip({ keyframes: [{ property: "gain", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: -20 }] }] });
    const t: Track = { ...newTrack("audio", "A1"), clips: [c] };
    const p = { ...newProject({ tracks: [t] }), durationFrames: 300 };
    expect(gainEnvelopeDb(c, 0)).toBe(0);
    expect(gainEnvelopeDb(c, 5)).toBeCloseTo(-10, 5);
    expect(clipGainAt(p, t, c, 10)).toBeCloseTo(Math.pow(10, -20 / 20), 5);
    expect(clipGainAt(p, t, c, 0)).toBeCloseTo(1, 5);
  });
});

describe("upsertPoseKeyframe", () => {
  it("creates the property track on first write", () => {
    const out = upsertPoseKeyframe(undefined, "dx", 10, 0.25);
    expect(out).toEqual([{ property: "dx", keyframes: [{ frame: 10, value: 0.25 }] }]);
  });

  it("static-pose rule: a single keyframe is updated in place, keeping its frame", () => {
    const one = upsertPoseKeyframe(undefined, "scale", 0, 1.5);
    const moved = upsertPoseKeyframe(one, "scale", 40, 2);
    expect(moved).toEqual([{ property: "scale", keyframes: [{ frame: 0, value: 2 }] }]);
  });

  it("with an animation curve (2+ keyframes) the write lands at the given frame", () => {
    const curve = [{ property: "dx", keyframes: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] }];
    const out = upsertPoseKeyframe(curve, "dx", 15, 0.5);
    expect(out[0].keyframes.map((k) => k.frame)).toEqual([0, 15, 30]);
    // Writing at an existing frame replaces that keyframe.
    const replaced = upsertPoseKeyframe(out, "dx", 15, 0.75);
    expect(replaced[0].keyframes).toHaveLength(3);
    expect(replaced[0].keyframes[1]).toEqual({ frame: 15, value: 0.75 });
  });

  it("leaves other property tracks untouched", () => {
    const both = upsertPoseKeyframe(upsertPoseKeyframe(undefined, "dx", 0, 0.1), "dy", 0, -0.1);
    const out = upsertPoseKeyframe(both, "dx", 0, 0.2);
    expect(out.find((t) => t.property === "dy")?.keyframes[0].value).toBe(-0.1);
    expect(out.find((t) => t.property === "dx")?.keyframes[0].value).toBe(0.2);
  });
});

describe("caption style", () => {
  it("round-trips through the free-form style slot", () => {
    const p1 = withCaptionStyle(newProject({}), { burnIn: false, sizePct: 0.08, color: "#ff0000" });
    const style = captionStyleOf(p1.captions?.[0]);
    expect(style.burnIn).toBe(false);
    expect(style.sizePct).toBeCloseTo(0.08, 5);
    expect(style.color).toBe("#ff0000");
    // A later patch merges instead of replacing.
    const p2 = withCaptionStyle(p1, { burnIn: true });
    expect(captionStyleOf(p2.captions?.[0])).toMatchObject({ burnIn: true, color: "#ff0000" });
  });
});

describe("transitionFxAt", () => {
  it("fades ramp alpha up over the in edge and down over the out edge", () => {
    const c = clip({ transitionIn: { type: "fade", durationFrames: 10 } });
    expect(transitionFxAt(c, 0, 90).alpha).toBeCloseTo(0.1, 5);
    expect(transitionFxAt(c, 9, 90).alpha).toBeCloseTo(1, 5);
    expect(transitionFxAt(c, 45, 90).alpha).toBe(1);
    const o = clip({ transitionOut: { type: "crossDissolve", durationFrames: 10 } });
    expect(transitionFxAt(o, 89, 90).alpha).toBeCloseTo(0.1, 5);
    expect(transitionFxAt(o, 45, 90).alpha).toBe(1);
  });

  it("wipe reveals from the left; slide comes in from the left", () => {
    const w = clip({ transitionIn: { type: "wipe", durationFrames: 10 } });
    expect(transitionFxAt(w, 4, 90).wipe).toBeCloseTo(0.5, 5);
    const s = clip({ transitionIn: { type: "slide", durationFrames: 10 } });
    expect(transitionFxAt(s, 4, 90).slideX).toBeCloseTo(-0.5, 5);
    expect(transitionFxAt(s, 50, 90).slideX).toBeUndefined();
  });

  it("dipToColor overlays the color, strongest at the clip edge", () => {
    const d = clip({ transitionOut: { type: "dipToColor", durationFrames: 10, color: "#112233" } });
    const fx = transitionFxAt(d, 89, 90);
    expect(fx.dip?.color).toBe("#112233");
    expect(fx.dip && fx.dip.alpha > 0.8).toBe(true);
    expect(transitionFxAt(d, 40, 90).dip).toBeUndefined();
  });
});

describe("duckDbAtFrame", () => {
  const pts = [
    { frame: 0, musicGainDb: 0 },
    { frame: 10, musicGainDb: -12 },
    { frame: 20, musicGainDb: 0 },
  ];
  it("interpolates linearly between automation points", () => {
    expect(duckDbAtFrame(pts, 0)).toBe(0);
    expect(duckDbAtFrame(pts, 5)).toBeCloseTo(-6, 5);
    expect(duckDbAtFrame(pts, 10)).toBe(-12);
    expect(duckDbAtFrame(pts, 15)).toBeCloseTo(-6, 5);
    expect(duckDbAtFrame(pts, 99)).toBe(0);
    expect(duckDbAtFrame([], 5)).toBe(0);
  });
});

describe("clipGainAt + visibleVideoClipsAt", () => {
  function projectWith(tracks: Track[]) {
    const p = newProject({ tracks });
    return { ...p, durationFrames: 300 };
  }

  it("composes clip gain with the fade envelope and honors mute", () => {
    const c = clip({ fadeInFrames: 10, audioGainDb: 0 });
    const t: Track = { ...newTrack("audio", "A1"), clips: [c] };
    const p = projectWith([t]);
    // Mid-fade at frame 5 is roughly half amplitude; past the fade is full.
    expect(clipGainAt(p, t, c, 5)).toBeCloseTo(0.5, 1);
    expect(clipGainAt(p, t, c, 50)).toBeCloseTo(1, 5);
    const muted: Track = { ...t, muted: true };
    expect(clipGainAt(projectWith([muted]), muted, c, 50)).toBe(0);
  });

  it("applies ducking automation only to the configured music track", () => {
    const music: Track = { ...newTrack("audio", "Music"), clips: [clip({ id: "m" })] };
    const voice: Track = { ...newTrack("audio", "Voice"), clips: [clip({ id: "v" })] };
    const p = {
      ...projectWith([music, voice]),
      master: { gainDb: 0, ducking: { musicTrackId: music.id, voiceTrackId: voice.id, amountDb: -12, attackMs: 0, releaseMs: 0 } },
    };
    const duck = [{ frame: 0, musicGainDb: -12 }];
    const ducked = clipGainAt(p, music, music.clips[0], 10, duck);
    const notDucked = clipGainAt(p, voice, voice.clips[0], 10, duck);
    expect(ducked).toBeCloseTo(Math.pow(10, -12 / 20), 5);
    expect(notDucked).toBeCloseTo(1, 5);
  });

  it("activeTitleClipsAt: text tracks only, visible, with text", () => {
    const text: Track = { ...newTrack("text", "T1"), clips: [clip({ id: "t", assetId: undefined, title: { text: "Hello" } })] };
    const empty: Track = { ...newTrack("text", "T2"), clips: [clip({ id: "e", assetId: undefined, title: { text: "" } })] };
    const hidden: Track = { ...newTrack("text", "T3"), hidden: true, clips: [clip({ id: "h", assetId: undefined, title: { text: "Hidden" } })] };
    const video: Track = { ...newTrack("video", "V1"), clips: [clip({ id: "v", title: { text: "not a text track" } })] };
    const p = { ...newProject({ tracks: [text, empty, hidden, video] }), durationFrames: 300 };
    const titles = activeTitleClipsAt(p, 10);
    expect(titles.map((t) => t.clip.id)).toEqual(["t"]);
    expect(activeTitleClipsAt(p, 999)).toEqual([]);
  });

  it("stacks visible video clips in track order and skips hidden tracks", () => {
    const bottom: Track = { ...newTrack("video", "V1"), clips: [clip({ id: "b" })] };
    const top: Track = { ...newTrack("overlay", "O1"), clips: [clip({ id: "t" })] };
    const hidden: Track = { ...newTrack("video", "V2"), hidden: true, clips: [clip({ id: "h" })] };
    const audio: Track = { ...newTrack("audio", "A1"), clips: [clip({ id: "a" })] };
    const p = projectWith([bottom, hidden, audio, top]);
    const vis = visibleVideoClipsAt(p, 10);
    expect(vis.map((v) => v.clip.id)).toEqual(["b", "t"]);
  });
});

describe("color adjustments", () => {
  it("builds a ctx.filter string only from non-neutral values", () => {
    expect(colorFilter(undefined)).toBe("");
    expect(colorFilter({})).toBe("");
    expect(colorFilter({ brightness: 1, contrast: 1, saturation: 1 })).toBe("");
    expect(colorFilter({ brightness: 1.2 })).toBe("brightness(1.2)");
    expect(colorFilter({ brightness: 1.2, contrast: 0.9, saturation: 0 })).toBe(
      "brightness(1.2) contrast(0.9) saturate(0)",
    );
  });

  it("treats zero saturation as a real adjustment, not neutral", () => {
    expect(colorIsNeutral({ saturation: 0 })).toBe(false);
    expect(colorIsNeutral({ temperature: 0 })).toBe(true);
    expect(colorIsNeutral(undefined)).toBe(true);
  });

  it("ships presets whose values are non-neutral", () => {
    for (const p of COLOR_PRESETS) expect(colorIsNeutral(p.color)).toBe(false);
  });
});

describe("easing", () => {
  it("keeps linear as the default and clamps endpoints", () => {
    expect(applyEasing(0.25, undefined)).toBe(0.25);
    expect(applyEasing(0, "easeInOut")).toBe(0);
    expect(applyEasing(1, "easeInOut")).toBe(1);
    expect(applyEasing(0.5, "easeIn")).toBe(0.25);
    expect(applyEasing(0.5, "easeOut")).toBe(0.75);
    expect(applyEasing(0.5, "easeInOut")).toBe(0.5);
  });

  it("shapes interpolation between keyframes by the departing keyframe's easing", () => {
    const kfs = [
      { property: "dx", keyframes: [{ frame: 0, value: 0, easing: "easeIn" }, { frame: 10, value: 1 }] },
    ];
    // Linear midpoint would be 0.5; easeIn at t=0.5 is 0.25.
    expect(evalKeyframes(kfs, 5).dx).toBeCloseTo(0.25);
    // Unknown easing names fall back to linear (older files unaffected).
    const weird = [
      { property: "dx", keyframes: [{ frame: 0, value: 0, easing: "bounce??" }, { frame: 10, value: 1 }] },
    ];
    expect(evalKeyframes(weird, 5).dx).toBeCloseTo(0.5);
  });
});

describe("static pose fields", () => {
  it("folds clip.opacity into the keyframed opacity", () => {
    const c = clip({ opacity: 0.5, keyframes: [{ property: "opacity", keyframes: [{ frame: 0, value: 0.8 }] }] });
    expect(evalKeyframes(c.keyframes, 0, c).opacity).toBeCloseTo(0.4);
    // Without the clip argument (pure keyframe eval) the static part is ignored.
    expect(evalKeyframes(c.keyframes, 0).opacity).toBeCloseTo(0.8);
  });

  it("adds static rotation to the keyframed rotation", () => {
    const c = clip({
      rotationDeg: 10,
      keyframes: [{ property: "rotation", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 20 }] }],
    });
    expect(evalKeyframes(c.keyframes, 5, c).rotation).toBeCloseTo(20);
  });
});

describe("title animations", () => {
  it("fades in over animFrames and is static without animIn", () => {
    const t = { text: "Hello", animIn: "fade" as const, animFrames: 10 };
    expect(titleAnimAt(t, 0, 100).alpha).toBeCloseTo(0.1);
    expect(titleAnimAt(t, 9, 100).alpha).toBeCloseTo(1);
    expect(titleAnimAt(t, 50, 100).alpha).toBe(1);
    expect(titleAnimAt({ text: "Hello" }, 0, 100).alpha).toBe(1);
  });

  it("type-on reveals characters over the edge", () => {
    const t = { text: "Hello", animIn: "type-on" as const, animFrames: 5 };
    expect(titleAnimAt(t, 0, 100).revealChars).toBe(1);
    expect(titleAnimAt(t, 4, 100).revealChars).toBe(5);
    expect(titleAnimAt(t, 50, 100).revealChars).toBeUndefined();
  });

  it("slide-down exit offsets downward while fading", () => {
    const t = { text: "Hi", animOut: "slide-down" as const, animFrames: 10 };
    const nearEnd = titleAnimAt(t, 99, 100);
    expect(nearEnd.alpha).toBeLessThan(0.2);
    expect(nearEnd.offsetY).toBeGreaterThan(0);
    // The animation edge never exceeds half the clip.
    const short = titleAnimAt({ text: "Hi", animIn: "fade", animFrames: 50 }, 10, 20);
    expect(short.alpha).toBe(1);
  });
});

describe("motion presets", () => {
  it("fade-in writes an opacity ramp over the entrance edge", () => {
    const kfs = applyMotionPreset(undefined, "fade-in", 90);
    const op = kfs.find((t) => t.property === "opacity")!;
    expect(op.keyframes).toEqual([
      { frame: 0, value: 0 },
      { frame: 12, value: 1 },
    ]);
    expect(evalKeyframes(kfs, 6).opacity).toBeCloseTo(0.5);
  });

  it("entrance and exit presets compose on the same property", () => {
    let kfs = applyMotionPreset(undefined, "fade-in", 90);
    kfs = applyMotionPreset(kfs, "fade-out", 90);
    const op = kfs.find((t) => t.property === "opacity")!;
    expect(op.keyframes.map((k) => k.frame)).toEqual([0, 12, 77, 89]);
    expect(evalKeyframes(kfs, 45).opacity).toBe(1);
    expect(evalKeyframes(kfs, 89).opacity).toBe(0);
  });

  it("re-applying a preset overwrites only its own window", () => {
    let kfs = applyMotionPreset(undefined, "slide-in", 90);
    kfs = applyMotionPreset(kfs, "slide-in", 90);
    const dx = kfs.find((t) => t.property === "dx")!;
    expect(dx.keyframes.length).toBe(2);
    expect(dx.keyframes[0]).toMatchObject({ frame: 0, value: -0.4, easing: "easeOut" });
  });

  it("pop-in eases the scale and the edge shrinks on short clips", () => {
    const kfs = applyMotionPreset(undefined, "pop-in", 10);
    const sc = kfs.find((t) => t.property === "scale")!;
    expect(sc.keyframes[0].value).toBe(0.6);
    expect(sc.keyframes[1].frame).toBe(5); // half the 10-frame clip, not 12
  });

  it("setTrackEasing stamps every keyframe of one property", () => {
    let kfs = applyMotionPreset(undefined, "fade-in", 90);
    kfs = setTrackEasing(kfs, "opacity", "easeInOut");
    expect(kfs.find((t) => t.property === "opacity")!.keyframes.every((k) => k.easing === "easeInOut")).toBe(true);
    kfs = setTrackEasing(kfs, "opacity", undefined);
    expect(kfs.find((t) => t.property === "opacity")!.keyframes.every((k) => k.easing === undefined)).toBe(true);
  });
});
