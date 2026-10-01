// From an outline page to a kit slide.
//
// The model decided the form (the archetype) and wrote the copy; this
// module chooses the kit layout that form maps onto, shapes the page's
// typed fields into that layout's content, and compiles the slide into
// nodes. A page that names a signature form gets it once per deck, when its
// fields can carry it. Pictures follow one policy: a page whose image
// intent is a photograph gets a tagged slot the picture pipeline fills; any
// other page that wants a picture gets a drawing from the pack in a halo,
// drawn now, editable everywhere, and never waiting on a provider.

import type { Fill, Node } from "@hc/schema";
import type { Archetype, DesignType, OutlineItem, Stat } from "../outline";
import type { ComposedPage } from "../archetypes";
import { applyMotion, iconGlyphFor } from "../archetypes";
import type { DeckMotion } from "../designSystem";
import { CW, M, card, chrome, deepCard, drawingFor, mixHex, note, type, type KitLook } from "./look";
import * as L from "./layouts";
import { SIGNATURES, kitSignatureNames, type KitSignature } from "./signature";
import { compileSlide, ellipse, fillOf, icon, path, photo, rect, scaleNodes, text, type DrawingPrim, type Prim } from "./spec";

export interface KitContext {
  index: number;
  total: number;
  /** For a section divider: its one-based number among the deck's sections. */
  section?: number;
  designType?: DesignType;
  motion: DeckMotion;
  /** The factor from the kit's 1920 by 1080 to the deck's page. */
  scale: number;
  /** The clause every picture prompt carries. */
  artDirection: string;
  /** Set once a page has taken the deck's one signature form. */
  signatureUsed: { value: boolean };
}

const DEEP_FORMS = new Set(["Cover", "Section", "Quote", "Closing", "Big figure"]);

// --- copy shaping ------------------------------------------------------------------

/** A point split into a heading and its line: at a colon or a full stop
 *  when the first part reads as a heading, else the whole point as the
 *  heading with no line. */
export function splitPoint(p: string): [string, string] {
  const s = p.trim();
  const m = /^([^:.!?]{3,64})[:.]\s+(\S.*)$/.exec(s);
  if (m) return [m[1].trim(), m[2].trim()];
  return [s, ""];
}

/** The leading figure of a line ("$4.2M expansion revenue" gives $4.2M),
 *  or null when the line does not begin with one. */
export function leadingFigure(p: string): [string | null, string] {
  const m = /^([$€£¥]?\s?[\d][\d.,]*\s?(?:%|[kKmMbB]n?|x|pts?|pp|bps)?)\s+(.+)$/.exec(p.trim());
  if (m && m[1].length <= 12) return [m[1].replace(/\s+/g, ""), m[2]];
  const m2 = /^(\d+(?:\.\d+)?\s?(?:%|percent|x))\s*[:,-]?\s+(.+)$/i.exec(p.trim());
  if (m2) return [m2[1].replace(/\s+/g, ""), m2[2]];
  return [null, p.trim()];
}

const figure = (s: Stat): string => (s.unit ? `${s.value} ${s.unit}` : s.value);

/** The icon a keyword or a phrase names, else null. */
const glyph = (k: string | undefined): string => iconGlyphFor(k) ?? "";

/** An icon for a point: the one its own words name, else a numeral. */
const pointIcon = (p: string): string => glyph(p);

const attribution = (a: string | undefined): { name?: string; role?: string } => {
  if (!a) return {};
  const at = a.indexOf(",");
  if (at > 0) return { name: a.slice(0, at).trim(), role: a.slice(at + 1).trim() };
  return { name: a.trim() };
};

const contactIcon = (p: string): string | null => {
  if (/@/.test(p)) return "mail";
  if (/https?:\/\/|www\.|^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(p.trim())) return "world";
  if (/\+?\d[\d\s().-]{7,}\d/.test(p)) return "phone";
  return null;
};

const numeric = (s: string): number | null => {
  const m = /-?\d+(?:[.,]\d+)?/.exec(s.replace(/,/g, ""));
  if (!m) return null;
  const v = parseFloat(m[0]);
  if (!Number.isFinite(v)) return null;
  const mult = /[kK]\b/.test(s) ? 1e3 : /[mM]\b/.test(s) ? 1e6 : /[bB]n?\b/.test(s) ? 1e9 : 1;
  return v * mult;
};

// --- pictures -----------------------------------------------------------------------

interface PictureChoice { picture: L.PictureIntent | null; art?: string }

/** What a picture slot carries: a tagged placeholder for a photograph the
 *  pipeline will fetch or generate, else a drawing from the pack. */
function pictureFor(item: OutlineItem, K: KitLook, ctx: KitContext, slot: keyof KitLook["art"], prompts: Record<string, string>, seq: number, allowPhoto = true): PictureChoice {
  const im = item.image;
  // A slot is registered only where the layout draws one; the deep pages
  // (cover, section, closing) and the split and schedule compose a drawing in
  // a halo whatever the intent, so a prompt with no node to land on is never
  // handed to the picture pipeline.
  if (allowPhoto && im?.treatment === "photo" && im.subject) {
    const id = `img-${ctx.index + 1}-${seq}`;
    const prompt = `${im.subject}, clean professional photography, ${ctx.artDirection}`;
    prompts[id] = prompt;
    return { picture: { placeholderId: id, prompt } };
  }
  const seed = Array.from(item.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, ctx.index * 7919 + 17);
  return { picture: null, art: drawingFor(K, slot, item.drawing ?? im?.illustration ?? im?.subject, seed) };
}

// --- composition (the bespoke page) ------------------------------------------------

function composition(K: KitLook, i: number, item: OutlineItem, pic: PictureChoice): L.Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, item.eyebrow ?? "", item.title);
  const drawings: DrawingPrim[] = [];
  const comp = item.composition;
  if (!comp) return { name: "Composition", bg: g.bg, nodes, drawings };
  const gx = M, gy = bodyTop, gw = CW, gh = 940 - bodyTop - 16;
  const colW = (gw - 11 * 16) / 12, rowH = (gh - 5 * 16) / 6;
  const rectOf = (c: { col: number; span: number; row: number; rows: number }) => ({
    x: gx + c.col * (colW + 16), y: gy + c.row * (rowH + 16), w: c.span * colW + (c.span - 1) * 16, h: c.rows * rowH + (c.rows - 1) * 16,
  });
  const centers: { x: number; y: number }[] = [];
  comp.cells.forEach((c, k) => {
    const r = rectOf(c);
    centers.push({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const tone = c.tone ?? "plain";
    const deep = tone === "deep";
    if (deep) nodes.push(deepCard(K, r.x, r.y, r.w, r.h));
    else if (tone === "tint") nodes.push(card(K, g, r.x, r.y, r.w, r.h));
    else if (tone === "accent") nodes.push(rect(r.x, r.y, r.w, r.h, mixHex(g.panel, g.accent, 0.22), { radius: K.radius, panel: true }));
    const tt = deep ? td : t;
    const gg = deep ? d : g;
    const pad = tone === "plain" ? 0 : 28;
    const ix = r.x + pad, iy = r.y + pad, iw = r.w - 2 * pad, ih = r.h - 2 * pad;
    switch (c.kind) {
      case "heading": nodes.push(text(ix, iy, iw, ih, c.text ?? "", tt.display(Math.min(40, Math.max(24, Math.round(ih / 3))), { lineHeight: 1.1 }))); break;
      case "body": nodes.push(text(ix, iy, iw, ih, c.text ?? "", tt.body(22))); break;
      case "list": nodes.push(text(ix, iy, iw, ih, (c.points ?? []).map((p) => `•  ${p}`).join("\n"), tt.strong(22, { weight: 500, lineHeight: 1.45 }))); break;
      case "figure": {
        const v = c.unit ? `${c.value ?? ""} ${c.unit}` : (c.value ?? "");
        const size = Math.min(K.scale.numeral, Math.round(ih * 0.5));
        nodes.push(text(ix, iy, iw, size + 12, v, tt.numeral(size)));
        if (c.text) nodes.push(text(ix, iy + size + 20, iw, Math.max(30, ih - size - 20), c.text, tt.strong(22)));
        break;
      }
      case "label": nodes.push(text(ix, iy, iw, ih, c.text ?? "", tt.eyebrow())); break;
      case "icon": {
        const s = Math.min(iw, ih, 96);
        const gl = glyph(c.icon ?? c.text);
        nodes.push(ellipse(ix + iw / 2 - s / 2 - 16, iy + ih / 2 - s / 2 - 16, s + 32, s + 32, mixHex(gg.panel, gg.accent, 0.2), { panel: true }));
        if (gl) nodes.push(icon(gl, ix + iw / 2 - s / 2, iy + ih / 2 - s / 2, s, gg.accentInk ?? gg.accent));
        if (c.text) nodes.push(text(ix, iy + ih / 2 + s / 2 + 24, iw, 30, c.text, tt.strong(20, { align: "center" })));
        break;
      }
      case "picture": {
        const tint = { angle: 160, stops: [[mixHex(g.panel, g.accent2, 0.22), 0], [g.panel, 1]] as [string, number][] };
        if (pic.picture) nodes.push(photo(r.x, r.y, r.w, r.h, tint, { radius: K.radius, placeholderId: pic.picture.placeholderId, prompt: pic.picture.prompt }));
        else {
          nodes.push(photo(r.x, r.y, r.w, r.h, tint, { radius: K.radius }));
          if (pic.art) drawings.push({ kind: "drawing", asset: pic.art, x: r.x + 24, y: r.y + 24, w: r.w - 48, h: r.h - 48 });
        }
        break;
      }
    }
    void k;
  });
  for (const [a, b] of comp.links ?? []) {
    const p = centers[a], q = centers[b];
    if (!p || !q) continue;
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const from = { x: p.x + ux * 60, y: p.y + uy * 60 }, to = { x: q.x - ux * 60, y: q.y - uy * 60 };
    nodes.push(path([[from.x, from.y], [to.x, to.y]], { stroke: g.accent, strokeWidth: 3, decor: true }));
    nodes.push(path([[to.x - ux * 16 - uy * 9, to.y - uy * 16 + ux * 9], [to.x, to.y], [to.x - ux * 16 + uy * 9, to.y - uy * 16 - ux * 9]], { stroke: g.accent, strokeWidth: 3, decor: true }));
  }
  nodes.push(...note(K, g, item.aside));
  return { name: "Composition", bg: g.bg, nodes, drawings };
}

// --- signature forms -----------------------------------------------------------------------

/** The page's signature form when it named one the deck has not used and
 *  its fields can carry it. */
function signatureSlide(K: KitLook, i: number, item: OutlineItem, ctx: KitContext, eyebrow: string): L.Slide | null {
  const sig = item.signature as KitSignature | undefined;
  if (!sig || !kitSignatureNames.includes(sig) || ctx.signatureUsed.value) return null;
  const pts = item.points ?? [];
  const pairs = item.pairs ?? [];
  const stats = item.stats ?? (item.stat ? [item.stat] : []);
  const steps = item.steps ?? [];
  const cols = item.columns ?? [];
  const aside = item.aside;
  let slide: L.Slide | null = null;
  switch (sig) {
    case "scoreboard":
      if (stats.length >= 2) slide = SIGNATURES.scoreboard(K, i, { eyebrow, title: item.title, stats: stats.slice(0, 4).map((s, k) => [figure(s), s.label, pairs[k]?.value ?? ""]), lines: pts, note: aside });
      break;
    case "beforeAfter":
      if (cols.length >= 2) slide = SIGNATURES.beforeAfter(K, i, { eyebrow, title: item.title, before: { head: cols[0].heading, lines: cols[0].points }, after: { head: cols[1].heading, lines: cols[1].points }, note: aside });
      else if (pairs.length >= 2) slide = SIGNATURES.beforeAfter(K, i, { eyebrow, title: item.title, before: { head: item.subhead ?? "Before", lines: pairs.map((p) => p.label) }, after: { head: "After", lines: pairs.map((p) => p.value) }, note: aside });
      break;
    case "funnel":
      if (steps.length >= 2) slide = SIGNATURES.funnel(K, i, { eyebrow, title: item.title, steps: steps.map((s, k) => [s.label, pairs[k]?.value ?? (stats[k] ? figure(stats[k]) : ""), s.detail ?? ""]), note: aside });
      else if (stats.length >= 2) slide = SIGNATURES.funnel(K, i, { eyebrow, title: item.title, steps: stats.map((s, k) => [s.label, figure(s), pts[k] ?? ""]), note: aside });
      else if (pairs.length >= 2) slide = SIGNATURES.funnel(K, i, { eyebrow, title: item.title, steps: pairs.map((p, k) => [p.label, p.value, pts[k] ?? ""]), note: aside });
      break;
    case "ledger": {
      const rows: [string, string][] = pairs.length >= 2 ? pairs.map((p) => [p.label, p.value]) : item.table && item.table.columns.length >= 2 ? item.table.rows.map((r) => [r[0] ?? "", r[1] ?? ""]) : stats.length >= 2 ? stats.map((s) => [s.label, figure(s)]) : [];
      if (rows.length >= 2) {
        const totalRow = /total|sum|all in|overall/i.test(rows[rows.length - 1][0]) ? rows.pop() : undefined;
        slide = SIGNATURES.ledger(K, i, { eyebrow, title: item.title, rows, total: totalRow, footnote: item.subhead ?? pts[0], note: aside });
      }
      break;
    }
    case "stickyWall":
      if (pts.length >= 3) slide = SIGNATURES.stickyWall(K, i, { eyebrow, title: item.title, notes: pts, theme: item.subhead, note: aside });
      break;
    case "matrix": {
      const quads: [string, string[]][] = pairs.length >= 4 ? pairs.slice(0, 4).map((p) => [p.label, [p.value]]) : cols.length >= 4 ? cols.slice(0, 4).map((c) => [c.heading, c.points]) : pts.length >= 4 ? pts.slice(0, 4).map((p) => { const [h, s] = splitPoint(p); return [h, s ? [s] : []]; }) : [];
      if (quads.length === 4) slide = SIGNATURES.matrix(K, i, { eyebrow, title: item.title, quadrants: quads, note: aside });
      break;
    }
    case "runOfShow":
      if (steps.length >= 2 && steps.some((s) => s.when)) slide = SIGNATURES.runOfShow(K, i, { eyebrow, title: item.title, slots: steps.map((s) => [s.when ?? "", s.label, s.detail ?? ""]), note: aside });
      break;
    case "poll": {
      const src: [string, string][] = pairs.length >= 2 ? pairs.map((p) => [p.label, p.value]) : stats.length >= 2 ? stats.map((s) => [s.label, figure(s)]) : [];
      const bars = src.map(([l, v]) => [l, numeric(v), v] as [string, number | null, string]).filter((b): b is [string, number, string] => b[1] !== null && b[1] >= 0);
      if (bars.length >= 2) slide = SIGNATURES.poll(K, i, { eyebrow, title: item.title, bars, footnote: item.subhead, note: aside });
      break;
    }
    case "definition":
      if (item.subhead || pts.length) slide = SIGNATURES.definition(K, i, { term: item.title, kind: eyebrow || undefined, senses: pts.length ? pts : [item.subhead ?? ""], example: pts.length && item.subhead ? item.subhead : undefined, note: aside });
      break;
    case "healthGrid": {
      const tiles: [string, string, string][] = pairs.length >= 2 ? pairs.map((p, k) => [p.label, p.value, pts[k] ?? ""]) : item.table && item.table.columns.length >= 2 ? item.table.rows.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? ""]) : [];
      if (tiles.length >= 2) slide = SIGNATURES.healthGrid(K, i, { eyebrow, title: item.title, tiles, note: aside });
      break;
    }
  }
  if (slide) ctx.signatureUsed.value = true;
  return slide;
}

// --- the catalog forms ------------------------------------------------------------------------

function catalogSlide(K: KitLook, i: number, item: OutlineItem, ctx: KitContext, prompts: Record<string, string>): L.Slide {
  const arch: Archetype = item.archetype ?? "bullets";
  const eyebrow = item.eyebrow ?? "";
  const pts = item.points ?? [];
  const aside = item.aside;
  const pic = (slot: keyof KitLook["art"], allowPhoto = true) => pictureFor(item, K, ctx, slot, prompts, 1, allowPhoto);
  switch (arch) {
    case "cover": {
      const p = pic("cover", false);
      const chips = item.stats?.length ? item.stats.slice(0, 3).map((s) => [figure(s), s.label] as [string, string]) : undefined;
      // The mark already names the organization; the centered cover's meta
      // row is the one place it is said again.
      return L.cover(K, i, { title: item.title, subtitle: item.subhead, presenterName: K.ornament === "hairlines" && K.company ? K.company : undefined, chips, art: p.art, note: aside });
    }
    case "section": {
      const p = pic("section", false);
      return L.section(K, i, { n: ctx.section ? String(ctx.section).padStart(2, "0") : undefined, title: item.title, blurb: item.subhead ?? pts[0], art: p.art, note: aside });
    }
    case "statement":
      return L.statement(K, i, { text: item.title, source: item.subhead, note: aside });
    case "bigNumber": {
      const s = item.stat;
      if (!s) return L.statement(K, i, { text: item.title, source: item.subhead, note: aside });
      const delta = item.subhead && item.subhead.length <= 32 ? item.subhead : pts[0] && pts[0].length <= 32 ? pts[0] : undefined;
      return L.bigStat(K, i, { eyebrow: eyebrow || item.title, value: figure(s), caption: s.label, delta, note: aside ?? (item.subhead && item.subhead.length > 32 ? item.subhead : undefined) });
    }
    case "agenda": {
      const items = pts.map((p) => { const [h, s] = splitPoint(p); return [h, s, ""] as [string, string, string]; });
      const meta: [string, string][] = [["Slides", String(ctx.total)]];
      if (K.company) meta.push(["From", K.company]);
      if (K.kicker) meta.push(["Theme", K.kicker]);
      return L.agenda(K, i, { eyebrow, title: item.title, items, card: { eyebrow: item.subhead ? "Today" : "Topics", big: item.subhead ?? String(items.length).padStart(2, "0"), meta }, note: aside });
    }
    case "bullets": {
      const n = pts.length;
      if (n <= 3) {
        const p = pic("picture");
        return L.textPicture(K, i, { eyebrow, title: item.title, points: pts.map(splitPoint), art: p.art, picture: p.picture, note: aside });
      }
      if (n === 4) return L.fourCards(K, i, { eyebrow, title: item.title, cards: pts.map((p) => { const [h, s] = splitPoint(p); return [pointIcon(p) || glyph(item.icon), h, s]; }), note: aside });
      if (n === 5) {
        const p = pic("picture");
        return L.facts(K, i, { eyebrow, title: item.title, intro: item.subhead, items: pts.map((p0) => { const [h, s] = splitPoint(p0); return [pointIcon(p0), h, s]; }), art: p.art, picture: p.picture, note: aside });
      }
      const p = pic("picture");
      return L.checklist(K, i, { eyebrow, title: item.title, items: pts.map((p0) => [p0, true]), art: p.art, picture: p.picture, note: aside });
    }
    case "twoColumn": {
      const cols = item.columns ?? [];
      if (cols.length < 2) return L.textPicture(K, i, { eyebrow, title: item.title, points: pts.map(splitPoint), ...pic("picture"), note: aside });
      // A problem beside its answer is the pitch's split page: the problem
      // on the deep ground, the answer checked off on paper.
      if (/problem|challenge|pain|today|before|without/i.test(cols[0].heading) && /solution|answer|fix|approach|after|with|tomorrow|our/i.test(cols[1].heading)) {
        const p = pic("picture", false);
        return L.split(K, i, {
          left: { eyebrow: cols[0].heading, head: item.title, lines: cols[0].points },
          right: { eyebrow: cols[1].heading, head: cols[1].points.length > 1 ? item.subhead ?? cols[1].heading : cols[1].heading, body: cols[1].points.length > 1 ? undefined : item.subhead, checks: cols[1].points.map((p0) => [glyph(p0), p0] as [string, string]) },
          art: p.art,
        });
      }
      const col = (k: number): L.ColumnContent => ({ eyebrow: String(k + 1).padStart(2, "0"), head: cols[k].heading, lines: cols[k].points, icon: glyph(cols[k].icon) || undefined });
      return L.twoColumns(K, i, { eyebrow, title: item.title, left: col(0), right: col(1), note: aside });
    }
    case "threeUp": {
      const cols = item.columns ?? [];
      if (cols.length < 2) return L.textPicture(K, i, { eyebrow, title: item.title, points: pts.map(splitPoint), ...pic("picture"), note: aside });
      // Horizons (now, next, later; this quarter, next quarter) are the
      // roadmap's columns, the first on the deep ground.
      if (cols.length === 3 && cols.every((c) => /^(now|next|later|soon|this|q[1-4]|h[12]|20\d\d|today|tomorrow|short|mid|long|near|far)/i.test(c.heading))) {
        return L.columns(K, i, { eyebrow, title: item.title, intro: item.subhead, cols: cols.map((c) => [c.heading, c.icon ?? "", c.points.map((p0) => splitPoint(p0))]), note: aside });
      }
      return L.threeCards(K, i, { eyebrow, title: item.title, cards: cols.slice(0, 3).map((c) => [glyph(c.icon) || glyph(c.heading), c.heading, c.points.join("\n")]), note: aside });
    }
    case "process": {
      const steps = item.steps ?? [];
      if (steps.length < 2) return L.textPicture(K, i, { eyebrow, title: item.title, points: pts.map(splitPoint), ...pic("picture"), note: aside });
      if (steps.some((s) => s.when)) return L.timeline(K, i, { eyebrow, title: item.title, steps: steps.map((s) => [s.when ?? "", s.label, s.detail ?? ""]), note: aside });
      return L.process(K, i, { eyebrow, title: item.title, steps: steps.map((s) => [s.label, s.detail ?? ""]), note: aside });
    }
    case "timeline": {
      const steps = item.steps ?? [];
      if (steps.length < 2) return L.textPicture(K, i, { eyebrow, title: item.title, points: pts.map(splitPoint), ...pic("picture"), note: aside });
      // Steps stamped with clock times are a day's schedule: slots down the
      // left, the evening on a deep card at right.
      if (steps.length >= 3 && steps.filter((s) => /^\d{1,2}[:.]\d{2}/.test(s.when ?? "")).length >= steps.length - 1) {
        const p = pic("section", false);
        const last = steps[steps.length - 1];
        return L.schedule(K, i, { eyebrow, title: item.title, slots: steps.slice(0, 6).map((s) => [s.when ?? "", s.label, s.detail ?? ""]), after: { eyebrow: item.subhead ? "Then" : last.when ?? "", head: item.subhead ?? last.label, note: aside }, art: p.art });
      }
      return L.timeline(K, i, { eyebrow, title: item.title, steps: steps.map((s) => [s.when ?? "", s.label, s.detail ?? ""]), note: aside });
    }
    case "quote": {
      const q = item.quote;
      const who = attribution(q?.attribution);
      return L.quote(K, i, { text: q?.text ?? item.title, name: who.name, role: who.role, note: aside });
    }
    case "imageCaption": {
      const p = pic("picture");
      return L.facts(K, i, { eyebrow, title: item.title, intro: item.subhead, items: pts.map((p0) => { const [h, s] = splitPoint(p0); return [pointIcon(p0), h, s]; }), art: p.art, picture: p.picture, note: aside });
    }
    case "chart": {
      const ch = item.chart;
      if (!ch) return L.statement(K, i, { text: item.title, source: item.subhead, note: aside });
      const kind = ch.kind === "bar" ? (ch.series.length > 1 ? "barGrouped" : "bar") : ch.kind;
      const calls: [string | null, string][] = pts.length ? pts.map(leadingFigure) : (item.stats ?? []).map((s) => [figure(s), s.label]);
      return L.chart(K, i, { eyebrow, title: item.title, takeaway: item.subhead, chartType: kind, categories: ch.categories, series: ch.series, calls, note: aside });
    }
    case "kpiGrid": {
      const stats = item.stats ?? (item.stat ? [item.stat] : []);
      if (!stats.length) return L.statement(K, i, { text: item.title, source: item.subhead, note: aside });
      return L.figures(K, i, { eyebrow, title: item.title, stats: stats.slice(0, 4).map((s, k) => [figure(s), s.label, item.pairs?.[k]?.value ?? "", pts[k] ?? ""]), note: aside });
    }
    case "table": {
      const tb = item.table;
      if (!tb) return L.statement(K, i, { text: item.title, source: item.subhead, note: aside });
      return L.table(K, i, { eyebrow, title: item.title, cols: tb.columns, rows: tb.rows, note: aside });
    }
    case "team": {
      const people = item.people ?? [];
      if (!people.length) return L.statement(K, i, { text: item.title, source: item.subhead, note: aside });
      return L.team(K, i, { eyebrow, title: item.title, people: people.slice(0, 4).map((p, k) => [p.name, p.role ?? "", pts[k] ?? ""]), note: aside });
    }
    case "composition":
      return composition(K, i, item, pic("picture"));
    case "closing": {
      const p = pic("closing", false);
      const rows: [string, string][] = [];
      const rest: string[] = [];
      for (const p0 of pts) { const ic = contactIcon(p0); if (ic && rows.length < 3) rows.push([ic, p0]); else rest.push(p0); }
      const cta = rest.find((r) => r.length <= 32);
      const subtitle = [item.subhead, ...rest.filter((r) => r !== cta)].filter(Boolean).join(" ");
      return L.closing(K, i, { title: item.title, subtitle: subtitle || undefined, rows, cta, art: p.art, note: aside });
    }
    default: {
      const p = pic("picture");
      return L.textPicture(K, i, { eyebrow, title: item.title, points: pts.map(splitPoint), art: p.art, picture: p.picture, note: aside });
    }
  }
}

/** Compose one outline page as a kit slide. */
export function composeKitPage(item: OutlineItem, K: KitLook, ctx: KitContext): ComposedPage {
  const prompts: Record<string, string> = {};
  const slide = signatureSlide(K, ctx.index, item, ctx, item.eyebrow ?? "") ?? catalogSlide(K, ctx.index, item, ctx, prompts);
  const { nodes, overfull } = compileSlide(slide.nodes as Prim[], slide.drawings);
  applyMotion(nodes as Array<{ name?: string; animation?: unknown }>, ctx.motion);
  scaleNodes(nodes, ctx.scale);
  const background: Fill = fillOf(slide.bg);
  return {
    background,
    nodes: nodes as Node[],
    imagePrompts: prompts,
    impact: DEEP_FORMS.has(slide.name),
    archetype: item.archetype ?? "bullets",
    overfull,
  };
}

/** Whether the kit can set a deck of this size and kind: a 16 by 9 page
 *  (any size) for a deck; posts, posters and documents keep the classic
 *  composer, whose forms are drawn for their proportions. */
export function kitFits(size: { width: number; height: number }, designType?: DesignType): boolean {
  if (designType && designType !== "deck") return false;
  if (size.width <= 0 || size.height <= 0) return false;
  return Math.abs(size.width / size.height - 16 / 9) < 0.03;
}
