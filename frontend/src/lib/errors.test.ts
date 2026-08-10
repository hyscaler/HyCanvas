// Coded errors (F38 FR-9): thrown messages stay English for logs, the display
// boundary translates.
import { describe, expect, it, beforeEach } from "vitest";
import { CodedError, userMessage } from "./errors";
import { registerCatalog, loadCatalog, resetI18n } from "./i18n";

beforeEach(() => resetI18n());

describe("CodedError", () => {
  it("keeps the English message on the throw, for logs and .toThrow tests", () => {
    const e = new CodedError("errors.file_read_failed", "Could not read the file.");
    expect(e.message).toBe("Could not read the file.");
    expect(e).toBeInstanceOf(Error);
    expect(() => { throw e; }).toThrow(/Could not read the file/);
  });
});

describe("userMessage", () => {
  it("translates a coded error at the display boundary", async () => {
    registerCatalog("hi", { "errors.file_read_failed": "फ़ाइल पढ़ी नहीं जा सकी।" });
    await loadCatalog("hi");
    const e = new CodedError("errors.file_read_failed", "Could not read the file.");
    expect(userMessage(e, "fallback")).toBe("फ़ाइल पढ़ी नहीं जा सकी।");
  });

  it("falls back to the English message when the code has no entry anywhere", () => {
    const e = new CodedError("errors.not_a_real_code", "Something specific broke.");
    expect(userMessage(e, "fallback")).toBe("Something specific broke.");
  });

  it("keeps the old behavior for plain errors: message wins over fallback", () => {
    // Every swept call site did `e instanceof Error ? e.message : fallback`;
    // adopting userMessage must not change what those show.
    expect(userMessage(new Error("boom"), "fallback")).toBe("boom");
    expect(userMessage("not an error", "fallback")).toBe("fallback");
    expect(userMessage(undefined, "fallback")).toBe("fallback");
  });
});

it("interpolates CodedError params into the translated message", () => {
  const e = new CodedError("errors.download_failed", "download failed (503)", { status: 503 });
  // Base catalog: "Download failed ({status})."
  expect(userMessage(e, "x")).toBe("Download failed (503).");
});

it("translates an API problem body's code, falling back to its detail", () => {
  const api = { body: { code: "workspace_storage_full", detail: "storage quota of 1 GB exceeded" } };
  // errors.api_workspace_storage_full exists in the base catalog.
  expect(userMessage(api, "x")).toBe("The workspace storage is full.");
  const uncoded = { body: { detail: "some server detail" } };
  expect(userMessage(uncoded, "x")).toBe("some server detail");
  const empty = { body: null };
  expect(userMessage(empty, "generic fallback")).toBe("generic fallback");
});
