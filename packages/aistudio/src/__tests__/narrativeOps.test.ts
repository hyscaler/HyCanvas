import { describe, expect, it } from "vitest";
import type { SlideLayout } from "@hc/schema";
import {
  agendaPageCount,
  splitEvenly,
  extractTitleFromText,
  buildAgendaPages,
  pickAgendaLayout,
} from "../index";

describe("agendaPageCount", () => {
  it("takes ten entries per agenda page, excluding the title slide", () => {
    expect(agendaPageCount(8, true)).toBe(1); // 7 entries
    expect(agendaPageCount(11, true)).toBe(1); // 10 entries
    expect(agendaPageCount(12, true)).toBe(2); // 11 entries
    expect(agendaPageCount(10, false)).toBe(1);
    expect(agendaPageCount(1, true)).toBe(0); // nothing to list
    expect(agendaPageCount(0, false)).toBe(0);
  });
});

describe("splitEvenly", () => {
  it("splits contiguously with near-equal sizes, earlier sections larger", () => {
    expect(splitEvenly([1, 2, 3, 4, 5], 2)).toEqual([[1, 2, 3], [4, 5]]);
    expect(splitEvenly([1, 2, 3], 3)).toEqual([[1], [2], [3]]);
    expect(splitEvenly([], 2)).toEqual([]);
    expect(splitEvenly([1], 0)).toEqual([]);
  });
});

describe("extractTitleFromText", () => {
  it("prefers a heading, then the first sentence, then the first line", () => {
    expect(extractTitleFromText("intro\n## The Real Title\nmore")).toBe("The Real Title");
    expect(extractTitleFromText("We grew 40% this year. More detail follows.")).toBe("We grew 40% this year.");
    expect(extractTitleFromText("\n\nJust a line\nsecond")).toBe("Just a line");
    expect(extractTitleFromText("   ")).toBe("Slide");
  });
});

describe("buildAgendaPages", () => {
  it("numbers entries accounting for the inserted agenda pages", () => {
    // 8 pages with a title slide: 7 entries, 1 agenda page. Content that was
    // page 2 becomes page 3 (title + agenda before it).
    const plans = buildAgendaPages(["Cover", "A", "B", "C", "D", "E", "F", "G"], true);
    expect(plans).toHaveLength(1);
    expect(plans[0].entries[0]).toEqual({ pageNumber: 3, title: "A" });
    expect(plans[0].entries[6]).toEqual({ pageNumber: 9, title: "G" });
  });

  it("splits across two agenda pages past ten entries and keeps numbering global", () => {
    const titles = ["Cover", ...Array.from({ length: 11 }, (_, i) => `P${i + 1}`)];
    const plans = buildAgendaPages(titles, true);
    expect(plans).toHaveLength(2);
    expect(plans[0].entries[0].pageNumber).toBe(4); // title + 2 agenda pages
    const last = plans[1].entries[plans[1].entries.length - 1];
    expect(last).toEqual({ pageNumber: 14, title: "P11" });
  });

  it("returns nothing for a deck with nothing to list", () => {
    expect(buildAgendaPages(["Only"], true)).toEqual([]);
  });
});

describe("pickAgendaLayout", () => {
  const L = (id: string, name: string, roles: string[]): SlideLayout =>
    ({ id, masterId: "m", name, placeholders: roles.map((role, i) => ({ id: `p${i}`, role, rect: { x: 0, y: 0, width: 1, height: 1 } })) }) as SlideLayout;

  it("prefers an agenda-named layout, then a list-named one, then any content slot", () => {
    const agenda = L("a", "Agenda", ["title", "content"]);
    const list = L("l", "Bulleted list", ["title", "content"]);
    const generic = L("g", "Title and content", ["title", "content"]);
    expect(pickAgendaLayout([generic, list, agenda])?.id).toBe("a");
    expect(pickAgendaLayout([generic, list])?.id).toBe("l");
    expect(pickAgendaLayout([generic])?.id).toBe("g");
  });

  it("returns null when nothing can hold a list (skip silently)", () => {
    expect(pickAgendaLayout([L("t", "Title", ["title", "body"])])).toBeNull();
  });
});
