import { describe, expect, it } from "vitest";
import {
  toolCatalog,
  parseAssistantReply,
  planMutates,
  summarizeDesign,
  assistantSystemPrompt,
  AssistantError,
} from "../index";

const CAT = toolCatalog();

describe("parseAssistantReply", () => {
  it("validates a plan of known, well-typed actions", () => {
    const res = parseAssistantReply(
      {
        reply: "Sure.",
        plan: [
          { action: "addPage", args: {} },
          { action: "setPageBackground", args: { color: "#102030" } },
          { action: "setSelectedText", args: { text: "  Hello  " } },
        ],
      },
      CAT,
    );
    expect(res.plan).toHaveLength(3);
    expect(res.plan[1].args.color).toBe("#102030");
    expect(res.plan[2].args.text).toBe("Hello"); // trimmed
  });

  it("drops unknown actions and steps missing required args", () => {
    const res = parseAssistantReply(
      {
        plan: [
          { action: "frobnicate", args: {} },
          { action: "setPageBackground", args: { color: "not-a-color" } },
          { action: "setSelectedText", args: {} },
          { action: "addPage", args: {} },
        ],
      },
      CAT,
    );
    expect(res.plan.map((s) => s.action)).toEqual(["addPage"]);
  });

  it("coerces chart series and categories", () => {
    const res = parseAssistantReply(
      {
        plan: [
          {
            action: "insertChart",
            args: { chartType: "bar", categories: ["Q1", "Q2"], series: [{ name: "Rev", values: [1, "2", 3] }] },
          },
        ],
      },
      CAT,
    );
    expect(res.plan).toHaveLength(1);
    expect(res.plan[0].args.series).toEqual([{ name: "Rev", values: [1, 2, 3] }]);
  });

  it("short-circuits to a clarifying question with an empty plan", () => {
    const res = parseAssistantReply({ clarify: "Which page do you mean?", plan: [{ action: "addPage", args: {} }] }, CAT);
    expect(res.clarify).toBe("Which page do you mean?");
    expect(res.plan).toHaveLength(0);
  });

  it("throws on a non-object reply", () => {
    expect(() => parseAssistantReply("nope", CAT)).toThrow(AssistantError);
  });

  it("coerces numeric strings for resizePage", () => {
    const res = parseAssistantReply({ plan: [{ action: "resizePage", args: { width: "1080", height: 1920 } }] }, CAT);
    expect(res.plan[0].args).toEqual({ width: 1080, height: 1920 });
  });
});

describe("planMutates", () => {
  it("is false for a read-only plan", () => {
    expect(planMutates([{ action: "critique", args: {}, status: "planned" }], CAT)).toBe(false);
  });
  it("is true when any step mutates", () => {
    expect(planMutates([{ action: "critique", args: {}, status: "planned" }, { action: "addPage", args: {}, status: "planned" }], CAT)).toBe(true);
  });
});

describe("summarizeDesign", () => {
  it("produces a compact multi-line summary", () => {
    const doc = {
      title: "Deck",
      pages: [
        { name: "Cover", width: 1920, height: 1080, children: [{ type: "text" }, { type: "text" }, { type: "shape" }] },
        { width: 1920, height: 1080, children: [] },
      ],
    };
    const s = summarizeDesign(doc, 0, 1);
    expect(s).toContain("Pages: 2");
    expect(s).toContain("2 text, 1 shape");
    expect(s).toContain("empty");
  });
});

describe("assistantSystemPrompt", () => {
  it("lists every tool and embeds the summary", () => {
    const p = assistantSystemPrompt(CAT, "Pages: 1");
    for (const t of CAT) expect(p).toContain(t.name);
    expect(p).toContain("Pages: 1");
  });
});
