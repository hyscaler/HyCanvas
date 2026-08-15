// @vitest-environment jsdom
//
// The inline text editor's DOM <-> model round trip. The editor rebuilds its
// contentEditable DOM from the model after every input that moves a wrap
// point, restoring the caret by FLAT OFFSET over the text stream. Any
// asymmetry in that loop shows up to the user as the caret jumping to the
// first line, or as second-line text merging into the first / disappearing.
// These reproduce the loop exactly as the overlay runs it: build -> mutate the
// DOM like a browser would -> parse -> rebuild -> restore caret.

import { beforeEach, describe, expect, it } from "vitest";
import type { TextNode } from "@hc/schema";
import {
  buildEditorHtml,
  defaultChar,
  flatSelection,
  htmlToContent,
  setFlatSelection,
  type EditPara,
} from "./textEditModel";

// Narrow box so the first paragraph soft-wraps under the deterministic
// fallback measurer (jsdom has no canvas: width = chars * fontSize * 0.55).
const WIDTH = 160;

function textNode(content: EditPara[]): TextNode {
  return {
    id: "t", type: "text",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: WIDTH, height: 40 }, opacity: 1, blendMode: "normal",
    box: { mode: "autoHeight", width: WIDTH, height: 40 },
    content,
  } as unknown as TextNode;
}

function para(text: string): EditPara {
  return { runs: [{ text, style: defaultChar() }], style: { align: "left", direction: "auto" } };
}

const flatText = (paras: EditPara[]) => paras.map((p) => p.runs.map((r) => r.text).join("")).join("\n");

// The user-visible reproduction: a testimonial whose first paragraph wraps.
const CONTENT = [para("This is hands down the best"), para("tool our team has adopted this year")];

let el: HTMLDivElement;

function build(model: EditPara[]): void {
  const { html } = buildEditorHtml(textNode(model), model, 1);
  el.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = "";
  el = document.createElement("div");
  el.contentEditable = "true";
  document.body.appendChild(el);
});

describe("DOM <-> model round trip", () => {
  it("is a fixed point: parse(build(model)) equals the model", () => {
    build(CONTENT);
    const parsed = htmlToContent(el, CONTENT);
    expect(flatText(parsed)).toBe(flatText(CONTENT));
    expect(parsed).toHaveLength(2);
    // Second cycle must not drift either.
    build(parsed);
    const again = htmlToContent(el, parsed);
    expect(flatText(again)).toBe(flatText(CONTENT));
    expect(again).toHaveLength(2);
  });

  it("keeps every soft-wrapped line inside ONE paragraph", () => {
    build(CONTENT);
    expect(el.querySelectorAll("br[data-soft]").length).toBeGreaterThan(0);
    const parsed = htmlToContent(el, CONTENT);
    expect(parsed).toHaveLength(2);
  });

  it("round-trips empty paragraphs (Enter Enter)", () => {
    const model = [para("a"), para(""), para("b")];
    build(model);
    const parsed = htmlToContent(el, model);
    expect(parsed).toHaveLength(3);
    expect(flatText(parsed)).toBe("a\n\nb");
  });
});

describe("typing in the second line", () => {
  it("inserting into a soft-wrapped line 2 edits that paragraph in place", () => {
    build(CONTENT);
    // The text node that starts visual line 2 of paragraph 0 (after the soft br).
    const soft = el.querySelector("br[data-soft]")!;
    const line2 = soft.nextSibling!.firstChild as Text;
    const line2Before = line2.data;
    line2.insertData(2, "X");
    const parsed = htmlToContent(el, CONTENT);
    expect(parsed).toHaveLength(2);
    const p0 = "This is hands down the best";
    const breakAt = p0.length - line2Before.length;
    expect(parsed[0].runs.map((r) => r.text).join("")).toBe(
      p0.slice(0, breakAt) + line2Before.slice(0, 2) + "X" + line2Before.slice(2),
    );
    expect(parsed[1].runs.map((r) => r.text).join("")).toBe("tool our team has adopted this year");
  });

  it("typing anchored inside the newline separator span lands in paragraph 2", () => {
    build(CONTENT);
    // Chrome often anchors a caret at the start of a hard line INSIDE the
    // separator span (after its "\n"); typed characters then land there.
    const seps = Array.from(el.querySelectorAll("span")).filter((s) => s.textContent === "\n");
    expect(seps).toHaveLength(1);
    (seps[0].firstChild as Text).appendData("X");
    const parsed = htmlToContent(el, CONTENT);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].runs.map((r) => r.text).join("")).toBe("Xtool our team has adopted this year");
    expect(parsed[0].runs.map((r) => r.text).join("")).toBe("This is hands down the best");
  });
});

describe("hard breaks typed by the browser (<br>, not \\n)", () => {
  // Chrome materializes execCommand("insertText", "\n") inside inline spans as
  // a <br> ELEMENT: zero characters in Range.toString()/textContent, while the
  // rebuilt DOM stores the same break as a "\n" TEXT node (one character).
  // The flat offset space must count both as ONE character, or every hard
  // break typed since the last rebuild shifts the restored caret one left -
  // the fast-typing bug that turned "adopted" into "dopteda".
  const browserDom = () => {
    // What the editor DOM looks like right after typing:
    //   line1<br>line2   (browser-inserted break, tail typed after it)
    el.innerHTML = "";
    const s1 = document.createElement("span");
    s1.textContent = "This is hands down the best";
    const br = document.createElement("br");
    const tail = document.createTextNode("tool our team has a");
    el.append(s1, br, tail);
    return tail;
  };

  it("counts a browser <br> as one flat character", () => {
    const tail = browserDom();
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(tail, tail.length); // caret at the very end, mid-typing
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    const flat = flatSelection(el)!;
    // 27 chars of line 1 + 1 for the <br> + 19 chars typed after it.
    expect(flat.start).toBe(27 + 1 + 19);
  });

  it("keeps the caret in place across the rebuild that swaps <br> for \\n", () => {
    const tail = browserDom();
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(tail, tail.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    // The overlay's rewrap: capture caret, parse, rebuild, restore.
    const caret = flatSelection(el)!;
    const parsed = htmlToContent(el, CONTENT);
    expect(parsed).toHaveLength(2); // the <br> is a hard paragraph break
    build(parsed);
    setFlatSelection(el, caret.start, caret.end);
    // The caret must still be at the very end: the next typed character lands
    // after "a", not before it.
    const after = flatSelection(el)!;
    expect(after.start).toBe(flatText(parsed).length);
  });

  it("restores a caret that lands inside a <br> slot to the next line start", () => {
    browserDom();
    // Position exactly "after the break" (offset 28) in a DOM that still has
    // the <br>: must resolve to offset 0 of the tail node, not one char left.
    setFlatSelection(el, 28, 28);
    const sel = window.getSelection()!;
    expect(sel.anchorNode?.textContent).toBe("tool our team has a");
    expect(sel.anchorOffset).toBe(0);
  });
});

describe("caret placement at line boundaries", () => {
  it("resolves the start of a hard line 2 to line 2's text node, never the newline span", () => {
    build(CONTENT);
    const pos = "This is hands down the best".length + 1; // just after the "\n"
    setFlatSelection(el, pos, pos);
    const sel = window.getSelection()!;
    // Chrome relocates a caret parked inside the "\n" span into LINE 1 and
    // types there; the only stable anchor is paragraph 2's own text node.
    expect(sel.anchorNode?.textContent?.startsWith("tool")).toBe(true);
    expect(sel.anchorOffset).toBe(0);
  });

  it("gives an empty last paragraph (Enter just pressed) a real caret anchor", () => {
    const model = [para("This is hands down the best"), para("")];
    build(model);
    // The empty last line must RENDER (trailing "\n" alone creates no line box
    // under white-space:pre): a data-soft placeholder <br> carries it.
    expect(el.innerHTML.endsWith(`<br data-soft="1"></span>`)).toBe(true);
    // ...and it round-trips away.
    const parsed = htmlToContent(el, model);
    expect(parsed).toHaveLength(2);
    expect(flatText(parsed)).toBe("This is hands down the best\n");
    // The caret lands before the placeholder, on the empty line - an ELEMENT
    // anchor, not a position inside the "\n" text where Chrome refuses to type.
    const pos = "This is hands down the best".length + 1;
    setFlatSelection(el, pos, pos);
    const sel = window.getSelection()!;
    expect(sel.anchorNode?.nodeType).toBe(Node.ELEMENT_NODE);
    expect((sel.anchorNode as Element).querySelector("br[data-soft]")).not.toBeNull();
  });

  it("keeps a boundary caret before a hard <br> on its own side", () => {
    // "hello" | <br> | "world": flat position 5 is the end of "hello"; jumping
    // downstream to "world"@0 would silently cross the break (flat 6).
    el.innerHTML = "";
    const a = document.createTextNode("hello");
    const br = document.createElement("br");
    const b = document.createTextNode("world");
    el.append(a, br, b);
    setFlatSelection(el, 5, 5);
    const sel = window.getSelection()!;
    expect(sel.anchorNode?.textContent).toBe("hello");
    expect(sel.anchorOffset).toBe(5);
    setFlatSelection(el, 6, 6);
    expect(window.getSelection()!.anchorNode?.textContent).toBe("world");
    expect(window.getSelection()!.anchorOffset).toBe(0);
  });
});

describe("boundary restore at a SOFT wrap", () => {
  it("resolves into the styled text node of line 2, never the editor root", () => {
    build(CONTENT);
    // The exact wrap boundary of paragraph 0: end-of-line-1 == start-of-line-2.
    const soft = el.querySelector("br[data-soft]")!;
    const line1 = soft.previousSibling!.textContent!;
    const boundary = line1.length; // paragraph 0's spans precede the wrap br
    setFlatSelection(el, boundary, boundary);
    const sel = window.getSelection()!;
    // Anchoring at the editor root before the wrap br would make Chrome type a
    // BARE text node there (unstyled, parsed with the fallback style); the
    // stable anchor is line 2's own styled text node.
    expect(sel.anchorNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(sel.anchorNode?.parentElement?.hasAttribute("data-st")).toBe(true);
    expect(sel.anchorOffset).toBe(0);
    expect(sel.anchorNode?.textContent).toBe(soft.nextSibling!.textContent);
  });
});

describe("the rebuild signature", () => {
  it("changes when a paragraph appears, even with identical wrap offsets", () => {
    // IME and dictation newlines arrive as browser <div>/<br> blocks, not via
    // the intercepted Enter; if the signature ignored paragraph structure the
    // editor would keep that divergent DOM and the caret math would drift.
    const one = [para("hi")];
    const two = [para("hi"), para("")];
    const a = buildEditorHtml(textNode(one), one, 1).sig;
    const b = buildEditorHtml(textNode(two), two, 1).sig;
    expect(a).not.toBe(b);
  });
});

describe("caret restore across a rebuild", () => {
  it("keeps the caret at the same flat offset after innerHTML is replaced", () => {
    build(CONTENT);
    // Place the caret a few chars into HARD line 2 (paragraph 1).
    const flat = flatText(CONTENT);
    const target = flat.indexOf("tool") + 2;
    setFlatSelection(el, target, target);
    const before = flatSelection(el);
    expect(before).toEqual({ start: target, end: target });
    // The overlay's rewrap: parse, rebuild, restore.
    const parsed = htmlToContent(el, CONTENT);
    build(parsed);
    setFlatSelection(el, before!.start, before!.end);
    expect(flatSelection(el)).toEqual({ start: target, end: target });
  });

  it("keeps the caret on a SOFT-wrapped second line across a rebuild", () => {
    build(CONTENT);
    const flat = flatText(CONTENT);
    const target = flat.indexOf("best") + 2; // inside soft line 2 of paragraph 0
    setFlatSelection(el, target, target);
    const parsed = htmlToContent(el, CONTENT);
    build(parsed);
    setFlatSelection(el, target, target);
    expect(flatSelection(el)).toEqual({ start: target, end: target });
  });
});
