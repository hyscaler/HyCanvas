// Word-level text morph (F28 completion C10): positions from the same pure
// layout both renderers use, greedy in-order matching, honest fallbacks.

import { describe, expect, it } from "vitest";
import type { Node, TextNode } from "@hc/schema";
import { maxMorphWords, planWordMorph, wordBoxes, wordMorphEligible, wordMorphNodes } from "../textmorph";
import { morphPlan, morphDesignAt } from "../transition";
import { createBlankDesign, type DesignFile } from "@hc/schema";

function textNode(id: string, text: string, x = 0, opts: { rotation?: number; scale?: number; align?: string } = {}): TextNode {
  return {
    id, type: "text",
    transform: { x, y: 0, scaleX: opts.scale ?? 1, scaleY: opts.scale ?? 1, rotation: opts.rotation ?? 0 },
    size: { width: 400, height: 50 }, opacity: 1, blendMode: "normal",
    box: { mode: "fixed", width: 400, height: 50 },
    content: [{ runs: [{ text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 20 } }], style: { align: opts.align ?? "left" } }],
  } as unknown as TextNode;
}

describe("wordBoxes", () => {
  it("splits a line into positioned words with consistent advances", () => {
    const words = wordBoxes(textNode("t", "alpha beta gamma"));
    expect(words.map((w) => w.text)).toEqual(["alpha", "beta", "gamma"]);
    // Monotonic x, and beta starts after alpha + its trailing space.
    expect(words[1].x).toBeGreaterThan(words[0].x + words[0].width);
    expect(words[2].x).toBeGreaterThan(words[1].x);
  });
});

describe("planWordMorph", () => {
  it("matches common words in order; classifies added and removed", () => {
    const plan = planWordMorph(textNode("a", "growth beats churn"), textNode("b", "churn beats growth today"))!;
    expect(plan.moved.map((m) => m.to.text)).toEqual(["churn", "beats", "growth"]);
    expect(plan.added.map((w) => w.text)).toEqual(["today"]);
    expect(plan.removed).toEqual([]);
  });

  it("returns null for identical text, a full rewrite, or past the cap", () => {
    expect(planWordMorph(textNode("a", "same words here"), textNode("b", "same words here"))).toBeNull();
    expect(planWordMorph(textNode("a", "alpha beta"), textNode("b", "gamma delta"))).toBeNull();
    const many = Array.from({ length: maxMorphWords + 1 }, (_, i) => `w${i}`).join(" ");
    expect(planWordMorph(textNode("a", many), textNode("b", `${many} extra`))).toBeNull();
  });

  it("repeated words match stably (first unconsumed wins)", () => {
    const plan = planWordMorph(textNode("a", "go go go"), textNode("b", "go stop go"))!;
    expect(plan.moved).toHaveLength(2);
    expect(plan.removed).toHaveLength(1);
    expect(plan.added.map((w) => w.text)).toEqual(["stop"]);
  });
});

describe("wordMorphEligible", () => {
  it("requires unrotated, unit-scale text on both sides", () => {
    expect(wordMorphEligible(textNode("a", "x") as Node, textNode("b", "x") as Node)).toBe(true);
    expect(wordMorphEligible(textNode("a", "x", 0, { rotation: 10 }) as Node, textNode("b", "x") as Node)).toBe(false);
    expect(wordMorphEligible(textNode("a", "x", 0, { scale: 2 }) as Node, textNode("b", "x") as Node)).toBe(false);
  });
});

describe("wordMorphNodes", () => {
  it("moved words lerp between absolute positions; added/removed fade", () => {
    const from = textNode("a", "hello world", 100);
    const to = textNode("a", "world hello again", 300);
    const plan = planWordMorph(from, to)!;
    const mid = wordMorphNodes(from, to, plan, 0.5);
    const texts = mid.map((n) => (n as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text);
    expect(texts).toEqual(expect.arrayContaining(["world", "hello", "again"]));
    const world = mid.find((n) => (n as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text === "world")!;
    const fromWorld = plan.moved.find((m) => m.to.text === "world")!;
    expect(world.transform.x).toBeCloseTo((100 + fromWorld.from.x + 300 + fromWorld.to.x) / 2, 3);
    const again = mid.find((n) => (n as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text === "again")!;
    expect(again.opacity).toBe(0); // added: fades in only during the second half
    const late = wordMorphNodes(from, to, plan, 0.9);
    const againLate = late.find((n) => (n as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text === "again")!;
    expect(againLate.opacity).toBeCloseTo(0.8, 5);
  });
});

describe("morphDesignAt word morph integration", () => {
  function deckOf(a: Node, b: Node): DesignFile {
    const file = createBlankDesign({ title: "d", width: 800, height: 600 });
    file.pages[0].children = [a];
    file.pages.push({ ...structuredClone(file.pages[0]), id: "p2", children: [b] });
    return file;
  }

  it("an eligible text pair with changed words fabricates word nodes", () => {
    const d = deckOf(textNode("t1", "alpha beta", 0) as Node, textNode("t1", "beta alpha", 200) as Node);
    const plan = morphPlan(d, 0, d, 1)!;
    const posed = morphDesignAt(plan, d, 1, 0.5);
    expect(posed.pages[1].children.length).toBe(2); // one node per word
    expect(posed.pages[1].children.every((n) => n.id.startsWith("t1-wm-"))).toBe(true);
  });

  it("identical text falls back to the whole-node tween", () => {
    const d = deckOf(textNode("t1", "same", 0) as Node, textNode("t1", "same", 200) as Node);
    const plan = morphPlan(d, 0, d, 1)!;
    const posed = morphDesignAt(plan, d, 1, 0.5);
    expect(posed.pages[1].children).toHaveLength(1);
    expect(posed.pages[1].children[0].transform.x).toBeCloseTo(100, 3);
  });
});
