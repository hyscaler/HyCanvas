import { afterEach, describe, expect, it, vi } from "vitest";

const ANDROID_FIREFOX = "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1";
const DESKTOP_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";

/** Load the module against a stand-in browser; returns it with the window's
 *  event listeners so a test can fire `beforeinstallprompt`. */
async function load(userAgent: string, opts: { standalone?: boolean } = {}) {
  const handlers = new Map<string, (e: unknown) => void>();
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints: 0 });
  vi.stubGlobal("window", {
    addEventListener: (type: string, cb: (e: unknown) => void) => handlers.set(type, cb),
    matchMedia: (q: string) => ({ matches: !!opts.standalone && q.includes("standalone") }),
  });
  const mod = await import("./installPrompt");
  return { mod, handlers };
}

afterEach(() => vi.unstubAllGlobals());

describe("installState", () => {
  it("explains the Share steps on iPhone Safari", async () => {
    const { mod } = await load(IPHONE_SAFARI);
    expect(mod.installState()).toBe("ios");
  });

  it("points phone browsers without an install dialog at their own menu", async () => {
    expect((await load(ANDROID_FIREFOX)).mod.installState()).toBe("manual");
    expect((await load(IPHONE_CHROME)).mod.installState()).toBe("manual");
  });

  it("offers nothing on a desktop browser that cannot install", async () => {
    const { mod } = await load(DESKTOP_FIREFOX);
    expect(mod.installState()).toBe("none");
  });

  it("offers nothing once the app runs installed", async () => {
    const { mod } = await load(ANDROID_FIREFOX, { standalone: true });
    expect(mod.installState()).toBe("none");
  });

  it("opens the browser's dialog once it has offered one, then hides after install", async () => {
    const { mod, handlers } = await load(ANDROID_FIREFOX);
    const changed = vi.fn();
    mod.subscribeInstallState(changed);
    const prompt = vi.fn(async () => {});
    handlers.get("beforeinstallprompt")!({ preventDefault() {}, prompt, userChoice: Promise.resolve({ outcome: "accepted" }) });
    expect(mod.installState()).toBe("prompt");
    expect(await mod.promptInstall()).toBe(true);
    expect(prompt).toHaveBeenCalledOnce();
    handlers.get("appinstalled")!({});
    expect(mod.installState()).toBe("none");
    expect(changed).toHaveBeenCalled();
  });
});
