import { describe, expect, it } from "vitest";
import { formToHtml, submissionsToCsv, validateField, validateSubmission } from "../forms";
import type { FormField } from "../types";
import { sampleForm } from "./fixtures";

const f = (over: Partial<FormField>): FormField => ({
  id: "x",
  name: "x",
  label: "X",
  kind: "text",
  ...over,
});

describe("validateField", () => {
  it("enforces required", () => {
    expect(validateField(f({ required: true }), "")).toMatch(/required/);
    expect(validateField(f({ required: true }), "ok")).toBeNull();
    expect(validateField(f({ required: false }), "")).toBeNull();
  });

  it("validates email", () => {
    const field = f({ kind: "email", required: true });
    expect(validateField(field, "not-an-email")).toMatch(/valid email/);
    expect(validateField(field, "a@b.com")).toBeNull();
  });

  it("validates number min/max", () => {
    const field = f({ kind: "number", validation: { min: 18, max: 65 } });
    expect(validateField(field, "10")).toMatch(/at least 18/);
    expect(validateField(field, "70")).toMatch(/at most 65/);
    expect(validateField(field, "30")).toBeNull();
    expect(validateField(field, "abc")).toMatch(/must be a number/);
  });

  it("validates pattern", () => {
    const field = f({ validation: { pattern: "^[A-Z]{3}$" } });
    expect(validateField(field, "abc")).toMatch(/expected format/);
    expect(validateField(field, "ABC")).toBeNull();
  });

  it("ignores a malformed pattern", () => {
    const field = f({ validation: { pattern: "([" } });
    expect(validateField(field, "anything")).toBeNull();
  });

  it("validates select options", () => {
    const field = f({ kind: "select", options: ["a", "b"] });
    expect(validateField(field, "c")).toMatch(/invalid selection/);
    expect(validateField(field, "a")).toBeNull();
  });

  it("validates file size limit", () => {
    const field = f({ kind: "file", validation: { maxFileMB: 5 } });
    expect(validateField(field, 8)).toMatch(/5 MB limit/);
    expect(validateField(field, 3)).toBeNull();
  });

  it("never errors on submit/hidden", () => {
    expect(validateField(f({ kind: "submit", required: true }), undefined)).toBeNull();
    expect(validateField(f({ kind: "hidden", required: true }), undefined)).toBeNull();
  });

  it("treats an unchecked required checkbox as empty", () => {
    const field = f({ kind: "checkbox", required: true });
    expect(validateField(field, false)).toMatch(/required/);
    expect(validateField(field, true)).toBeNull();
  });
});

describe("validateSubmission", () => {
  it("aggregates per-field errors keyed by name", () => {
    const form = sampleForm();
    const res = validateSubmission(form.fields, { fullName: "", email: "bad", age: "5" });
    expect(res.ok).toBe(false);
    expect(res.errors.fullName).toMatch(/required/);
    expect(res.errors.email).toMatch(/valid email/);
    expect(res.errors.age).toMatch(/at least 18/);
  });

  it("passes a valid submission", () => {
    const form = sampleForm();
    const res = validateSubmission(form.fields, {
      fullName: "Jane",
      email: "jane@example.com",
      age: "30",
      topic: "Sales",
      message: "Hi",
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual({});
  });
});

describe("formToHtml", () => {
  const html = formToHtml(sampleForm());

  it("emits a semantic form element with the form id", () => {
    expect(html).toContain("<form");
    expect(html).toContain('data-oc-form="contact"');
    expect(html).toContain("enctype=\"multipart/form-data\"");
  });

  it("includes a honeypot hidden field and a token placeholder", () => {
    expect(html).toContain('name="oc_hp"');
    expect(html).toContain("oc-hp");
    expect(html).toContain('name="oc_token"');
  });

  it("renders a labeled control per field", () => {
    expect(html).toContain("Full name");
    expect(html).toContain('type="email"');
    expect(html).toContain('type="number"');
    expect(html).toContain("<textarea");
    expect(html).toContain("<select");
    expect(html).toContain("<option value=\"Sales\">Sales</option>");
    expect(html).toContain('type="submit"');
  });

  it("emits min/max on number fields", () => {
    expect(html).toContain('min="18"');
    expect(html).toContain('max="120"');
  });

  it("uses a custom action and honeypot name when given", () => {
    const out = formToHtml(sampleForm(), { action: "/submit", honeypotName: "trap" });
    expect(out).toContain('action="/submit"');
    expect(out).toContain('name="trap"');
  });
});

describe("submissionsToCsv", () => {
  it("builds a header from field names and a row per submission", () => {
    const form = sampleForm();
    const csv = submissionsToCsv(form.fields, [
      { values: { fullName: "Jane", email: "j@e.com", age: 30, topic: "Sales", message: "Hi" } },
      { values: { fullName: "Bob", email: "b@e.com" } },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("fullName,email,age,topic,message");
    expect(lines[1]).toBe("Jane,j@e.com,30,Sales,Hi");
    // missing values render blank
    expect(lines[2]).toBe("Bob,b@e.com,,,");
  });

  it("quotes and escapes cells containing comma/quote/newline", () => {
    const fields: FormField[] = [{ id: "a", name: "note", label: "Note", kind: "text" }];
    const csv = submissionsToCsv(fields, [
      { values: { note: 'has, comma' } },
      { values: { note: 'has "quote"' } },
      { values: { note: "has\nnewline" } },
    ]);
    const rows = csv.split("\r\n");
    expect(rows[1]).toBe('"has, comma"');
    expect(rows[2]).toBe('"has ""quote"""');
    expect(rows[3]).toBe('"has\nnewline"');
  });

  it("excludes submit fields from columns", () => {
    const form = sampleForm();
    const csv = submissionsToCsv(form.fields, []);
    expect(csv).not.toContain("submit");
  });
});
