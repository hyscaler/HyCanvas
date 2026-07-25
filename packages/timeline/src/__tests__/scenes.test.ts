import { describe, it, expect } from "vitest";
import { listScenes, sceneAtFrame, packScenes } from "../scenes";
import type { VideoProject } from "../model";

function proj(): VideoProject {
  return {
    stage: { width: 1920, height: 1080 },
    fps: 30,
    durationFrames: 240,
    tracks: [
      {
        id: "ov1",
        kind: "overlay",
        clips: [
          { id: "a-bg", sceneId: "A", startFrame: 0, inFrame: 0, outFrame: 150, speed: 1, element: {} },
          { id: "b-bg", sceneId: "B", startFrame: 150, inFrame: 0, outFrame: 90, speed: 1, element: {} },
        ],
      },
      {
        id: "ov2",
        kind: "overlay",
        clips: [{ id: "a-txt", sceneId: "A", startFrame: 0, inFrame: 0, outFrame: 150, speed: 1, element: {} }],
      },
    ],
    master: { gainDb: 0 },
  } as unknown as VideoProject;
}

describe("scenes", () => {
  it("lists scenes ordered, with spans and clip ids across tracks", () => {
    const s = listScenes(proj());
    expect(s.map((x) => x.id)).toEqual(["A", "B"]);
    expect(s[0].startFrame).toBe(0);
    expect(s[0].durationFrames).toBe(150);
    expect([...s[0].clipIds].sort()).toEqual(["a-bg", "a-txt"]);
    expect(s[1].startFrame).toBe(150);
    expect(s[1].durationFrames).toBe(90);
  });

  it("finds the scene containing a frame", () => {
    expect(sceneAtFrame(proj(), 10)?.id).toBe("A");
    expect(sceneAtFrame(proj(), 200)?.id).toBe("B");
    expect(sceneAtFrame(proj(), 999)).toBeNull();
  });

  it("packs scenes contiguously in a new order (B before A)", () => {
    const p = packScenes(proj(), ["B", "A"]);
    const s = listScenes(p);
    expect(s.map((x) => x.id)).toEqual(["B", "A"]);
    expect(s[0].startFrame).toBe(0);
    expect(s[0].durationFrames).toBe(90);
    expect(s[1].startFrame).toBe(90);
    expect(s[1].durationFrames).toBe(150);
    // both of A's clips (bg + text) move together to the new block start.
    const aStarts = p.tracks.flatMap((t) => t.clips).filter((c) => c.sceneId === "A").map((c) => c.startFrame);
    expect(aStarts).toEqual([90, 90]);
  });

  it("closes the gap after a scene is removed", () => {
    const removed: VideoProject = {
      ...proj(),
      tracks: proj().tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.sceneId !== "A") })),
    };
    const p = packScenes(removed, []);
    expect(listScenes(p)[0].startFrame).toBe(0);
  });
});
