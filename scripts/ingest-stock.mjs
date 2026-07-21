// Ingest open-licensed SVG packs into the bundled stock library
// (backend/internal/stock/library). Downloads pinned upstream tarballs, license-
// audits, sanitizes and minifies every SVG, derives searchable tags, and writes
// per-pack asset files + index.json + LICENSE/NOTICE manifests. Idempotent: a
// re-run rebuilds the library dirs from the cached tarballs.
//
//   node scripts/ingest-stock.mjs                     # all packs
//   STOCK_PACKS=manypixels node scripts/ingest-stock.mjs  # one pack (fetches only its source)
//   STOCK_CACHE=/path node scripts/ingest-stock.mjs
//
// Wave 1 packs (license verified in-tarball before ingest):
//   tabler-outline / tabler-filled  MIT        @tabler/icons 3.44.0 (npm)
//   twemoji                         CC-BY 4.0  jdecked/twemoji v15.1.0 (base emoji only)
//   healthicons                     MIT        healthicons 2.0.0 (npm, filled set)
//
// Wave 2 illustration packs (no tarball exists for the site-hosted sets, so
// their file lists are vendored below and fetched per URL into the cache;
// license statements are recorded verbatim in each pack's LICENSE.txt):
//   opendoodles      CC0  opendoodles.com official S3 bucket (33 doodles)
//   openpeeps        CC0  openpeeps.com site CDN (92 composed peeps)
//   lukaszadam       CC0  lukaszadam.com/illustrations (icon-sheet files excluded)
//   illlustrations   MIT  realvjy/illlustrations pinned commit tarball
//   manypixels       MIT  quentincaffeino/manypixels-illustrations pinned commit
//                          (curated flatline subset; upstream gallery is CC0/free)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "backend", "internal", "stock", "library");
const CACHE = process.env.STOCK_CACHE || join(tmpdir(), "hycanvas-stock-cache");

const SOURCES = [
  { name: "tabler", url: "https://registry.npmjs.org/@tabler/icons/-/icons-3.44.0.tgz" },
  { name: "twemoji-repo", url: "https://codeload.github.com/jdecked/twemoji/tar.gz/refs/tags/v15.1.0" },
  { name: "healthicons", url: "https://registry.npmjs.org/healthicons/-/healthicons-2.0.0.tgz" },
  { name: "emojinames", url: "https://registry.npmjs.org/unicode-emoji-json/-/unicode-emoji-json-0.9.0.tgz" },
  { name: "illlustrations", url: "https://codeload.github.com/realvjy/illlustrations/tar.gz/54f66072636350020142570071feb8efd4c8b6f6" },
  { name: "manypixels", url: "https://codeload.github.com/quentincaffeino/manypixels-illustrations/tar.gz/d13c5678b9b5c26eaec3e6688e5a1fef5010e1c8" },
];

// Site-hosted packs with no archive distribution: the canonical file lists
// (scraped from each official site once, then pinned here) fetched per URL.
const OPEN_DOODLES = "ballet bikini chilling clumsy coffee dancing dog-jump Doggie float groovy ice-cream jumping laying levitate loving meditating moshing petting plant reading-side reading roller-skating rolling running selfie sitting-reading sitting sleek sprinting strolling swinging unboxing zombieing".split(" ");
const LUKASZ_ADAM = "ai_ball ai_hero ai_robot_2 ai_robot_3 ai-icons ai-working barcelona-icons best-laptop-reddit bitcoin_miner building_3.0 building cactus cassette cat_desk catp_computer_illustration character_illutrations_new character-illustrations city_landscape_illustrations_1 city_landscape_illustrations_2 coding_people coffee colorful_icons conversation_illustration covid19-icons desk-illustration-2 donut-guy doodle espresso flat_character_illustrations free_svg_illustrations_image_guy free_svg_illustrations_robots free-svg-illustration-hosting free-svg-illustration-rocket goal gux+cat guy_with_glasses hero_image_2 hero-illustration house_illustrations japanese-storefront javascript_illustration miscellaneous monitor ninja ninja2 notification_woman nutrition-icons outline_icons_1 outline_icons_2 outline_icons_3 outlined_characters package_service phone-icons premium_1 premium_2 premium_3 premium_4 premium_5 premium_6 programming-illustrations programming relaxing robot sale scooter small_character_illustrations storefront_illustration success_illustration test_tubes tools tv-guy-svg-illustration-free ui-design video-call waitng-illustration website_work website-builder woman_desk woman_working_1 woman_working_2 wordpress-girl wordpress-icons working_1 working_2 youtube_illustration".split(" ");
const OPEN_PEEPS = "5e532a2aeba259dc7140a0e2_peep-1 5e532a4c258ffe237b8ef2c1_peep-2 5e532c33f3aa4b390f1bd62f_peep-3 5e532c65d871315ee7fcae9e_peep-sitting-1 5e53513d5197058658a1dc94_peep-9 5e53515e2b568a43f515edd5_peep-10 5e53517d8becbf5fe24ff444_peep-11 5e5351f351970522b7a2499d_peep-15 5e535216550b76cb4af21e3d_peep-16 5e5352709588e06bd47b75e0_peep-19 5e5352b1c99250785ac5ab18_peep-20 5e535367f5fa1a2eedf59e1d_peep-23 5e53537dd39923575a522de0_peep-24 5e535421d399233b9b529696_peep-28 5e5354a47488c290a747829e_peep-31 5e5354c88e249320e005285e_peep-32 5e5354e49588e03c817d03a4_peep-33 5e5355117488c21dec47cfba_peep-34 5e53566767293a5a435c41a7_peep-41 5e5356a1c992503c9ac79686_peep-43 5e5356be67293a8a335c71b0_peep-44 5e53570264109d16a7014c37_peep-46 5e535720d39923630d5487d7_peep-47 5e535774550b766992f531a8_peep-50 5e5357c17371bbccb99ecadf_peep-53 5e5357fcc99250d0c6c8a111_peep-54 5e535822c99250c79ec8c2e3_peep-55 5e53583de35d386180675b6e_peep-56 5e535858f5fa1a45cdfa3a07_peep-57 5e5358707371bb635d9f3338_peep-58 5e53596f8e24933d7a06b0c7_peep-67 5e535997e35d380ada67ad80_peep-68 5e5359b47371bb97b7a01b27_peep-69 5e5359d28becbf257453bece_peep-70 5e535a0dd3992316ad553c2e_peep-72 5e535a2b8e24938384074dac_peep-73 5e535aa1d871310896104715_peep-77 5e535ac39b55b0379854a1d8_peep-78 5e535b57f5fa1ab5dbfc2764_peep-83 5e535b7a8becbf1fc35460c4_peep-84 5e535bb6e35d38cae7684f8c_peep-86 5e535c03c6b24912b82c061d_peep-89 5e535c225197058c80a6eabc_peep-90 5e535c92c67e790fd496656f_peep-94 5e535cbcf5fa1a60fafcfcab_peep-95 5e535cd6c67e798b229699d1_peep-96 5e535cf47488c27eb04a70d1_peep-97 5e535d4c5197057a87a74020_peep-100 5e535d808becbf7162555033_peep-102 5e535dd92b568a729c1c42f5_peep-105 5e535e2ce35d38156a694f11_peep-sitting-2 5e535e658e24935b1b096148_peep-sitting-4 5e535e838e249316920983c3_peep-sitting-5 5e535e9fc992502f35cd7902_peep-sitting-6 5e535eb7550b76782df9e820_peep-sitting-7 5e535ef19b55b0b01256c383_peep-sitting-9 5e535f0d9b55b01d2056cf00_peep-sitting-10 5e535f2ad39923f7d558435b_peep-sitting-11 5e535f438becbf2fab5619bb_peep-sitting-12 5e535f7d9b55b097be57089f_peep-sitting-14 5e535f96c67e7961f5994532_peep-sitting-15 5e535fd95197054606a88bd2_peep-sitting-17 5e536006c67e7976719986dc_peep-sitting-18 5e536061519705b96fa8d804_peep-standing-1 5e53607bc67e7906ad99cf5a_peep-standing-2 5e536097c6b24990d02eef77_peep-standing-3 5e5360ba550b761a0bfabd32_peep-standing-4 5e5360d39b55b049be5795a1_peep-standing-5 5e5360ee67293aa268617c67_peep-standing-6 5e53610ed3992333c259150c_peep-standing-7 5e53612767293a6c4f619687_peep-standing-8 5e53613f9b55b0a5a457c452_peep-standing-10 5e5361568e2493c0fa0ae191_peep-standing-9 5e5361909b55b0502657e357_peep-standing-11 5e5361abc992503993ce737e_peep-standing-12 5e5361ccd3992383f7595afc_peep-standing-13 5e5361e9f3aa4be48230418f_peep-standing-14 5e536210c67e798fb29b1e94_peep-standing-15 5e53622ec67e7957fc9b32e0_peep-standing-16 5e53624b9b55b0127f5851cf_peep-standing-17 5e536266c99250fe47cebfc0_peep-standing-18 5e536281c992503d98cecdc1_peep-standing-19 5e5362a27488c217864c784d_peep-standing-20 5e5362c164109d10570651c3_peep-standing-21 5e5362e2f5fa1aefa7ffe47c_peep-standing-22 5e5362fa8becbf1d50570b23_peep-standing-23 5e5363188becbffe8c57172c_peep-standing-24 5e53633a7371bbe22da4c986_peep-standing-25 5e5365e367293a5eb7630824_peep-standing-26 5e536601c67e7916da9d1aa5_peep-standing-27 5e536624f5fa1ac60201cc6b_peep-standing-28 5e53663e7488c27c5e4d068c_peep-standing-29 5e53665cc67e79756a9d2d1a_peep-standing-30".split(" ");

const FILE_SOURCES = [
  { name: "opendoodles", base: "https://opendoodles.s3-us-west-1.amazonaws.com/", files: OPEN_DOODLES.map((n) => ({ url: `${n}.svg`, save: `${n}.svg` })) },
  { name: "openpeeps", base: "https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/", files: OPEN_PEEPS.map((n) => ({ url: `${n}.svg`, save: `${n.slice(n.indexOf("_") + 1)}.svg` })) },
  { name: "lukaszadam", base: "https://lukaszadam.com/images/free-illustrations/", files: LUKASZ_ADAM.map((n) => ({ url: `${n}.svg`, save: `${n}.svg` })) },
];

function fetchFileSets(only) {
  for (const s of FILE_SOURCES) {
    if (only && !only.has(s.name)) continue;
    const dir = join(CACHE, s.name);
    mkdirSync(dir, { recursive: true });
    const missing = s.files.filter((f) => !existsSync(join(dir, f.save)));
    if (!missing.length) continue;
    console.log(`download ${s.name}: ${missing.length} files <- ${s.base}`);
    for (const f of missing) execFileSync("curl", ["-sSL", s.base + f.url, "-o", join(dir, f.save)]);
  }
}

function fetchAll(only) {
  mkdirSync(CACHE, { recursive: true });
  for (const s of SOURCES) {
    if (only && !only.has(s.name)) continue;
    const dir = join(CACHE, s.name);
    if (existsSync(dir) && readdirSync(dir).length) continue;
    const tgz = join(CACHE, `${s.name}.tgz`);
    if (!existsSync(tgz)) {
      console.log(`download ${s.name} <- ${s.url}`);
      execFileSync("curl", ["-sL", s.url, "-o", tgz]);
    }
    mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["xzf", tgz, "-C", dir]);
  }
}

// --- sanitize / normalize ----------------------------------------------------

const FORBIDDEN = /<script|<foreignObject|javascript:|\son\w+\s*=/i;

/**
 * Resolve <style> class rules into per-element style attributes and drop the
 * <style> blocks. Inline SVG <style> is document-global CSS, and Illustrator
 * exports all reuse the same .cls-N/.st-N names, so a grid of raw previews
 * would repaint each other. Class rules lose to an element's own style
 * attribute, so merged declarations go first. Returns null when any selector
 * is not a plain class (never the case in the ingested packs).
 */
function inlineCssClasses(text) {
  let css = "";
  // Loop until stable: a single pass can leave a residual `<style` when blocks
  // are nested or overlap, so removing markup one pass is incomplete sanitization.
  let stripped = text;
  let prev;
  do {
    prev = stripped;
    stripped = stripped.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_, body) => {
      css += body + "\n";
      return "";
    });
  } while (stripped !== prev);
  if (!css.trim()) return text;
  const byClass = new Map();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = rule[2].replace(/\s+/g, " ").trim().replace(/;\s*$/, "");
    for (const sel of rule[1].split(",")) {
      const c = sel.trim();
      if (!/^\.[A-Za-z_][\w-]*$/.test(c)) return null;
      const k = c.slice(1);
      byClass.set(k, byClass.has(k) ? `${byClass.get(k)};${body}` : body);
    }
  }
  return stripped.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    const cm = /\sclass="([^"]*)"/.exec(tag);
    if (!cm) return tag;
    const decls = cm[1].split(/\s+/).map((c) => byClass.get(c)).filter(Boolean).join(";");
    const t = tag.replace(cm[0], "");
    if (!decls) return t;
    const sm = /\sstyle="([^"]*)"/.exec(t);
    if (sm) return t.replace(sm[0], ` style="${decls};${sm[1]}"`);
    return t.replace(/^<([a-zA-Z][\w:-]*)/, `<$1 style="${decls}"`);
  });
}

/** Minify + sanitize an SVG for the bundled library. Returns null to reject. */
function sanitize(text) {
  if (FORBIDDEN.test(text)) return null;
  const inlined = inlineCssClasses(text);
  if (inlined === null || /<style[\s>]/i.test(inlined)) return null;
  // Strip comments to a fixed point: a single pass can leave a residual `<!--`
  // when comments are nested, so repeat until nothing more is removed.
  let noComments = inlined;
  let prevComments;
  do {
    prevComments = noComments;
    noComments = noComments.replace(/<!--[\s\S]*?-->/g, "");
  } while (noComments !== prevComments);
  let s = noComments
    .replace(/<\?xml[^>]*\?>/g, "")
    // Drop <text>/<tspan> runs: illustration text is bound to proprietary fonts
    // (e.g. "Myriad Pro") we don't ship, so it renders in a substituted font.
    // These are decorative labels; stripping them keeps the art self-contained.
    .replace(/<text\b[^>]*>[\s\S]*?<\/text>/gi, "")
    .replace(/<text\b[^>]*\/>/gi, "")
    .replace(/\sclass="[^"]*"/g, "")
    .replace(/\s(width|height)="\d+(px)?"(?=[^>]*viewBox)/g, (m, _a, _b, off) => m) // keep; handled below
    .replace(/\r?\n/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
  // External references (images/links) are not allowed in library art.
  if (/(?:href|xlink:href)\s*=\s*"(?!#)/i.test(s)) return null;
  if (!/^<svg[^>]*xmlns=/.test(s)) s = s.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
}

function viewBoxSize(svg, fallback) {
  const vb = /viewBox\s*=\s*"([^"]+)"/.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
  return { width: fallback, height: fallback };
}

function dominantColors(svg) {
  const seen = [];
  // Both attribute paints (fill="#...") and style-declaration paints
  // (style="fill:#..."; how inlineCssClasses leaves them) count.
  for (const m of svg.matchAll(/(?:fill|stroke)\s*[=:]\s*"?(#[0-9a-fA-F]{3,8})/g)) {
    const c = m[1].toLowerCase();
    if (!seen.includes(c)) seen.push(c);
    if (seen.length >= 4) break;
  }
  return seen;
}

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const words = (name) => name.split(/[-_]+/).filter((w) => w && !/^\d+$/.test(w));

// --- pack builders -------------------------------------------------------------

function writePack(pack, meta, assets, licenseText, notice) {
  const dir = join(LIB, pack);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const a of assets) {
    writeFileSync(join(dir, a.file), a.svgText);
    bytes += Buffer.byteLength(a.svgText);
  }
  const index = {
    pack,
    ...meta,
    assets: assets.map(({ svgText: _s, ...rest }) => rest),
  };
  writeFileSync(join(dir, "index.json"), JSON.stringify(index));
  writeFileSync(join(dir, "LICENSE.txt"), licenseText);
  writeFileSync(join(dir, "NOTICE.txt"), notice);
  console.log(`${pack}: ${assets.length} assets, ${(bytes / 1024 / 1024).toFixed(1)} MB svg`);
  return assets.length;
}

function tablerPack(style) {
  const src = join(CACHE, "tabler", "package");
  const iconDir = join(src, "icons", style);
  const license = readFileSync(join(src, "LICENSE"), "utf8");
  if (!/MIT License/i.test(license)) throw new Error("tabler: unexpected license");
  const assets = [];
  for (const f of readdirSync(iconDir).filter((f) => f.endsWith(".svg")).sort()) {
    const raw = readFileSync(join(iconDir, f), "utf8");
    const svgText = sanitize(raw);
    if (!svgText) continue;
    const name = basename(f, ".svg");
    const { width, height } = viewBoxSize(svgText, 24);
    assets.push({
      id: `tb-${style[0]}-${name}`,
      title: titleCase(name.replace(/-/g, " ")),
      file: f,
      tags: [...new Set([...words(name), "icon", style])],
      width, height,
      dominantColors: dominantColors(svgText),
      style,
      svgText,
    });
  }
  return writePack(`tabler-${style}`, {
    title: `Tabler ${titleCase(style)}`,
    kind: "icon",
    category: "icons",
    license: { type: "mit", holder: "Paweł Kuna (Tabler)", url: "https://github.com/tabler/tabler-icons", attributionRequired: false },
    collection: { id: `tabler-${style}`, title: `Tabler ${titleCase(style)} icons`, description: `Open-source ${style} icons (MIT)` },
  }, assets, license, `Tabler Icons 3.44.0 (${style}), https://tabler.io/icons\nIngested from npm @tabler/icons; MIT licensed.\n`);
}

function twemojiPack() {
  const repo = join(CACHE, "twemoji-repo", "twemoji-15.1.0");
  const svgDir = join(repo, "assets", "svg");
  const license = readFileSync(join(repo, "LICENSE-GRAPHICS"), "utf8");
  if (!/Attribution 4\.0/i.test(license)) throw new Error("twemoji: unexpected graphics license");
  // Name map: unicode-emoji-json keyed by emoji char; index by fe0f-stripped
  // codepoint sequence to match twemoji's file naming.
  const byCodes = new Map();
  const data = JSON.parse(readFileSync(join(CACHE, "emojinames", "package", "data-by-emoji.json"), "utf8"));
  for (const [emoji, info] of Object.entries(data)) {
    const codes = [...emoji].map((c) => c.codePointAt(0).toString(16)).filter((c) => c !== "fe0f").join("-");
    if (!byCodes.has(codes)) byCodes.set(codes, info);
  }
  const assets = [];
  for (const f of readdirSync(svgDir).filter((f) => f.endsWith(".svg")).sort()) {
    const codes = basename(f, ".svg").split("-").filter((c) => c !== "fe0f").join("-");
    const info = byCodes.get(codes);
    if (!info) continue; // skin-tone variants and unmapped sequences: skip (base set only)
    const svgText = sanitize(readFileSync(join(svgDir, f), "utf8"));
    if (!svgText) continue;
    const { width, height } = viewBoxSize(svgText, 36);
    assets.push({
      id: `tw-${basename(f, ".svg")}`,
      title: titleCase(info.name),
      file: f,
      tags: [...new Set([...info.name.toLowerCase().split(/\s+/), info.group.toLowerCase().replace(/[^a-z]+/g, " ").trim(), "emoji"].flatMap((t) => t.split(" ")))].filter(Boolean),
      width, height,
      dominantColors: dominantColors(svgText),
      svgText,
    });
  }
  return writePack("twemoji", {
    title: "Emoji (Twemoji)",
    kind: "sticker",
    category: "emoji",
    license: {
      // Field names match @hc/stock LicenseInfo so compileAttribution picks the
      // credit line and link straight from the stamped provenance.
      type: "cc-by", holder: "Twitter, Inc and other contributors",
      attributionRequired: true,
      attributionText: "Twemoji graphics by Twitter, Inc and other contributors, licensed under CC-BY 4.0",
      attributionUrl: "https://github.com/jdecked/twemoji",
    },
    collection: { id: "twemoji", title: "Emoji", description: "Twemoji vector emoji (CC-BY 4.0)" },
  }, assets, license, "Twemoji 15.1.0 graphics, https://github.com/jdecked/twemoji\nGraphics licensed CC-BY 4.0; attribution required and compiled automatically into design credits.\n");
}

function healthiconsPack() {
  const src = join(CACHE, "healthicons", "package");
  const license = readFileSync(join(src, "LICENSE"), "utf8");
  if (!/MIT/i.test(license)) throw new Error("healthicons: unexpected license");
  const base = join(src, "public", "icons", "svg", "filled");
  const assets = [];
  for (const cat of readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory()).sort()) {
    for (const f of readdirSync(join(base, cat)).filter((f) => f.endsWith(".svg")).sort()) {
      const svgText = sanitize(readFileSync(join(base, cat, f), "utf8"));
      if (!svgText) continue;
      const name = basename(f, ".svg");
      const { width, height } = viewBoxSize(svgText, 48);
      assets.push({
        id: `hi-${cat}-${name}`.replace(/[^a-z0-9-]+/gi, "-"),
        title: titleCase(name.replace(/[-_]+/g, " ")),
        file: `${cat}--${f}`,
        tags: [...new Set([...words(name), ...words(cat), "health", "icon"])],
        width, height,
        dominantColors: dominantColors(svgText),
        svgText,
      });
    }
  }
  return writePack("healthicons", {
    title: "Health icons",
    kind: "icon",
    category: "health",
    license: { type: "mit", holder: "Resolve to Save Lives", url: "https://healthicons.org", attributionRequired: false },
    collection: { id: "healthicons", title: "Health icons", description: "Health & medical icon set (MIT)" },
  }, assets, license, "Health icons 2.0.0 (filled), https://healthicons.org\nIngested from npm healthicons; MIT licensed.\n");
}

// --- illustration packs ----------------------------------------------------------

// flattenSvgToNodes skips mask/clipPath/pattern effects, so clipped
// illustrations would insert with their clipped shapes fully visible; reject
// those files rather than ship art that renders wrong on the canvas.
const UNSUPPORTED_EFFECTS = /<mask[\s>]|<clipPath[\s>]|<pattern[\s>]/i;

function illustrationAssets({ dir, prefix, fixedTags, titleOf, normalize, exclude, include, fallbackSize }) {
  const assets = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".svg")).sort()) {
    const name = basename(f, ".svg");
    if (include && !include(name)) continue;
    if (exclude?.(name)) continue;
    const raw = readFileSync(join(dir, f), "utf8");
    if (UNSUPPORTED_EFFECTS.test(raw)) continue;
    const svgText = sanitize(raw);
    if (!svgText) continue;
    const { width, height } = viewBoxSize(svgText, fallbackSize);
    const tagWords = words(normalize ? normalize(name) : name).map((w) => w.toLowerCase());
    assets.push({
      id: `${prefix}-${name}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      title: titleOf ? titleOf(name) : titleCase(tagWords.join(" ")),
      file: f,
      tags: [...new Set([...tagWords, ...fixedTags])],
      width, height,
      dominantColors: dominantColors(svgText),
      svgText,
    });
  }
  return assets;
}

function openDoodlesPack() {
  const assets = illustrationAssets({
    dir: join(CACHE, "opendoodles"), prefix: "od",
    fixedTags: ["illustration", "doodle", "people", "sketch"], fallbackSize: 1024,
  });
  return writePack("opendoodles", {
    title: "Open Doodles",
    kind: "illustration",
    category: "illustrations",
    license: { type: "cc0", holder: "Pablo Stanley (Open Doodles)", url: "https://www.opendoodles.com", attributionRequired: false },
    collection: { id: "opendoodles", title: "Open Doodles", description: "Sketchy hand-drawn people illustrations (CC0)" },
  }, assets, "Open Doodles by Pablo Stanley. https://www.opendoodles.com\nCC0 1.0 Universal (public domain dedication): https://creativecommons.org/publicdomain/zero/1.0/\nSite statement: \"Free for Commercial and Personal Use. No need to credit, license, or anything.\"\n", "Open Doodles ingested from the official opendoodles.com download links (S3).\nCC0: no attribution required.\n");
}

function openPeepsPack() {
  const assets = illustrationAssets({
    dir: join(CACHE, "openpeeps"), prefix: "op",
    fixedTags: ["illustration", "character", "person", "people", "avatar"],
    titleOf: (name) => titleCase(name.replace(/-/g, " ")), fallbackSize: 240,
  });
  return writePack("openpeeps", {
    title: "Open Peeps",
    kind: "illustration",
    category: "characters",
    license: { type: "cc0", holder: "Pablo Stanley (Open Peeps)", url: "https://www.openpeeps.com", attributionRequired: false },
    collection: { id: "openpeeps", title: "Open Peeps", description: "Hand-drawn people characters (CC0)" },
  }, assets, "Open Peeps by Pablo Stanley. https://www.openpeeps.com\nCC0 1.0 Universal (public domain dedication): https://creativecommons.org/publicdomain/zero/1.0/\nSite statement: \"The library is in the public domain under the CC0 License. This means you can copy, modify, distribute, remix, burn, and use the work, even for commercial purposes, without asking permission.\"\n", "Open Peeps ingested from the official openpeeps.com gallery links (site CDN).\nCC0: no attribution required.\n");
}

function lukaszAdamPack() {
  const assets = illustrationAssets({
    dir: join(CACHE, "lukaszadam"), prefix: "la",
    fixedTags: ["illustration", "flat"],
    // The set mixes in icon-sheet compositions; those belong to icon packs,
    // not an illustration library.
    exclude: (name) => /icons/.test(name), fallbackSize: 800,
  });
  return writePack("lukaszadam", {
    title: "Lukasz Adam illustrations",
    kind: "illustration",
    category: "illustrations",
    license: { type: "cc0", holder: "Lukasz Adam", url: "https://lukaszadam.com/illustrations", attributionRequired: false },
    collection: { id: "lukaszadam", title: "Lukasz Adam", description: "Flat character and scene illustrations (CC0)" },
  }, assets, "Free SVG illustrations by Lukasz Adam. https://lukaszadam.com/illustrations\nCC0 licensed; site statement: \"Free SVG illustrations (commercial and personal use) under the CC0 license (MIT license). No attribution required.\"\n", "Lukasz Adam illustrations ingested from lukaszadam.com per-file links.\nCC0: no attribution required. Icon-sheet files excluded from the pack.\n");
}

function illlustrationsPack() {
  const root = join(CACHE, "illlustrations", "illlustrations-54f66072636350020142570071feb8efd4c8b6f6");
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  if (!/MIT License/i.test(license)) throw new Error("illlustrations: unexpected license");
  const content = join(root, "content", "illlustrations");
  const assets = [];
  for (const d of readdirSync(content).sort()) {
    if (!statSync(join(content, d)).isDirectory()) continue;
    assets.push(...illustrationAssets({
      dir: join(content, d), prefix: "il",
      fixedTags: ["illustration", "flat"],
      // 117-ironman depicts a Marvel character; character copyright is not
      // vijay verma's to MIT-license, so it stays out of the bundle.
      exclude: (name) => /ironman/i.test(name),
      normalize: (name) => name.replace(/^(?:day-?\d+|\d+)-/i, ""),
      fallbackSize: 1000,
    }));
  }
  return writePack("illlustrations", {
    title: "illlustrations",
    kind: "illustration",
    category: "illustrations",
    license: { type: "mit", holder: "vijay verma (illlustrations.co)", url: "https://github.com/realvjy/illlustrations", attributionRequired: false },
    collection: { id: "illlustrations", title: "illlustrations", description: "Playful flat object and scene illustrations (MIT)" },
  }, assets, license, "illlustrations by vijay verma, https://illlustrations.co\nIngested from the pinned realvjy/illlustrations commit 54f6607; MIT licensed.\n");
}

// ManyPixels: a large, broad-subject flat illustration gallery. The gallery art
// is free/CC0 per manypixels.co; this pinned mirror ships it MIT-licensed. We
// bundle a CURATED flatline (colorful) subset of broadly-useful, brand-neutral
// subjects, not the full 580-per-style set, to keep the binary lean. Edit
// MANYPIXELS_PICK to bundle more; other styles live under packages/svg/src/*.
const MANYPIXELS_PICK = new Set([
  "Accountant", "Achievement", "Adventure", "Analysis", "Architect", "Astronaut", "Authentication",
  "Beach", "Bicycle", "Birthday", "BookLover", "Brainstorming", "Breakfast", "BugFixing",
  "BusinessConference", "Businessman", "Businesswoman", "Calendar", "CampaignLaunch", "Camping",
  "Car", "CardPayment", "Career", "Chart", "Chat", "Chatting", "Checklist", "Chef", "CityBuildings",
  "CleanInbox", "CodeDevelopment", "Coding", "Coffee", "Coins", "CompletedTask", "Consulting",
  "ContentCreation", "Conversation", "Couple", "Coworking", "CreativeProcess", "CreditCard",
  "CustomerService", "DataAnalytics", "DataCenter", "DataProcessing", "DataStorage",
  "DataVisualization", "Designer", "DigitalNomad", "Diversity", "Doctor", "Dream", "Drone",
  "Ecology", "EmailCampaign", "EmptyInbox", "Entrepreneurs", "Family", "FingerPrint", "Fishing",
  "Fitness", "FocusedWorking", "Gaming", "Graduation", "GreatIdea", "Growth", "Handshake", "Health",
  "HealthyMeal", "Hiking", "Idea", "Innovation", "JobInterview", "Knowledge", "LandingPage",
  "Loading", "Logistics", "Lunch", "Manager", "Map", "MarketAnalysis", "Marketing", "Meditation",
  "MindMap", "MobilePhone", "MoneyTransfer", "Motivation", "Mountain", "Music", "Navigation",
  "Network", "NoteTaking", "Notifications", "Nurse", "OfficeWork", "OnlineLesson", "OnlinePayment",
  "OnlineShopping", "OnlineStore", "PageNotFound404", "Party", "Password", "PieChart", "PiggyBank",
  "Pizza", "Podcast", "Presentation", "ProblemSolving", "ProductManager", "Progress", "QRCode",
  "QualityCheck", "Question", "ReadingABook", "RealEstateAgent", "Recycling", "Relaxing",
  "ReportAnalysis", "Restaurant", "Revenue", "RoadTrip", "RocketLaunch", "Running", "SEO", "Salad",
  "School", "Science", "Scientist", "Scooter", "ScrumBoard", "SearchEngine", "Security",
  "SendingEmails", "Settings", "Share", "Shopping", "ShoppingCart", "SocialMedia", "Spotlight",
  "Startup", "Success", "Target", "Teacher", "TeamBuilding", "TeamMeeting", "TeamPresentation",
  "TeamWork", "TeamSuccess", "Thinking", "Time", "Timeline", "Traveling", "UIDesign",
  "UserInterface", "UserProfile", "VideoCall", "VideoTutorial", "Voting", "Waiter", "Waiting",
  "Wallet", "WateringPlant", "Weather", "WebDeveloper", "WebDevelopment", "Winner", "Wireframe",
  "WorldConnection", "WorldMap", "Yoga",
].map((n) => n.toLowerCase()));

// PascalCase -> spaced words ("TeamWork2" -> "Team Work 2").
const splitCamel = (name) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/(\d+)/g, " $1").replace(/\s+/g, " ").trim();

function manyPixelsPack() {
  const root = join(CACHE, "manypixels", "manypixels-illustrations-d13c5678b9b5c26eaec3e6688e5a1fef5010e1c8");
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  if (!/MIT License/i.test(license)) throw new Error("manypixels: unexpected license");
  const assets = illustrationAssets({
    dir: join(root, "packages", "svg", "src", "flatline"), prefix: "mp",
    fixedTags: ["illustration", "flat", "colorful"],
    include: (name) => MANYPIXELS_PICK.has(name.toLowerCase()),
    titleOf: (name) => titleCase(splitCamel(name)),
    normalize: (name) => splitCamel(name).replace(/\s+/g, "-"),
    fallbackSize: 400,
  });
  return writePack("manypixels", {
    title: "ManyPixels",
    kind: "illustration",
    category: "illustrations",
    license: { type: "mit", holder: "ManyPixels", url: "https://www.manypixels.co/gallery", attributionRequired: false },
    collection: { id: "manypixels", title: "ManyPixels", description: "Colorful flat illustrations for business, tech, and lifestyle (MIT)" },
  }, assets, license, "ManyPixels illustration gallery, https://www.manypixels.co/gallery\nIngested from the pinned quentincaffeino/manypixels-illustrations mirror commit d13c567 (MIT). Curated flatline subset; brands and trademarked characters excluded.\n");
}

// --- run -----------------------------------------------------------------------

// Pack registry: id -> the tarball SOURCES and FILE_SOURCES it needs plus its
// builder. STOCK_PACKS="manypixels,healthicons" rebuilds only those packs (and
// fetches only their sources), so one pack can be added or refreshed without
// re-fetching or risking the others (each writePack rm's its own dir only).
const PACKS = [
  { id: "tabler", sources: ["tabler"], build: () => tablerPack("outline") + tablerPack("filled") },
  { id: "twemoji", sources: ["twemoji-repo", "emojinames"], build: twemojiPack },
  { id: "healthicons", sources: ["healthicons"], build: healthiconsPack },
  { id: "opendoodles", files: ["opendoodles"], build: openDoodlesPack },
  { id: "openpeeps", files: ["openpeeps"], build: openPeepsPack },
  { id: "lukaszadam", files: ["lukaszadam"], build: lukaszAdamPack },
  { id: "illlustrations", sources: ["illlustrations"], build: illlustrationsPack },
  { id: "manypixels", sources: ["manypixels"], build: manyPixelsPack },
];

const ONLY = (process.env.STOCK_PACKS || "").split(",").map((x) => x.trim()).filter(Boolean);
const selected = ONLY.length ? PACKS.filter((p) => ONLY.includes(p.id)) : PACKS;
if (ONLY.length && selected.length !== ONLY.length) {
  const known = PACKS.map((p) => p.id).join(", ");
  throw new Error(`unknown STOCK_PACKS entry; known packs: ${known}`);
}
const srcNeeded = new Set(selected.flatMap((p) => p.sources ?? []));
const fileNeeded = new Set(selected.flatMap((p) => p.files ?? []));
fetchAll(ONLY.length ? srcNeeded : undefined);
fetchFileSets(ONLY.length ? fileNeeded : undefined);
mkdirSync(LIB, { recursive: true });
let total = 0;
for (const p of selected) total += p.build();
console.log(`library ${ONLY.length ? "(" + ONLY.join(",") + ") " : ""}total: ${total} assets -> ${LIB}`);
