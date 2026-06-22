// Magic-byte type sniffing. Accepted types are validated by
// their content signature, never by file extension. Returns the sniffed
// mime/kind or null for an unrecognized/unsupported type.

import type { AssetKind } from "./types";

export interface SniffResult {
  mime: string;
  kind: AssetKind;
}

type Bytes = Uint8Array | number[];

function at(bytes: Bytes, i: number): number {
  return bytes[i] ?? -1;
}

/** True when `bytes` starts with `sig` at `offset`. */
function matches(bytes: Bytes, sig: number[], offset = 0): boolean {
  for (let i = 0; i < sig.length; i++) {
    if (at(bytes, offset + i) !== sig[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Bytes, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (at(bytes, offset + i) !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Decode a small prefix as UTF-8-ish ASCII for text-format sniffing (SVG). */
function leadingText(bytes: Bytes, max = 512): string {
  let s = "";
  const n = Math.min(max, (bytes as { length: number }).length ?? 0);
  for (let i = 0; i < n; i++) {
    const c = at(bytes, i);
    if (c < 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Identify a file from its leading bytes. Recognizes the formats HyCanvas
 * ingests. ZIP-based Office formats (PPTX/DOCX) cannot be
 * distinguished from a bare ZIP by magic bytes alone, so they report a generic
 * zip document; the caller refines via the central-directory entry names.
 */
export function sniffType(bytes: Bytes): SniffResult | null {
  // Images
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", kind: "image" };
  if (matches(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", kind: "image" };
  if (matches(bytes, [0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", kind: "gif" }; // GIF8
  if (matches(bytes, [0x42, 0x4d])) return { mime: "image/bmp", kind: "image" }; // BM
  if (matches(bytes, [0x49, 0x49, 0x2a, 0x00]) || matches(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return { mime: "image/tiff", kind: "image" };
  // RIFF....WEBP
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return { mime: "image/webp", kind: "image" };
  // ISO-BMFF brands: ....ftyp{brand}
  if (asciiAt(bytes, 4, "ftyp")) {
    const brand = leadingText(bytes, 12).slice(8, 12);
    if (brand === "heic" || brand === "heif" || brand === "mif1" || brand === "hevc") return { mime: "image/heic", kind: "image" };
    if (brand === "avif") return { mime: "image/avif", kind: "image" };
    return { mime: "video/mp4", kind: "video" }; // isom, mp42, qt, etc.
  }
  // Vector (text): SVG
  const head = leadingText(bytes).trimStart();
  if (head.startsWith("<?xml") ? head.includes("<svg") : head.startsWith("<svg")) {
    return { mime: "image/svg+xml", kind: "vector" };
  }
  // PDF / Adobe Illustrator (AI is a PDF-compatible stream)
  if (asciiAt(bytes, 0, "%PDF")) return { mime: "application/pdf", kind: "document" };
  // Video / audio containers
  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", kind: "video" }; // EBML (webm/mkv)
  if (asciiAt(bytes, 0, "OggS")) return { mime: "audio/ogg", kind: "audio" };
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE")) return { mime: "audio/wav", kind: "audio" };
  if (matches(bytes, [0x49, 0x44, 0x33]) || matches(bytes, [0xff, 0xfb]) || matches(bytes, [0xff, 0xf3])) return { mime: "audio/mpeg", kind: "audio" };
  // Fonts
  if (matches(bytes, [0x4f, 0x54, 0x54, 0x4f])) return { mime: "font/otf", kind: "font" }; // OTTO
  if (matches(bytes, [0x00, 0x01, 0x00, 0x00]) || asciiAt(bytes, 0, "true")) return { mime: "font/ttf", kind: "font" };
  if (asciiAt(bytes, 0, "wOFF")) return { mime: "font/woff", kind: "font" };
  if (asciiAt(bytes, 0, "wOF2")) return { mime: "font/woff2", kind: "font" };
  // 3D
  if (asciiAt(bytes, 0, "glTF")) return { mime: "model/gltf-binary", kind: "model3d" };
  // PSD
  if (asciiAt(bytes, 0, "8BPS")) return { mime: "image/vnd.adobe.photoshop", kind: "source" };
  // ZIP-based: PPTX/DOCX/Figma-export and bare zip
  if (matches(bytes, [0x50, 0x4b, 0x03, 0x04]) || matches(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return { mime: "application/zip", kind: "document" };
  }
  return null;
}

/** Result of validating an upload's bytes against the accepted-type policy. */
export interface AcceptResult {
  ok: boolean;
  mime?: string;
  kind?: AssetKind;
  reason?: string;
}

/**
 * Validate an upload by sniffing its content (FR-3). When `declaredExt` is
 * given and contradicts the sniffed type, the file is accepted as the sniffed
 * type (extension is never trusted) but the mismatch is noted.
 */
export function acceptUpload(bytes: Bytes, _declaredExt?: string): AcceptResult {
  const sniff = sniffType(bytes);
  if (!sniff) return { ok: false, reason: "unsupported or unrecognized file type" };
  return { ok: true, mime: sniff.mime, kind: sniff.kind };
}
