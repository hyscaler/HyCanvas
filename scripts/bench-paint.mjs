// AC-10 paint benchmark runner (doc 16): drives the frontend's /bench/paint
// page in the SYSTEM Chrome via puppeteer-core (no browser download) and
// prints the measured GPU-composited paint numbers. The page animates pan/zoom
// over a 50-page x 1000-node deck on a real <canvas> and reports rAF frame
// stats on window.__benchResult.
//
//   npm run bench:paint                    # against http://localhost:3000
//   BENCH_URL=http://host:port npm run bench:paint
//   BENCH_HEADFUL=1 npm run bench:paint    # visible window (most faithful GPU path)
import puppeteer from "puppeteer-core";

const url = (process.env.BENCH_URL ?? "http://localhost:3000") + "/bench/paint";
const headful = !!process.env.BENCH_HEADFUL;

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);

async function findChrome() {
  const { existsSync } = await import("node:fs");
  for (const p of CHROME_PATHS) if (existsSync(p)) return p;
  throw new Error("no Chrome found; set CHROME_PATH");
}

const browser = await puppeteer.launch({
  executablePath: await findChrome(),
  headless: headful ? false : "new",
  args: ["--window-size=1680,1000", "--force-device-scale-factor=2"],
  defaultViewport: { width: 1640, height: 960, deviceScaleFactor: 2 },
});
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
  await page.waitForFunction("!!window.__benchResult", { timeout: 120_000 });
  const result = await page.evaluate("window.__benchResult");
  console.log(JSON.stringify(result, null, 2));
  const ok = result.fpsP50 >= 60;
  console.log(ok ? "AC-10 PASS: p50 >= 60fps" : `AC-10 BELOW TARGET: p50 ${result.fpsP50}fps`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
