// First-load JavaScript budget for the routes phones open most.
//
// For each route it sums the gzip size of the JavaScript a cold visit runs
// before the page can render: every <script> in the exported HTML, plus the
// chunks the route's page module loads straight away through its own
// dynamic imports (the dashboard and editor pages render a client-only app
// component through next/dynamic, so that component's chunks are part of the
// first load). Imports nested deeper (dialogs, importers, the deck builder)
// load on demand and are not counted.
//
// Fails when a route exceeds its budget, so a stray static import of a heavy
// package shows up in CI instead of on a phone. Budgets sit above the current
// numbers with headroom; raise one deliberately, with the reason in the commit.
//
// Usage: node scripts/check-bundle-budget.js [exportDir]   (default frontend/out)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'frontend', 'out'));

// Budgets in KB of gzip-compressed JavaScript.
const BUDGETS = [
  { route: '/dashboard/', html: 'dashboard/index.html', page: '/dashboard/[[...view]]', budgetKB: 300 },
  { route: '/editor/', html: 'editor/index.html', page: '/editor', budgetKB: 2000 },
];

function scriptSrcs(html) {
  return [...html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/g)].map((m) => m[1]).filter((s) => s.startsWith('/_next/'));
}

// The chunk lists the page module's dynamic-import loaders fetch, e.g.
//   Promise.all(["static/chunks/a.js","static/chunks/b.js"].map(...))
function pageDynamicChunks(pageChunkSrc) {
  const out = new Set();
  for (const m of pageChunkSrc.matchAll(/Promise\.all\(\[((?:"static\/chunks\/[^"]+\.js",?)+)\]/g)) {
    for (const c of m[1].matchAll(/"([^"]+)"/g)) out.add('/_next/' + c[1]);
  }
  return out;
}

const gzipCache = new Map();
function gzipBytes(rel) {
  if (!gzipCache.has(rel)) {
    const buf = fs.readFileSync(path.join(OUT, rel));
    gzipCache.set(rel, { raw: buf.length, gz: zlib.gzipSync(buf, { level: 9 }).length });
  }
  return gzipCache.get(rel);
}

let failed = false;
for (const b of BUDGETS) {
  const htmlPath = path.join(OUT, b.html);
  if (!fs.existsSync(htmlPath)) {
    console.error(`[bundle-budget] missing ${htmlPath}; build the frontend first`);
    process.exit(2);
  }
  const files = new Set(scriptSrcs(fs.readFileSync(htmlPath, 'utf8')));
  // The page chunk is the one that registers the route with Next's router.
  let pageFound = false;
  for (const f of [...files]) {
    const src = fs.readFileSync(path.join(OUT, f), 'utf8');
    if (src.includes(JSON.stringify(b.page)) && src.includes('__NEXT_P')) {
      pageFound = true;
      for (const c of pageDynamicChunks(src)) files.add(c);
    }
  }
  if (!pageFound) {
    console.error(`[bundle-budget] could not find the page chunk for ${b.page}; the script needs updating for this Next.js output`);
    process.exit(2);
  }
  let raw = 0;
  let gz = 0;
  for (const f of files) {
    const s = gzipBytes(f);
    raw += s.raw;
    gz += s.gz;
  }
  const gzKB = Math.round(gz / 1024);
  const ok = gzKB <= b.budgetKB;
  if (!ok) failed = true;
  console.log(
    `[bundle-budget] ${ok ? 'ok  ' : 'FAIL'} ${b.route.padEnd(12)} ${String(gzKB).padStart(5)} KB gzip ` +
      `(${Math.round(raw / 1024)} KB raw, ${files.size} files), budget ${b.budgetKB} KB`,
  );
}
if (failed) {
  console.error('[bundle-budget] first-load JavaScript is over budget. Load the new dependency on demand (dynamic import or next/dynamic) or raise the budget with a reason.');
  process.exit(1);
}
