// Client-side CRDT history fold (doc 16 FR-9, the history scrubber).
// The server journals raw y-protocols update frames (DesignUpdateLog) but never
// decodes them (there is no pure-Go Yjs decoder). To preview any point in
// history we fold the frames up to a chosen seq into a throwaway Y.Doc in the
// browser (where Yjs lives) and project it to a plain DesignFile, exactly the
// way the live transport applies inbound sync. No live state or undo stack is
// touched; the folded file is shown read-only via the editor preview.

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { docToFile } from "@hc/realtime";
import type { DesignFile } from "@hc/schema";

const FOLD_ORIGIN = "history-fold";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Fold an ordered list of base64 y-protocols update frames into a fresh Y.Doc
 * and project it to a DesignFile. The frames are the exact bytes the realtime
 * hub journaled (sync message type 2 = update); `readSyncMessage` applies each
 * via Y.applyUpdate, the same path the live client uses for inbound sync, so the
 * folded state is byte-faithful to what peers saw at that seq.
 *
 * Pass the prefix of updates with seq <= target (oldest first) to reconstruct
 * the document as it stood at that point. The throwaway doc is destroyed before
 * returning so nothing leaks.
 */
export function foldUpdatesToFile(updatesB64: string[]): DesignFile {
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      for (const b64 of updatesB64) {
        if (!b64) continue;
        const decoder = decoding.createDecoder(base64ToBytes(b64));
        const encoder = encoding.createEncoder(); // reply sink, unused for updates
        syncProtocol.readSyncMessage(decoder, encoder, doc, FOLD_ORIGIN);
      }
    }, FOLD_ORIGIN);
    return docToFile(doc);
  } finally {
    doc.destroy();
  }
}
