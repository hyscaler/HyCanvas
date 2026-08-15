// Entry for the server-side CRDT fold bundle (backend/internal/crdt/fold.js).
// Bundled by scripts/build-crdt-fold.mjs and executed inside the Go binary by a
// pure-Go JS engine (goja), giving the server a real Yjs decoder without cgo or
// a second runtime: the single-binary self-host story is unchanged.
//
// Mirrors frontend/src/lib/historyFold.ts: fold journaled y-protocols update
// frames (base64, oldest first) into a throwaway Y.Doc via readSyncMessage,
// the exact code path live clients use for inbound sync, then project it to a
// plain DesignFile with the same docToFile the client uses. Byte-faithful by
// construction because it IS the client fold, running server-side.

import "./crdt-fold-polyfill.mjs"; // MUST stay the first import (host shims)
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { docToFile } from "@hc/realtime";

const FOLD_ORIGIN = "server-fold";

// goja has no atob; decode base64 in plain JS.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64REV = (() => {
  const rev = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) rev[B64.charCodeAt(i)] = i;
  return rev;
})();

function base64ToBytes(b64) {
  let len = b64.length;
  while (len > 0 && b64[len - 1] === "=") len--;
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const c = b64.charCodeAt(i);
    if (c === 10 || c === 13) continue; // tolerate wrapped input
    buf = (buf << 6) | B64REV[c];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** Fold base64 y-protocols update frames (oldest first) to DesignFile JSON. */
globalThis.__hcFoldUpdates = function __hcFoldUpdates(updatesB64) {
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      for (const b64 of updatesB64) {
        if (!b64) continue;
        const decoder = decoding.createDecoder(base64ToBytes(b64));
        const enc = encoding.createEncoder(); // reply sink, unused for updates
        syncProtocol.readSyncMessage(decoder, enc, doc, FOLD_ORIGIN);
      }
    }, FOLD_ORIGIN);
    // A GAPPED log must never fold into a snapshot. Yjs parks deltas whose
    // causal dependencies are missing in `pendingStructs` and carries on, so a
    // journal missing frames still projects a plausible-looking file - one that
    // silently omits whatever those deltas carried. The journal legitimately
    // has holes (the client drops sends while its socket is down and
    // reconverges over the sync handshake, which is not journaled), so this is
    // reachable in normal operation, not just under attack. Refusing here is
    // free: the caller treats an error as "do not snapshot" and leaves the
    // existing state alone.
    const store = doc.store;
    if (store && (store.pendingStructs || store.pendingDs)) {
      throw new Error("incomplete update log: missing causal dependencies");
    }
    return JSON.stringify(docToFile(doc));
  } finally {
    doc.destroy();
  }
};
