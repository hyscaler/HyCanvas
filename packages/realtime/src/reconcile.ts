// CRDT reconciler (FR-1, FR-2). The editor mutates a plain JS
// `DesignFile`; this module pushes that plain object INTO a live Y.Doc's nested
// shared types under designRootKey, producing the MINIMAL set of Yjs ops that
// makes the Y.Doc match the JS doc. Minimal ops matter: when two clients edit
// different nodes (or different fields of one node), the granular ops merge
// conflict-free under Yjs CRDT semantics with no lost intent (AC-2/AC-3). A
// naive "clear and re-toY the whole tree" would touch every node and clobber
// concurrent edits, so we diff structurally instead.
//
// Mapping mirrors @hc/schema's snapshot bridge exactly (objects -> Y.Map,
// arrays -> Y.Array, primitives as-is), so `fromY(ydoc)` after `reconcile(doc,
// ydoc)` deep-equals `doc`.

import * as Y from "yjs";
import { designRootKey, type DesignFile } from "@hc/schema";

/** Origin tag stamped on the transaction wrapping a local reconcile. The client
 *  binding observes for updates whose origin is NOT this, to apply remote edits
 *  without echoing them back. */
export const localOrigin = "local";

// F16 move/intention primitive: keyed-array items (pages, children, operands)
// carry a synthetic numeric rank under this key so ORDER is a per-item property,
// not the Y.Array position. A reorder then becomes a property edit on the
// existing Y.Map (it never deletes + reinserts the node), so a peer's concurrent
// CONTENT edit on a moved node is preserved instead of lost. The key is internal
// to the CRDT layer: reconcile sets it, `yToJson`/`fromDoc` sort by it and strip
// it, so it never appears in the open-format DesignFile.
const ORDER_KEY = "__ord";
// Smallest gap allowed between two adjacent ranks before the array is fully
// renormalized to integers (guards float-midpoint precision exhaustion).
const ORDER_MIN_GAP = 1e-6;

// F16 character-level rich text. A text node's content is Paragraph[] and each
// Paragraph holds runs: Run[] ({text, style, ...}). Instead of storing runs as a
// Y.Array (which the idless-array path delete+reinserts wholesale on any edit, so
// two people typing in the same paragraph clobber each other), a CANONICAL
// paragraph's runs are stored as a Yjs Y.Text whose formatting deltas encode the
// per-run styling. The reconciler reverse-engineers a minimal character-level
// diff (prefix/suffix on the plain text + a formatting pass) from the
// before/after run arrays, so the editor needs no changes yet concurrent edits
// merge per character under Yjs. Each run's non-text payload (style, charStyleId,
// overrides, ...) rides as one delta attribute under this key; the run text is
// the Y.Text content.
const RUN_ATTR_KEY = "r";
// A paragraph is CANONICAL when a Y.Text delta can represent it losslessly: every
// run has non-empty text and no two adjacent runs share an identical payload (the
// shape live typing produces, since the editor coalesces). Only canonical
// paragraphs get the character-merge path. A NON-canonical paragraph (any
// empty-text run, or adjacent identical-payload runs - shapes that arrive from
// import / AI / a brand recolor that mutates every run's style to a common value)
// cannot survive a Y.Text round-trip: Yjs deltas have no zero-length op for an
// empty run, and Yjs re-coalesces adjacent equal-attribute ops, collapsing run
// boundaries. Such a paragraph instead stores its EXACT runs as JSON under this
// key (its Y.Text kept empty), so it round-trips faithfully; it loses
// character-level merge until the next edit re-canonicalizes it (the editor's run
// coalescing makes any typed-into paragraph canonical again). Like __ord this key
// is CRDT-internal and is stripped from the open-format DesignFile.
const RUNS_STASH_KEY = "__runs";

/** A Yjs rich-text delta op: a run of text plus its formatting attributes. */
type DeltaOp = { insert: string; attributes?: Record<string, unknown> };

type JsonObject = Record<string, unknown>;

/**
 * Materialize a plain JSON value as the equivalent Yjs shared type using THIS
 * package's `Y` (objects -> Y.Map, arrays -> Y.Array, primitives as-is). Mirrors
 * @hc/schema's `toY` exactly; kept local so every Y type we insert is created
 * from the same yjs module instance as the target doc (inserting a Y type from a
 * different module copy throws "Unexpected content type").
 */
function jsonToY(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>();
    arr.push(value.map(jsonToY));
    return arr;
  }
  if (isPlainObject(value)) {
    const map = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) map.set(k, jsonToY(v));
    }
    return map;
  }
  return value; // string | number | boolean | null
}

/** True for a plain JS object (the things that map to a Y.Map). */
function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An array whose items are all objects carrying a string `id` (pages, children,
 *  operands): such arrays are diffed by id so reorders/inserts/removals are
 *  granular and matched items recurse. Empty arrays are not keyed. */
function isKeyedArray(arr: unknown[]): arr is JsonObject[] {
  return (
    arr.length > 0 &&
    arr.every((it) => isPlainObject(it) && typeof (it as JsonObject).id === "string")
  );
}

/**
 * An array of rich-text Paragraphs (a text node's `content`): every item is a
 * plain object with a `runs` array and a `style` object, and NO `id` (paragraphs
 * are idless, so this never collides with the keyed-array path). Such arrays get
 * the Y.Text rich-text treatment (see RUN_ATTR_KEY) instead of wholesale replace.
 * The `runs`+`style` shape is unique to Paragraph across the schema.
 */
function isParagraphArray(arr: unknown[]): arr is JsonObject[] {
  return (
    arr.length > 0 &&
    arr.every(
      (it) =>
        isPlainObject(it) &&
        Array.isArray((it as JsonObject).runs) &&
        isPlainObject((it as JsonObject).style) &&
        (it as JsonObject).id === undefined,
    )
  );
}

/** A run's non-text payload (style, charStyleId, overrides, ...): everything that
 *  rides in the delta attribute. Used to detect adjacent identical-payload runs. */
function runPayload(run: JsonObject): JsonObject {
  const { text: _text, ...payload } = run;
  void _text;
  return payload;
}

/**
 * True when a paragraph's runs can be represented losslessly by a Y.Text delta:
 * every run is a plain object with NON-EMPTY text, and no two adjacent runs share
 * an identical payload (which Yjs would coalesce, dropping the boundary). An empty
 * `runs: []` is canonical (it maps to an empty Y.Text and round-trips to []).
 * Non-canonical paragraphs fall back to the verbatim JSON stash (RUNS_STASH_KEY).
 */
function isCanonicalRuns(runs: unknown[]): boolean {
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (!isPlainObject(r) || typeof r.text !== "string" || r.text.length === 0) return false;
    if (i > 0 && deepEqual(runPayload(runs[i - 1] as JsonObject), runPayload(r))) return false;
  }
  return true;
}

/** Structural deep-equality for JSON values (used to decide whether an idless /
 *  primitive array needs replacing). Key order is ignored for objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Project a live Y value back to plain JSON (objects from Y.Map, arrays from
 * Y.Array, primitives as-is). Mirrors @hc/schema's `fromY`/`toDesignFile`, but
 * kept local so the `instanceof Y.Map` checks run against THIS package's `Y`
 * instance. Used both for diff equality checks and by {@link fromDoc}.
 */
export function yToJson(value: unknown): unknown {
  // A paragraph's runs are stored as a Y.Text (rich-text deltas); reconstruct the
  // Run[] array from its delta (see RUN_ATTR_KEY). Empty paragraphs yield [], and
  // the Y.Map branch below restores their stashed runs from RUNS_STASH_KEY.
  if (value instanceof Y.Text) {
    return deltaToRuns(value.toDelta() as DeltaOp[]);
  }
  if (value instanceof Y.Array) {
    const raw = value.toArray();
    const items = raw.map(yToJson);
    // Keyed array (every item is an object with a string id): present it in rank
    // order. The rank lives on each item's source Y.Map under __ord; read it from
    // there (the projected objects already had __ord stripped by the Y.Map branch
    // below). Sort ascending with the id as a deterministic tiebreak for equal /
    // colliding ranks across clients. An item with NO rank sorts to the END
    // (fallback +Infinity): the only producer of an unranked item among ranked
    // siblings is enforce.ts reinsertNode (a server lock-enforcement re-insert via
    // reconcileNodeMap, which does not run assignOrder), and its documented intent
    // is "append, best-effort order" - so trailing is correct, not front.
    if (items.length > 0 && items.every((it) => isPlainObject(it) && typeof (it as JsonObject).id === "string")) {
      const objs = items as JsonObject[];
      const ranks = raw.map((src) => {
        const o = src instanceof Y.Map ? src.get(ORDER_KEY) : undefined;
        return typeof o === "number" && Number.isFinite(o) ? o : null;
      });
      if (ranks.some((r) => r !== null)) {
        const order = objs.map((obj, i) => ({ obj, rank: ranks[i] ?? Number.POSITIVE_INFINITY, id: obj.id as string }));
        order.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return order.map((e) => e.obj);
      }
      return objs;
    }
    return items;
  }
  if (value instanceof Y.Map) {
    const obj: JsonObject = {};
    // __ord (rank) and __runs (non-canonical paragraph runs stash) are
    // CRDT-internal; never project them into plain JSON, so a serialization
    // round-trips to the open format unchanged.
    for (const [k, v] of value.entries()) {
      if (k === ORDER_KEY || k === RUNS_STASH_KEY) continue;
      obj[k] = yToJson(v);
    }
    // A non-canonical paragraph kept its Y.Text empty and stashed its exact runs
    // as JSON; restore them verbatim (the projected runs are []). The stash is
    // opaque CRDT content the relay never validates, so a hostile/corrupt PEER
    // could write a malformed stash ("[null]", "[42]", "[{}]"); accept it only
    // when every element is a well-formed run (an object with a string `text`),
    // otherwise degrade to an empty paragraph. This keeps a malformed run from
    // reaching the non-defensive text engine (run.text.split) and crashing every
    // collaborator's render.
    const stash = value.get(RUNS_STASH_KEY);
    if (typeof stash === "string" && Array.isArray(obj.runs) && obj.runs.length === 0) {
      try {
        const parsed = JSON.parse(stash);
        if (Array.isArray(parsed) && parsed.every((r) => isPlainObject(r) && typeof (r as JsonObject).text === "string")) {
          obj.runs = parsed;
        }
      } catch {
        /* ignore a corrupt stash; leave runs empty */
      }
    }
    return obj;
  }
  return value;
}

/**
 * Sync a plain JS object into a Y.Map: set only changed scalar keys, recurse
 * into child Y.Map/Y.Array (creating one when missing or the wrong type), and
 * delete Y keys that are absent from the JS object. `undefined` JS values are
 * treated as absent (matching toY, which skips undefined).
 */
function reconcileMap(target: Y.Map<unknown>, source: JsonObject): void {
  // Update / insert keys present in the source.
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv === undefined) {
      if (target.has(key)) target.delete(key);
      continue;
    }
    reconcileChild(target, key, sv);
  }
  // Delete keys the source no longer has. The synthetic __ord rank is owned by
  // the keyed-array reconcile (not present in the source JSON), so never drop it
  // here, or a content reconcile / lock-restore would wipe the item's order.
  for (const key of [...target.keys()]) {
    if (key === ORDER_KEY) continue;
    if (!(key in source) || source[key] === undefined) target.delete(key);
  }
}

/** Reconcile a single child slot (`key`) of a Y.Map against a JS value. */
function reconcileChild(parent: Y.Map<unknown>, key: string, sv: unknown): void {
  const cur = parent.get(key);
  if (Array.isArray(sv)) {
    if (cur instanceof Y.Array) {
      reconcileArray(cur, sv);
    } else {
      const arr = new Y.Array<unknown>();
      parent.set(key, arr);
      reconcileArray(arr, sv);
    }
    return;
  }
  if (isPlainObject(sv)) {
    if (cur instanceof Y.Map) {
      reconcileMap(cur, sv);
    } else {
      const map = new Y.Map<unknown>();
      parent.set(key, map);
      reconcileMap(map, sv);
    }
    return;
  }
  // Scalar: write only when it actually differs (minimal ops).
  if (cur !== sv) parent.set(key, sv);
}

/** Reconcile a Y.Array against a JS array. */
function reconcileArray(target: Y.Array<unknown>, source: unknown[]): void {
  if (isParagraphArray(source)) {
    reconcileParagraphArray(target, source);
  } else if (isKeyedArray(source)) {
    reconcileKeyedArray(target, source);
  } else {
    reconcilePlainArray(target, source);
  }
}

/**
 * Idless / primitive array (path segments, dash patterns, run text...): there is
 * no stable key to diff against, so replace the contents only when the array
 * actually changed. Replacing in one transaction keeps it a single granular op
 * scoped to this array, not the whole tree.
 */
function reconcilePlainArray(target: Y.Array<unknown>, source: unknown[]): void {
  if (deepEqual(yToJson(target), source)) return;
  if (target.length > 0) target.delete(0, target.length);
  target.push(source.map(jsonToY));
}

/**
 * Keyed array (items have stable `id`): diff by id so concurrent edits to
 * different items never collide. Steps: (1) remove items whose id vanished,
 * (2) recurse into items that still exist, (3) insert brand-new items, then
 * (4) reorder so the Y.Array order matches the JS order.
 */
function reconcileKeyedArray(target: Y.Array<unknown>, source: JsonObject[]): void {
  // Index the live array by id.
  const liveById = new Map<string, Y.Map<unknown>>();
  for (const item of target.toArray()) {
    if (item instanceof Y.Map) {
      const id = item.get("id");
      if (typeof id === "string") liveById.set(id, item);
    }
  }
  const sourceIds = new Set(source.map((s) => s.id as string));

  // (1) Remove items no longer present (delete from the tail to keep indices
  // valid as we splice).
  for (let i = target.length - 1; i >= 0; i--) {
    const item = target.get(i);
    const id = item instanceof Y.Map ? item.get("id") : undefined;
    if (typeof id !== "string" || !sourceIds.has(id)) {
      target.delete(i, 1);
      if (typeof id === "string") liveById.delete(id);
    }
  }

  // (2) Recurse into matched items; (3) insert new items, appended in source
  // order so a later reorder pass settles them into place.
  for (const s of source) {
    const id = s.id as string;
    const live = liveById.get(id);
    if (live) {
      reconcileMap(live, s);
    } else {
      const map = new Y.Map<unknown>();
      target.push([map]);
      reconcileMap(map, s);
      liveById.set(id, map);
    }
  }

  // (4) Assign each item a fractional rank reflecting the SOURCE order. Unlike a
  // Y.Array move (delete + reinsert, which tombstones the node and loses a peer's
  // concurrent content edit), this writes only the __ord property on the existing
  // item Y.Maps, so a reorder and a concurrent content edit merge with no loss.
  // Physical Y.Array position is now irrelevant: yToJson sorts by __ord.
  const inOrder: Y.Map<unknown>[] = [];
  for (const s of source) {
    const m = liveById.get(s.id as string);
    if (m instanceof Y.Map) inOrder.push(m);
  }
  assignOrder(inOrder);
}

/**
 * Give the keyed-array items (already in the desired order) a strictly-increasing
 * numeric __ord rank, changing as FEW ranks as possible: items whose existing
 * rank already keeps the sequence increasing are anchors left untouched; only
 * out-of-place / new items get a fresh rank between their neighbors. When a gap
 * is too small to subdivide (float precision), the whole array is renumbered to
 * integers. Every write is a property set on an existing Y.Map (no delete), so
 * concurrent content edits on these nodes survive (the move/intention primitive).
 */
function assignOrder(items: Y.Map<unknown>[]): void {
  const n = items.length;
  if (n === 0) return;
  const keys: (number | null)[] = items.map((m) => {
    const v = m.get(ORDER_KEY);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  });
  // Greedy anchors: keep an item iff its rank continues a strictly increasing run.
  const keep: boolean[] = new Array(n).fill(false);
  let prev = -Infinity;
  for (let i = 0; i < n; i++) {
    if (keys[i] !== null && (keys[i] as number) > prev) {
      keep[i] = true;
      prev = keys[i] as number;
    }
  }
  let renumber = false;
  let i = 0;
  while (i < n) {
    if (keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !keep[j]) j++;
    const left = i > 0 ? (keys[i - 1] as number) : null; // i-1 is an anchor (or start)
    const right = j < n ? (keys[j] as number) : null; // j is an anchor (or end)
    const between = spreadRanks(left, right, j - i);
    if (between === null) {
      renumber = true;
      break;
    }
    for (let k = 0; k < between.length; k++) {
      items[i + k].set(ORDER_KEY, between[k]);
      keys[i + k] = between[k];
    }
    i = j;
  }
  if (renumber) {
    for (let k = 0; k < n; k++) items[k].set(ORDER_KEY, k);
  }
}

/**
 * `count` strictly-increasing numbers in the open interval (left, right); a null
 * bound is open. Returns null when a both-bounded interval is too small to
 * subdivide, signalling the caller to renumber the whole array.
 */
function spreadRanks(left: number | null, right: number | null, count: number): number[] | null {
  const out: number[] = [];
  if (left !== null && right !== null) {
    if (right - left <= ORDER_MIN_GAP) return null;
    const step = (right - left) / (count + 1);
    for (let k = 0; k < count; k++) out.push(left + step * (k + 1));
  } else if (left !== null) {
    for (let k = 0; k < count; k++) out.push(left + (k + 1));
  } else if (right !== null) {
    for (let k = 0; k < count; k++) out.push(right - (count - k));
  } else {
    for (let k = 0; k < count; k++) out.push(k);
  }
  return out;
}

// --- Rich-text (Y.Text) reconcile ------------------------------------------

/** Deep-clone a JSON-safe value so the Y.Doc owns attribute payloads
 *  independently of the store (the engine mutates run.style in place on resize,
 *  which must never reach back into Yjs internals). */
function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Serialize a paragraph's runs to a coalesced rich-text delta. Each run's text
 *  is the insert; everything else (style, charStyleId, overrides, ...) rides as
 *  one attribute. Empty-text runs contribute no characters. Adjacent runs with
 *  equal attributes are merged, mirroring Yjs `toDelta` and the editor's own run
 *  coalescing, so a round-trip is stable and idempotent. */
function runsToDelta(runs: unknown[]): DeltaOp[] {
  const ops: DeltaOp[] = [];
  for (const run of runs) {
    if (!isPlainObject(run) || typeof run.text !== "string" || run.text.length === 0) continue;
    const { text, ...payload } = run;
    const attrs = { [RUN_ATTR_KEY]: cloneJson(payload) };
    const last = ops[ops.length - 1];
    if (last && deepEqual(last.attributes, attrs)) last.insert += text;
    else ops.push({ insert: text, attributes: attrs });
  }
  return ops;
}

/** Reconstruct a paragraph's runs from a rich-text delta (the inverse of
 *  {@link runsToDelta}). Payloads are cloned so the store never aliases Yjs. */
function deltaToRuns(delta: DeltaOp[]): JsonObject[] {
  const runs: JsonObject[] = [];
  for (const op of delta) {
    if (typeof op.insert !== "string") continue;
    const payload = op.attributes?.[RUN_ATTR_KEY];
    runs.push({ text: op.insert, ...(isPlainObject(payload) ? cloneJson(payload) : {}) });
  }
  return runs;
}

/** True when two deltas are op-for-op identical (insert text + attributes). */
function deltaEqual(a: DeltaOp[], b: DeltaOp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].insert !== b[i].insert) return false;
    if (!deepEqual(a[i].attributes ?? null, b[i].attributes ?? null)) return false;
  }
  return true;
}

/** Expand a delta to a per-character attributes array of length `len`. */
function expandAttrs(delta: DeltaOp[], len: number): (Record<string, unknown> | undefined)[] {
  const out: (Record<string, unknown> | undefined)[] = new Array(len);
  let i = 0;
  for (const op of delta) {
    if (typeof op.insert !== "string") continue;
    for (let k = 0; k < op.insert.length && i < len; k++) out[i++] = op.attributes;
  }
  return out;
}

/**
 * Reconcile a paragraph's runs into a live Y.Text with minimal, character-level
 * ops so concurrent edits in the same paragraph merge under Yjs:
 *  1. Bail out when the live delta already equals the desired one (zero ops).
 *  2. Text pass: a single contiguous prefix/suffix diff on the plain text
 *     (correct for typical typing; a coarser-but-correct single replacement for
 *     multi-region edits). Char-granular insert/delete merge by Yjs position.
 *  3. Format pass: reassert run styling over only the maximal ranges whose
 *     attributes differ (freshly inserted chars are unformatted, so they are
 *     fixed here too). The end state's delta equals the desired delta, keeping
 *     the next reconcile a no-op.
 */
function reconcileRunsAsText(ytext: Y.Text, runs: unknown[]): void {
  const desired = runsToDelta(runs);
  if (deltaEqual(ytext.toDelta() as DeltaOp[], desired)) return;

  const oldText = ytext.toString();
  const newText = desired.reduce((acc, op) => acc + op.insert, "");

  // Empty Y.Text: insert each run directly with its attributes (one-time seed).
  if (oldText.length === 0) {
    let at = 0;
    for (const op of desired) {
      ytext.insert(at, op.insert, op.attributes);
      at += op.insert.length;
    }
    return;
  }

  // (1) Text reconciliation via a single prefix/suffix diff.
  if (oldText !== newText) {
    const cap = Math.min(oldText.length, newText.length);
    let pre = 0;
    while (pre < cap && oldText[pre] === newText[pre]) pre++;
    let suf = 0;
    while (suf < cap - pre && oldText[oldText.length - 1 - suf] === newText[newText.length - 1 - suf]) suf++;
    const delLen = oldText.length - pre - suf;
    if (delLen > 0) ytext.delete(pre, delLen);
    const ins = newText.slice(pre, newText.length - suf);
    if (ins.length > 0) ytext.insert(pre, ins); // attributes applied by the format pass
  }

  // (2) Formatting reconciliation over the now length-matched text.
  const want = expandAttrs(desired, newText.length);
  const have = expandAttrs(ytext.toDelta() as DeltaOp[], newText.length);
  let i = 0;
  while (i < newText.length) {
    if (deepEqual(have[i] ?? null, want[i] ?? null)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < newText.length && deepEqual(want[j] ?? null, want[i] ?? null) && !deepEqual(have[j] ?? null, want[j] ?? null)) {
      j++;
    }
    ytext.format(i, j - i, (want[i] ?? {}) as Record<string, unknown>);
    i = j;
  }
}

/** Reconcile a paragraph's `runs` into its Y.Map. A canonical paragraph uses the
 *  Y.Text character-merge path; a non-canonical one stores its exact runs as JSON
 *  under RUNS_STASH_KEY (Y.Text kept empty) so it round-trips faithfully. The
 *  stash write is value-compare guarded so an unchanged paragraph emits no op (so
 *  a peer concurrently editing the same paragraph is not clobbered, and reconcile
 *  stays idempotent). */
function reconcileRuns(pmap: Y.Map<unknown>, runs: unknown[]): void {
  const existing = pmap.get("runs");
  const yt: Y.Text = existing instanceof Y.Text ? existing : new Y.Text();
  if (!(existing instanceof Y.Text)) pmap.set("runs", yt);

  if (isCanonicalRuns(runs)) {
    reconcileRunsAsText(yt, runs);
    if (pmap.has(RUNS_STASH_KEY)) pmap.delete(RUNS_STASH_KEY);
  } else {
    // Non-canonical: the Y.Text cannot represent it losslessly. Keep the Y.Text
    // empty (vestigial) and store the exact runs as JSON; read prefers the stash.
    if (yt.length > 0) yt.delete(0, yt.length);
    const next = JSON.stringify(runs);
    if (pmap.get(RUNS_STASH_KEY) !== next) pmap.set(RUNS_STASH_KEY, next);
  }
}

/** Reconcile one paragraph's plain object into its Y.Map: runs via {@link
 *  reconcileRuns} (Y.Text or stash), everything else through the normal
 *  structural path. */
function reconcileParagraphMap(pmap: Y.Map<unknown>, para: JsonObject): void {
  for (const key of Object.keys(para)) {
    const v = para[key];
    if (v === undefined) {
      if (pmap.has(key)) pmap.delete(key);
      continue;
    }
    if (key === "runs" && Array.isArray(v)) {
      reconcileRuns(pmap, v);
      continue;
    }
    reconcileChild(pmap, key, v);
  }
  // Delete keys absent from the source, except the CRDT-internal runs stash.
  for (const key of [...pmap.keys()]) {
    if (key === RUNS_STASH_KEY) continue;
    if (!(key in para) || para[key] === undefined) pmap.delete(key);
  }
}

/** True when a live paragraph Y.Map projects deep-equal to a source paragraph. */
function paragraphEqual(live: unknown, src: JsonObject): boolean {
  return live instanceof Y.Map && deepEqual(yToJson(live), src);
}

/**
 * Reconcile a text node's `content` (Paragraph[]) into a Y.Array of paragraph
 * Y.Maps. Deep-equal paragraphs at the head and tail are left UNTOUCHED so their
 * Y.Texts (and any in-flight character merges) survive; only the changed middle
 * is reconciled in place (position-matched) with inserts/deletes for length
 * changes. This keeps editing paragraph N from disturbing its siblings and makes
 * append/prepend minimal. (Concurrent paragraph splits/merges fall back to
 * position alignment in the changed window; character merge within a paragraph,
 * the common case, is unaffected.)
 */
function reconcileParagraphArray(target: Y.Array<unknown>, source: JsonObject[]): void {
  const live = target.toArray();
  const liveLen = live.length;
  const srcLen = source.length;
  const cap = Math.min(liveLen, srcLen);

  let pre = 0;
  while (pre < cap && paragraphEqual(live[pre], source[pre])) pre++;
  let suf = 0;
  while (suf < cap - pre && paragraphEqual(live[liveLen - 1 - suf], source[srcLen - 1 - suf])) suf++;

  const liveMidEnd = liveLen - suf;
  const srcMidEnd = srcLen - suf;
  const overlap = Math.min(liveMidEnd - pre, srcMidEnd - pre);

  // Reconcile the overlapping middle in place (preserves the edited paragraph's Y.Text).
  for (let k = 0; k < overlap; k++) {
    const pm = live[pre + k];
    if (pm instanceof Y.Map) reconcileParagraphMap(pm, source[pre + k]);
  }
  if (srcMidEnd - pre > overlap) {
    // Source has extra paragraphs in the middle: insert them before the tail.
    let pos = pre + overlap;
    for (let k = pre + overlap; k < srcMidEnd; k++) {
      const pm = new Y.Map<unknown>();
      target.insert(pos, [pm]);
      reconcileParagraphMap(pm, source[k]);
      pos++;
    }
  } else if (liveMidEnd - pre > overlap) {
    // Live has extra paragraphs in the middle: drop them.
    target.delete(pre + overlap, liveMidEnd - pre - overlap);
  }
}

/**
 * Idempotently sync a plain JS `DesignFile` into a Y.Doc's nested shared types
 * under designRootKey, producing minimal Yjs ops. Runs inside one
 * `ydoc.transact(..., localOrigin)` so the whole reconcile is a single,
 * locally-originated update the binding can tell apart from remote updates.
 *
 * After `reconcile(doc, ydoc)`, `fromY(ydoc)` (a.k.a. `toDesignFile(ydoc)`)
 * deep-equals `doc`.
 */
export function reconcile(doc: DesignFile, ydoc: Y.Doc): void {
  const root = ydoc.getMap(designRootKey);
  ydoc.transact(() => {
    reconcileMap(root, doc as unknown as JsonObject);
  }, localOrigin);
}

/**
 * Project a Y.Doc's design state back to a plain `DesignFile` (the inverse of
 * {@link reconcile}). Equivalent to @hc/schema's `toDesignFile`, but uses this
 * package's `Y` so it works on docs whose shared types were created here even
 * when a bundler hands the two packages distinct yjs module instances.
 */
export function fromDoc(ydoc: Y.Doc): DesignFile {
  return yToJson(ydoc.getMap(designRootKey)) as DesignFile;
}

/**
 * fromDoc with PAGE-GRANULAR reuse (doc 16 FR-2/FR-7 incremental apply at
 * scale). Projecting a large multi-page document on every remote update is the
 * client's scale bottleneck: a peer's one-shape move re-serializes all 50
 * pages. This variant projects only pages absent from `reusable`; for the rest
 * it emits the caller's existing JS page objects untouched (the caller
 * guarantees they are in sync with the Y state - i.e. it tracked which pages a
 * transaction actually changed). Page ORDER always comes from the live __ord
 * ranks, so reordering works even against fully reused bodies. Everything
 * outside `pages` projects normally.
 */
export function fromDocWithPageReuse(ydoc: Y.Doc, reusable: ReadonlyMap<string, unknown>): DesignFile {
  const root = ydoc.getMap(designRootKey);
  const out: JsonObject = {};
  for (const [k, v] of root.entries()) {
    if (k === ORDER_KEY || k === RUNS_STASH_KEY) continue;
    if (k === "pages" && v instanceof Y.Array && reusable.size > 0) {
      out[k] = projectPagesWithReuse(v, reusable);
    } else {
      out[k] = yToJson(v);
    }
  }
  return out as unknown as DesignFile;
}

/** Project a keyed pages array, substituting reusable bodies; mirrors yToJson's
 *  keyed-array rank sort (ascending __ord, id tiebreak, unranked last). */
function projectPagesWithReuse(pages: Y.Array<unknown>, reusable: ReadonlyMap<string, unknown>): unknown[] {
  const raw = pages.toArray();
  let ranked = false;
  const entries = raw.map((src) => {
    const id = src instanceof Y.Map ? src.get("id") : undefined;
    const o = src instanceof Y.Map ? src.get(ORDER_KEY) : undefined;
    const hasRank = typeof o === "number" && Number.isFinite(o);
    if (hasRank) ranked = true;
    const cached = typeof id === "string" ? reusable.get(id) : undefined;
    return { obj: cached ?? yToJson(src), rank: hasRank ? (o as number) : Number.POSITIVE_INFINITY, id: typeof id === "string" ? id : "" };
  });
  // Match yToJson exactly: a keyed array presents in rank order only when at
  // least one item carries a rank; otherwise insertion order stands.
  if (ranked && entries.length > 0 && entries.every((e) => e.id !== "")) {
    entries.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return entries.map((e) => e.obj);
}

/**
 * Reconcile a single node's plain-JSON state into an existing Y.Map with minimal
 * ops (the same structural diff `reconcile` applies to the whole tree, scoped to
 * one node). Used by the server-side lock enforcement (`enforce.ts`) to revert a
 * protected node to its prior snapshot without touching sibling nodes. The
 * caller wraps this in its own (server-origin) transaction.
 */
export function reconcileNodeMap(target: Y.Map<unknown>, source: JsonObject): void {
  reconcileMap(target, source);
}
