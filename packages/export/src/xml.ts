// Minimal dependency-free XML parser for OOXML import (doc 28 PPTX import).
// OOXML parts are machine-generated, well-formed XML, so a compact
// tokenizing DOM builder covers them: elements with attributes, text nodes,
// self-closing tags, CDATA, comments, processing instructions, and the five
// predefined entities. No DTDs (OOXML has none), no external entities ever
// (nothing is fetched or expanded, so no XXE surface). Namespace prefixes are
// kept verbatim ("a:solidFill"), matching how the writers emit them.

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string; // concatenated direct text content
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/** Parse an XML document; returns the root element. Throws on malformed input. */
export function parseXml(source: string): XmlElement {
  let i = 0;
  const n = source.length;

  const fail = (msg: string): never => {
    throw new Error(`xml: ${msg} at ${i}`);
  };

  const skipUntil = (needle: string): void => {
    const at = source.indexOf(needle, i);
    if (at < 0) fail(`unterminated ${needle}`);
    i = at + needle.length;
  };

  const parseAttrs = (el: XmlElement): void => {
    for (;;) {
      while (i < n && /\s/.test(source[i])) i++;
      const c = source[i];
      if (c === ">" || c === "/" || c === "?" || i >= n) return;
      const eq = source.indexOf("=", i);
      if (eq < 0) fail("attribute without value");
      const name = source.slice(i, eq).trim();
      i = eq + 1;
      while (i < n && /\s/.test(source[i])) i++;
      const quote = source[i];
      if (quote !== '"' && quote !== "'") fail("unquoted attribute");
      const end = source.indexOf(quote, i + 1);
      if (end < 0) fail("unterminated attribute");
      el.attrs[name] = decodeEntities(source.slice(i + 1, end));
      i = end + 1;
    }
  };

  const parseElement = (): XmlElement => {
    if (source[i] !== "<") fail("expected element");
    i++;
    let j = i;
    while (j < n && !/[\s/>]/.test(source[j])) j++;
    const el: XmlElement = { tag: source.slice(i, j), attrs: {}, children: [], text: "" };
    if (!el.tag) fail("empty tag");
    i = j;
    parseAttrs(el);
    if (source[i] === "/") {
      i += 2; // "/>"
      return el;
    }
    i++; // ">"
    // children until matching close tag
    for (;;) {
      if (i >= n) fail(`unterminated <${el.tag}>`);
      if (source.startsWith("</", i)) {
        const close = source.indexOf(">", i);
        if (close < 0) fail("unterminated close tag");
        // Check the NAME: without this, </anything> closes whatever element is
        // open, so mis-nested markup silently parses into the wrong shape
        // instead of failing where the caller can see it.
        const name = source.slice(i + 2, close).trim();
        if (name !== el.tag) fail(`expected </${el.tag}>, found </${name}>`);
        i = close + 1;
        return el;
      }
      if (source.startsWith("<!--", i)) {
        skipUntil("-->");
        continue;
      }
      if (source.startsWith("<![CDATA[", i)) {
        const at = source.indexOf("]]>", i);
        if (at < 0) fail("unterminated CDATA");
        el.text += source.slice(i + 9, at);
        i = at + 3;
        continue;
      }
      if (source.startsWith("<?", i)) {
        skipUntil("?>");
        continue;
      }
      if (source[i] === "<") {
        el.children.push(parseElement());
        continue;
      }
      const next = source.indexOf("<", i);
      const end = next < 0 ? n : next;
      el.text += decodeEntities(source.slice(i, end));
      i = end;
    }
  };

  // prolog / doctype-less lead-in
  for (;;) {
    while (i < n && /\s/.test(source[i])) i++;
    if (source.startsWith("<?", i)) {
      skipUntil("?>");
      continue;
    }
    if (source.startsWith("<!--", i)) {
      skipUntil("-->");
      continue;
    }
    break;
  }
  if (i >= n) fail("empty document");
  return parseElement();
}

/** First descendant (depth-first) whose tag matches. */
export function findFirst(el: XmlElement, tag: string): XmlElement | null {
  if (el.tag === tag) return el;
  for (const c of el.children) {
    const hit = findFirst(c, tag);
    if (hit) return hit;
  }
  return null;
}

/** All descendants (depth-first) whose tag matches. */
export function findAll(el: XmlElement, tag: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    if (e.tag === tag) out.push(e);
    for (const c of e.children) walk(c);
  };
  walk(el);
  return out;
}

/** Direct children with the given tag. */
export function childrenOf(el: XmlElement, tag: string): XmlElement[] {
  return el.children.filter((c) => c.tag === tag);
}

/** First direct child with the given tag. */
export function childOf(el: XmlElement, tag: string): XmlElement | null {
  return el.children.find((c) => c.tag === tag) ?? null;
}
