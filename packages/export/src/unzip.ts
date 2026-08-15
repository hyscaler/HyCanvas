// Minimal dependency-free ZIP reader for OOXML import (doc 28 PPTX import).
// Walks the central directory (authoritative, unlike local headers) and
// supports the two methods real .pptx files use: store (0) and deflate (8),
// inflating via the platform-native DecompressionStream ("deflate-raw"),
// available in every modern browser and Node 18+. No zip64 (a .pptx is far
// below 4GB); encrypted entries are rejected.

export interface UnzippedFile {
  name: string;
  data: Uint8Array;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // slice() re-buffers so .buffer is exactly this entry's bytes (a subarray's
  // buffer would leak the whole archive into the body).
  const body = data.slice().buffer as ArrayBuffer;
  const stream = new Response(body).body;
  if (!stream) throw new Error("streams unavailable");
  const inflated = stream.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

/** Read a ZIP archive into name -> bytes. Throws on a malformed archive. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
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
  let p = dv.getUint32(eocd + 16, true); // central directory offset

  const out = new Map<string, Uint8Array>();
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
      out.set(name, await inflateRaw(raw));
    } else {
      throw new Error(`unsupported zip method ${method} for ${name}`);
    }
  }
  return out;
}
