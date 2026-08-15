// Generates fixture.json for fold_test.go: journaled-style y-protocols update
// frames plus the DesignFile the CLIENT fold produces for them. The Go test
// asserts the embedded goja fold yields byte-identical JSON, proving the server
// decoder matches the browser byte-for-byte (it runs the same bundled code).
//
// Run from the repo root (after `npm run build:packages`). The @hc/* dists use
// extensionless ESM imports only bundlers resolve, so run it bundled:
//   npx esbuild backend/internal/crdt/testdata/gen.mjs --bundle --platform=node \
//     --format=esm --outfile=/tmp/hc-crdt-gen.mjs && node /tmp/hc-crdt-gen.mjs
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { reconcile, docToFile } from "@hc/realtime";
import { createBlankDesign, createNode } from "@hc/schema";
import { writeFileSync } from "node:fs";
import path from "node:path";

// The script runs BUNDLED (import.meta.url would point at the bundle), so the
// output path anchors on the repo-root cwd instead.
const here = path.join(process.cwd(), "backend/internal/crdt/testdata");

function frame(update) {
  const enc = encoding.createEncoder();
  syncProtocol.writeUpdate(enc, update);
  return Buffer.from(encoding.toUint8Array(enc)).toString("base64");
}

const ydoc = new Y.Doc();
const frames = [];

// Frame 1: the seeded design (a page with one shape), as a full-state update.
const file = createBlankDesign({ title: "fold-fixture", width: 800, height: 600 });
file.id = "design-fold-fixture";
file.pages[0].id = "page-1";
file.pages[0].children.push(
  createNode("shape", {
    id: "shape-1",
    shape: "rect",
    transform: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 50 },
  }),
);
reconcile(file, ydoc);
frames.push(frame(Y.encodeStateAsUpdate(ydoc)));

// Frame 2: an incremental edit (move the shape, add a text node), captured from
// the doc's own update event - the same delta a live client would broadcast.
const file2 = structuredClone(file);
file2.pages[0].children[0].transform.x = 300;
file2.pages[0].children.push(
  createNode("text", {
    id: "text-1",
    transform: { x: 40, y: 40, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 200, height: 40 },
  }),
);
let delta = null;
const capture = (update) => { delta = update; };
ydoc.on("update", capture);
reconcile(file2, ydoc);
ydoc.off("update", capture);
if (!delta) throw new Error("no incremental update captured");
frames.push(frame(delta));

// Expected: fold the frames into a FRESH doc exactly like the client history
// fold does, and project it. (Not docToFile(ydoc): the fold path must stand on
// its own.)
import * as decoding from "lib0/decoding";
const folded = new Y.Doc();
folded.transact(() => {
  for (const b64 of frames) {
    const dec = decoding.createDecoder(Uint8Array.from(Buffer.from(b64, "base64")));
    const enc = encoding.createEncoder();
    syncProtocol.readSyncMessage(dec, enc, folded, "gen");
  }
}, "gen");
const expected = docToFile(folded);

writeFileSync(
  path.join(here, "fixture.json"),
  JSON.stringify({ updates: frames, expected }, null, 2) + "\n",
);
console.log("wrote fixture.json:", frames.length, "frames,", JSON.stringify(expected).length, "bytes expected");
