// @vitest-environment jsdom

// The insecure-context case is the one that bit a self-hoster: navigator.clipboard
// is absent over plain HTTP at a LAN address, so touching .writeText throws
// synchronously and a .then(ok, err) handler never sees it.
import { describe, expect, it, vi, afterEach } from "vitest";
import { copyText } from "./clipboard";

const realNavigator = globalThis.navigator;
const setClipboard = (clipboard: unknown) =>
  Object.defineProperty(globalThis, "navigator", {
    value: { ...realNavigator, clipboard },
    configurable: true,
    writable: true,
  });

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: realNavigator, configurable: true, writable: true });
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the clipboard api when it is available", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when navigator.clipboard is missing", async () => {
    setClipboard(undefined); // insecure origin
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true, writable: true });

    await expect(copyText("from a LAN address")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("falls back when the clipboard api rejects", async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new Error("not focused"); }) });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true, writable: true });

    await expect(copyText("x")).resolves.toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it("reports failure rather than throwing when nothing can copy", async () => {
    setClipboard(undefined);
    Object.defineProperty(document, "execCommand", {
      value: () => { throw new Error("denied"); },
      configurable: true,
      writable: true,
    });
    await expect(copyText("x")).resolves.toBe(false);
  });

  it("leaves no textarea behind after the fallback", async () => {
    setClipboard(undefined);
    Object.defineProperty(document, "execCommand", { value: () => true, configurable: true, writable: true });
    await copyText("tidy");
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
