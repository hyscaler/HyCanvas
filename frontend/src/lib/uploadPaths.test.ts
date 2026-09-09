// Every file the user picks must go out CHUNKED, not as one base64 body.
//
// This exists because converting "the upload path" once was not enough. The
// uploads panel was moved to the chunked pipeline while four other call sites
// kept sending whole files as base64 JSON, and the panel only accepts images,
// so the very case the bug report described (a ~300 MB video) still took the
// old path and was still rejected by the CDN. The fix was invisible to every
// test and to a browser check that happened to use an image.
//
// A grep is a blunt instrument, but it is the one that would have caught it.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");

// aiAttachments posts to the document-EXTRACTION endpoint, not asset upload:
// a different route with its own 20 MiB cap, so base64 is fine there.
// sdk.ts is where the legacy helper itself lives.
const ALLOWED = ["lib/aiAttachments.ts", "lib/sdk.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("upload paths", () => {
  it("sends no user-picked file as a base64 JSON body", () => {
    const offenders = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("dataBase64"))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"))
      .filter((rel) => !ALLOWED.includes(rel));
    expect(
      offenders,
      `these send a whole file as base64 in one request, which a CDN rejects ` +
        `above its body cap (Cloudflare: 100 MB). Use directUploadWithProgress:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("keeps the legacy base64 helper confined to sdk.ts as a fallback", () => {
    // uploadAssetWithProgress is the pre-chunking helper. It stays for the
    // fallback path inside sdk.ts, but a component reaching for it directly is
    // how a large file quietly ends up on the old route again.
    const users = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("uploadAssetWithProgress"))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"))
      .filter((rel) => rel !== "lib/sdk.ts");
    expect(users, `import directUploadWithProgress instead:\n  ${users.join("\n  ")}`).toEqual([]);
  });
});
