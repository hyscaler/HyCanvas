// Minimal dependency-free ZIP reader for OOXML import (doc 28 PPTX import).
// Walks the central directory (authoritative, unlike local headers) and
// supports the two methods real .pptx files use: store (0) and deflate (8),
// inflating via the platform-native DecompressionStream ("deflate-raw"),
// available in every modern browser and Node 18+. No zip64 (a .pptx is far
// below 4GB); encrypted entries are rejected.
//
// Archive-bomb guards (F28 completion C01): the archives come from untrusted
// files the user picked, so entry count, per-entry decompressed size, and
// TOTAL decompressed size are all capped, and the caps are enforced DURING
// inflation (a declared size in the directory can lie, and measuring after
// the fact means the bomb already detonated in this tab's memory). Over-limit
// archives are rejected with a clear error, never silently truncated. Stored
// entries are zero-copy views into the picked file and cannot expand, so only
// inflated bytes count toward the total.

export interface UnzippedFile {
  name: string;
  data: Uint8Array;
}

/** Decompression limits. The defaults are far above any real deck this
 *  client-side importer could handle anyway, so they only ever stop bombs. */
export interface UnzipLimits {
  /** Maximum central-directory entries (default 10000). */
  maxEntries?: number;
  /** Maximum decompressed bytes for ONE entry (default 512 MiB). */
  maxEntryBytes?: number;
  /** Maximum decompressed bytes across the whole archive (default 1 GiB). */
  maxTotalBytes?: number;
}

const defaultLimits: Required<UnzipLimits> = {
  maxEntries: 10_000,
  maxEntryBytes: 512 << 20,
  maxTotalBytes: 1 << 30,
};

/** Inflate raw-deflate data, aborting as soon as the output exceeds `cap`;
 *  `capMessage` names WHICH limit was crossed (entry vs total). */
async function inflateRawCapped(data: Uint8Array, cap: number, capMessage: string): Promise<Uint8Array> {
  // slice() re-buffers so .buffer is exactly this entry's bytes (a subarray's
  // buffer would leak the whole archive into the body).
  const body = data.slice().buffer as ArrayBuffer;
  const stream = new Response(body).body;
  if (!stream) throw new Error("streams unavailable");
  const reader = stream.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(capMessage);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Read a ZIP archive into name -> bytes. Throws on a malformed archive or
 *  one that exceeds the decompression limits (see UnzipLimits). */
export async function unzip(bytes: Uint8Array, limits?: UnzipLimits): Promise<Map<string, Uint8Array>> {
  const lim = { ...defaultLimits, ...limits };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the end-of-central-directory record (scan back past any comment).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = dv.getUint16(eocd + 10, true);
  if (count > lim.maxEntries) throw new Error(`zip archive has too many entries (${count})`);
  let p = dv.getUint32(eocd + 16, true); // central directory offset

  const out = new Map<string, Uint8Array>();
  let totalInflated = 0;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error(`encrypted zip entry: ${name}`);
    // The local header's name/extra lengths may differ from the central ones;
    // read them from the local header to find the data start.
    if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error("bad local header");
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);
    if (method === 0) {
      out.set(name, raw);
    } else if (method === 8) {
      // The per-entry cap is also bounded by the remaining total budget, so a
      // set of entries each under the entry cap cannot blow the total.
      const remaining = lim.maxTotalBytes - totalInflated;
      const entryCap = Math.min(lim.maxEntryBytes, remaining);
      if (entryCap <= 0) throw new Error("zip archive expands past the total decompression limit");
      const capMessage = remaining < lim.maxEntryBytes
        ? "zip archive expands past the total decompression limit"
        : `zip entry expands past the ${Math.round(lim.maxEntryBytes / (1 << 20))} MiB limit: ${name}`;
      const inflated = await inflateRawCapped(raw, entryCap, capMessage);
      totalInflated += inflated.byteLength;
      out.set(name, inflated);
    } else {
      throw new Error(`unsupported zip method ${method} for ${name}`);
    }
  }
  return out;
}
