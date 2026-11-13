// Precompresses the statically exported frontend so the Go binary can serve
// compressed assets without compressing at request time.
//
// For every text asset (js, css, html, json, svg, webmanifest, txt, xml) it
// writes a brotli (`<file>.br`, quality 11) and a gzip (`<file>.gz`, level 9)
// sibling next to the original. The Go static server (backend/internal/httpapi
// static.go) picks the best sibling for the request's Accept-Encoding and falls
// back to the original file. Originals are always kept: clients without
// compression support, Range requests that predate this change, and the
// analytics HTML injection all read them.
//
// Skipped: already compressed formats (images, fonts, video, archives), source
// maps (never fetched by browsers for page loads), tiny files where the headers
// cost more than the saving, and any sibling that does not save at least 5%.
//
// Runs as the frontend's `postbuild:dist` step, so every pipeline that exports
// the frontend for embedding (scripts/build-dist.js, the Dockerfile, and the
// release workflow) gets the siblings without its own wiring.
//
// Usage: node scripts/precompress-static.js <dir>

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Keep in sync with compressibleTypes in backend/internal/httpapi/static_encoding.go.
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.webmanifest', '.txt', '.xml']);
const MIN_BYTES = 1024;
const MIN_SAVING = 0.95; // keep a sibling only when it is at most 95% of the original

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

async function compressFile(file) {
  const raw = fs.readFileSync(file);
  const result = { file, raw: raw.length, br: 0, gz: 0 };
  const [br, gz] = await Promise.all([
    brotli(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
    gzip(raw, { level: 9 }),
  ]);
  if (br.length <= raw.length * MIN_SAVING) {
    fs.writeFileSync(file + '.br', br);
    result.br = br.length;
  }
  if (gz.length <= raw.length * MIN_SAVING) {
    fs.writeFileSync(file + '.gz', gz);
    result.gz = gz.length;
  }
  return result;
}

async function precompress(dir) {
  // Drop siblings from an earlier run first so a removed or shrunk original
  // never leaves a stale compressed copy behind.
  const all = listFiles(dir);
  for (const f of all) {
    if (f.endsWith('.br') || f.endsWith('.gz')) {
      const orig = f.slice(0, -3);
      if (COMPRESSIBLE.has(path.extname(orig))) fs.rmSync(f);
    }
  }
  const targets = all.filter((f) => {
    if (!COMPRESSIBLE.has(path.extname(f))) return false;
    return fs.statSync(f).size >= MIN_BYTES;
  });

  // zlib's async API runs on the libuv thread pool; a small window keeps every
  // thread busy without holding the whole export in memory at once.
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const f = targets[next++];
      results.push(await compressFile(f));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const sum = (k) => results.reduce((n, r) => n + r[k], 0);
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(
    `[precompress] ${results.length} files: ${kb(sum('raw'))} raw, ` +
      `${kb(sum('br'))} brotli, ${kb(sum('gz'))} gzip (siblings written next to the originals)`,
  );
  return results;
}

module.exports = { precompress, COMPRESSIBLE };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('usage: node scripts/precompress-static.js <dir>');
    process.exit(2);
  }
  precompress(path.resolve(dir)).catch((err) => {
    console.error('[precompress] failed:', err);
    process.exit(1);
  });
}
