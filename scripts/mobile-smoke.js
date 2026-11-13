#!/usr/bin/env node
// Phone smoke test: drives a running HyCanvas instance in phone-sized Chromium
// with real touch input and fails on the layout regressions that made the
// editor unusable on phones (issue #79).
//
//   BASE=http://localhost:8080 OUT=mobile-smoke node scripts/mobile-smoke.js
//
// Needs `playwright` (with Chromium installed) and the built @hc/schema
// package. It signs up a throwaway account on the target instance, so point it
// only at a disposable test instance, never at a real one.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium, devices } = require("playwright");
const { createBlankDesign } = require("@hc/schema");

const BASE = (process.env.BASE || "http://localhost:8080").replace(/\/$/, "");
const OUT = path.resolve(process.env.OUT || "mobile-smoke");
const DEVICES = [
  ["Galaxy S8", "android-360"],
  ["iPhone 13", "iphone-390"],
  ["iPhone 13 landscape", "iphone-landscape"],
];
// The kinds a user can create, with the dashboard's default sizes.
const KINDS = [
  { kind: "design", w: 1080, h: 1080 },
  { kind: "presentation", w: 1920, h: 1080 },
  { kind: "doc", w: 816, h: 1056, metaKind: "doc" },
  { kind: "sheet", w: 1280, h: 800, metaKind: "sheet" },
  { kind: "whiteboard", w: 1920, h: 1080, metaKind: "whiteboard" },
  { kind: "video", w: 1920, h: 1080, metaKind: "video" },
];
// Primary chrome a thumb must be able to hit.
const MIN_TARGET = 40;
const PRIMARY = [
  "header button",
  '[role="toolbar"][aria-orientation="horizontal"] > button',
  "[data-zoom-control] button",
  'nav[aria-label="Pages"] button',
].join(", ");

const failures = [];
const fail = (where, what) => {
  failures.push(`${where}: ${what}`);
  console.log(`  FAIL ${what}`);
};

const touch = (cdp, type, pts) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
async function tap(page, cdp, pt) {
  await touch(cdp, "touchStart", [pt]);
  await page.waitForTimeout(40);
  await touch(cdp, "touchEnd", []);
  await page.waitForTimeout(150);
}
async function pinch(page, cdp, c, from, to) {
  await touch(cdp, "touchStart", [[c[0] - from, c[1]], [c[0] + from, c[1]]]);
  for (let i = 1; i <= 10; i++) {
    const d = from + ((to - from) * i) / 10;
    await touch(cdp, "touchMove", [[c[0] - d, c[1]], [c[0] + d, c[1]]]);
    await page.waitForTimeout(16);
  }
  await touch(cdp, "touchEnd", []);
  await page.waitForTimeout(200);
}

// Layout checks that apply to every screen: no sideways page scroll, no
// visible control pushed past the viewport edge (controls inside a clipping or
// scrolling container are that container's business), and primary chrome big
// enough to tap.
async function checkLayout(page, where) {
  const r = await page.evaluate(
    ({ PRIMARY, MIN_TARGET }) => {
      const vw = innerWidth;
      const visible = (el) => {
        const cs = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0 && b.width > 0 && b.height > 0;
      };
      const clipped = (el) => {
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.overflowX !== "visible" || cs.overflowY !== "visible") return true;
        }
        return false;
      };
      const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
      const offscreen = [];
      for (const el of document.querySelectorAll('button, a[href], input, select, [role="button"], [role="menuitem"], [role="tab"]')) {
        if (!visible(el) || clipped(el)) continue;
        const b = el.getBoundingClientRect();
        if (b.right > vw + 1 || b.left < -1) offscreen.push(label(el));
      }
      const small = [];
      for (const el of document.querySelectorAll(PRIMARY)) {
        if (!visible(el)) continue;
        const b = el.getBoundingClientRect();
        if (b.width < MIN_TARGET - 0.5 || b.height < MIN_TARGET - 0.5) small.push(`${label(el)} ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      return { hOverflow: document.documentElement.scrollWidth > vw + 1, offscreen, small };
    },
    { PRIMARY, MIN_TARGET },
  );
  if (r.hOverflow) fail(where, "page scrolls sideways");
  if (r.offscreen.length) fail(where, `controls outside the viewport: ${r.offscreen.join(", ")}`);
  if (r.small.length) fail(where, `primary touch targets under ${MIN_TARGET}px: ${r.small.join(", ")}`);
}

// The design editor's phone behaviour, exercised with touch.
async function checkDesignEditor(page, cdp, where, landscape) {
  const canvasRect = () =>
    page.$eval("main canvas", (c) => {
      const r = c.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height];
    });
  let c = await canvasRect();
  if (c[2] < innerWidthOf(page) * (landscape ? 0.8 : 0.95)) fail(where, `canvas is only ${Math.round(c[2])}px wide on open`);
  if (await page.$('[role="dialog"]')) fail(where, "a panel covers the canvas on open");

  // Add a heading from the Text panel; the panel must close after the insert.
  await page.click('[aria-label="Open Text"]');
  await page.locator('button:has-text("Add a heading")').first().click();
  await page.waitForTimeout(500);
  if (await page.$('[role="dialog"][aria-label="Text"]')) fail(where, "the Text panel stays open over the new heading");

  // Tap the heading (centred on the page) to select it; its toolbar must fit.
  c = await canvasRect();
  const mid = [c[0] + c[2] / 2, c[1] + c[3] / 2];
  await tap(page, cdp, mid);
  const del = await page.$('[aria-label="Delete"]');
  if (!del) fail(where, "tapping the heading did not select it");
  else {
    const b = await del.boundingBox();
    if (b.x < 0 || b.x + b.width > innerWidthOf(page)) fail(where, "the selection toolbar's Delete is off screen");
  }

  // Double tap edits the text, at a readable size. Wait out the double-tap
  // window first, so the selecting tap does not pair with the next one.
  await page.waitForTimeout(700);
  await tap(page, cdp, mid);
  await page.waitForTimeout(60);
  await tap(page, cdp, mid);
  await page.waitForTimeout(700);
  const edit = await page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a.getAttribute("contenteditable") !== "true") return null;
    return parseFloat(getComputedStyle(a.querySelector("span") || a).fontSize);
  });
  if (edit === null) fail(where, "double tap did not start text editing");
  else if (edit < 15.5) fail(where, `text being edited renders at ${edit}px`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // Pinch zooms the canvas.
  const zoomOf = async () => parseInt(await page.innerText('[aria-label="Zoom level"]'), 10);
  const before = await zoomOf();
  c = await canvasRect();
  await pinch(page, cdp, [c[0] + c[2] / 2, c[1] + c[3] / 2], 40, 110);
  if (!((await zoomOf()) > before)) fail(where, "pinch did not zoom the canvas");

  // Every overflow menu item is reachable.
  await page.click('[aria-label="More actions"]');
  const menu = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const last = items[items.length - 1];
    if (!last) return "no items";
    last.scrollIntoView({ block: "nearest" });
    const b = last.getBoundingClientRect();
    return b.top >= 0 && b.bottom <= innerHeight ? "ok" : `"${last.innerText.trim()}" is unreachable`;
  });
  if (menu !== "ok") fail(where, `overflow menu: ${menu}`);
  await page.keyboard.press("Escape");
}

function innerWidthOf(page) {
  return page.viewportSize().width;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // One throwaway account for the run, signed up through the API.
  const api = await browser.newContext();
  const email = `phone-smoke-${crypto.randomBytes(4).toString("hex")}@example.test`;
  const password = `Ps-${crypto.randomBytes(9).toString("hex")}!7a`;
  const su = await api.request.post(`${BASE}/api/v1/auth/signup`, { data: { email, password, name: "Phone Smoke" } });
  if (!su.ok()) throw new Error(`signup failed: ${su.status()} ${await su.text()}`);
  const workspaces = await (await api.request.get(`${BASE}/api/v1/workspaces`)).json();
  const workspaceId = (Array.isArray(workspaces) ? workspaces : workspaces.workspaces ?? [])[0]?.id;
  if (!workspaceId) throw new Error("no workspace for the smoke account");
  const state = await api.storageState();
  await api.close();

  for (const [device, tag] of DEVICES) {
    console.log(`\n# ${device}`);
    const ctx = await browser.newContext({ ...devices[device], storageState: state, serviceWorkers: "block" });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));

    await page.goto(`${BASE}/dashboard/`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(OUT, `${tag}-dashboard.png`) });
    await checkLayout(page, `${device} dashboard`);

    for (const k of KINDS) {
      const where = `${device} ${k.kind}`;
      console.log(`- ${k.kind}`);
      const from = createBlankDesign({ title: `Smoke ${k.kind}`, width: k.w, height: k.h });
      if (k.metaKind) from.meta.kind = k.metaKind;
      const res = await page.request.post(`${BASE}/api/v1/designs`, { data: { workspaceId, title: `Smoke ${k.kind}`, from } });
      if (!res.ok()) {
        fail(where, `could not create: ${res.status()}`);
        continue;
      }
      const { id } = await res.json();
      await page.goto(`${BASE}/editor/${id}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, `${tag}-${k.kind}.png`) });
      await checkLayout(page, where);
      if (k.kind === "design") {
        try {
          await checkDesignEditor(page, cdp, where, device.includes("landscape"));
        } catch (e) {
          fail(where, `editor flow broke: ${e.message.split("\n")[0]}`);
        }
        await page.screenshot({ path: path.join(OUT, `${tag}-design-after.png`) });
      }
    }
    if (errors.length) fail(device, `page errors: ${[...new Set(errors)].join(" | ")}`);
    await ctx.close();
  }
  await browser.close();

  console.log(failures.length ? `\n${failures.length} failure(s):\n${failures.join("\n")}` : "\nPhone smoke test passed.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
