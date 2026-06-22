// Form validation, HTML emission, and CSV export (FR-5/FR-6). All pure: the
// server-side capture/email/spam-token verification are serving concerns; here
// we validate the shape, render a semantic <form>, and export submissions.

import { escapeAttr, escapeHtml } from "./html";
import type { FormBlock, FormField, FormSubmission } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate one field's value. Returns an error message, or null when valid.
 *  `submit` fields carry no value and never produce an error. */
export function validateField(field: FormField, value: unknown): string | null {
  if (field.kind === "submit" || field.kind === "hidden") return null;

  const isEmpty =
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (field.kind === "checkbox" && value === false);

  if (field.required && isEmpty) {
    return `${field.label || field.name} is required`;
  }
  if (isEmpty) return null; // optional + empty: nothing more to check

  const v = value;
  const str = typeof v === "string" ? v : String(v);

  if (field.kind === "email" && !EMAIL_RE.test(str)) {
    return `${field.label || field.name} must be a valid email address`;
  }

  if (field.kind === "number") {
    const num = typeof v === "number" ? v : Number(str);
    if (Number.isNaN(num)) return `${field.label || field.name} must be a number`;
    if (field.validation?.min !== undefined && num < field.validation.min) {
      return `${field.label || field.name} must be at least ${field.validation.min}`;
    }
    if (field.validation?.max !== undefined && num > field.validation.max) {
      return `${field.label || field.name} must be at most ${field.validation.max}`;
    }
  }

  if (field.validation?.pattern) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(field.validation.pattern);
    } catch {
      re = null; // a malformed pattern never blocks a submission
    }
    if (re && !re.test(str)) {
      return `${field.label || field.name} is not in the expected format`;
    }
  }

  if (field.kind === "select" || field.kind === "radio") {
    if (field.options && field.options.length > 0 && !field.options.includes(str)) {
      return `${field.label || field.name} has an invalid selection`;
    }
  }

  if (field.kind === "file" && field.validation?.maxFileMB !== undefined) {
    // The renderer cannot see file bytes; callers pass a size (in MB) as the
    // value to enforce the limit. A non-numeric value is treated as present.
    const mb = typeof v === "number" ? v : Number(str);
    if (!Number.isNaN(mb) && mb > field.validation.maxFileMB) {
      return `${field.label || field.name} exceeds the ${field.validation.maxFileMB} MB limit`;
    }
  }

  return null;
}

export interface SubmissionResult {
  ok: boolean;
  errors: Record<string, string>;
}

/** Validate a whole submission against a field list. Aggregates per-field
 *  errors keyed by field `name`. */
export function validateSubmission(
  fields: FormField[],
  values: Record<string, unknown>,
): SubmissionResult {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const err = validateField(field, values[field.name]);
    if (err) errors[field.name] = err;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export interface FormHtmlOptions {
  /** Where the visitor submission posts (defaults to a relative endpoint). */
  action?: string;
  method?: "post" | "get";
  /** Name for the honeypot input the spam filter checks server-side. */
  honeypotName?: string;
}

const HONEYPOT_DEFAULT = "oc_hp";

/** Render a semantic <form> with labeled inputs per field, a honeypot trap, and
 *  a placeholder hidden token input (signed server-side at submit time). */
export function formToHtml(form: FormBlock, opts: FormHtmlOptions = {}): string {
  const action = opts.action ?? `/__forms/${form.id}`;
  const method = opts.method ?? "post";
  const honeypot = opts.honeypotName ?? HONEYPOT_DEFAULT;

  const rows: string[] = [];
  for (const field of form.fields) {
    rows.push(fieldToHtml(field));
  }

  // Honeypot: visually hidden; a real visitor leaves it blank, bots fill it.
  const honeypotInput =
    `<div class="oc-hp" aria-hidden="true" style="position:absolute;left:-9999px">` +
    `<label>Leave this field empty<input type="text" name="${escapeAttr(honeypot)}" tabindex="-1" autocomplete="off"></label>` +
    `</div>`;
  // Token placeholder: the serving layer replaces the value with a signed token.
  const tokenInput = `<input type="hidden" name="oc_token" value="">`;
  const formIdInput = `<input type="hidden" name="oc_form_id" value="${escapeAttr(form.id)}">`;

  const after =
    form.afterSubmit.kind === "redirect"
      ? `<input type="hidden" name="oc_redirect" value="${escapeAttr(form.afterSubmit.url)}">`
      : "";

  return (
    `<form class="oc-form" data-oc-form="${escapeAttr(form.id)}" method="${method}" action="${escapeAttr(action)}" enctype="multipart/form-data" novalidate>` +
    honeypotInput +
    tokenInput +
    formIdInput +
    after +
    rows.join("") +
    `</form>`
  );
}

function fieldToHtml(field: FormField): string {
  const id = `oc-field-${escapeAttr(field.id)}`;
  const name = escapeAttr(field.name);
  const required = field.required ? " required" : "";
  const placeholder = field.placeholder ? ` placeholder="${escapeAttr(field.placeholder)}"` : "";
  const labelHtml =
    field.kind === "submit" || field.kind === "hidden"
      ? ""
      : `<label for="${id}">${escapeHtml(field.label || field.name)}${field.required ? " *" : ""}</label>`;

  let control: string;
  switch (field.kind) {
    case "textarea":
      control = `<textarea id="${id}" name="${name}"${placeholder}${required}></textarea>`;
      break;
    case "select": {
      const opts = (field.options ?? [])
        .map((o) => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`)
        .join("");
      control = `<select id="${id}" name="${name}"${required}>${opts}</select>`;
      break;
    }
    case "radio": {
      control = (field.options ?? [])
        .map(
          (o, i) =>
            `<label class="oc-radio"><input type="radio" name="${name}" value="${escapeAttr(o)}"${
              i === 0 ? required : ""
            }> ${escapeHtml(o)}</label>`,
        )
        .join("");
      break;
    }
    case "checkbox":
      control = `<input type="checkbox" id="${id}" name="${name}"${required}>`;
      break;
    case "file":
      control = `<input type="file" id="${id}" name="${name}"${required}>`;
      break;
    case "hidden":
      control = `<input type="hidden" id="${id}" name="${name}">`;
      break;
    case "submit":
      control = `<button type="submit" class="oc-submit">${escapeHtml(field.label || "Submit")}</button>`;
      break;
    case "number":
      control = `<input type="number" id="${id}" name="${name}"${placeholder}${required}${
        field.validation?.min !== undefined ? ` min="${field.validation.min}"` : ""
      }${field.validation?.max !== undefined ? ` max="${field.validation.max}"` : ""}>`;
      break;
    case "email":
      control = `<input type="email" id="${id}" name="${name}"${placeholder}${required}>`;
      break;
    case "text":
    default:
      control = `<input type="text" id="${id}" name="${name}"${placeholder}${required}${
        field.validation?.pattern ? ` pattern="${escapeAttr(field.validation.pattern)}"` : ""
      }>`;
  }

  if (field.kind === "hidden") return control;
  return `<div class="oc-field oc-field-${field.kind}">${labelHtml}${control}</div>`;
}

/** Neutralize CSV formula injection: a cell whose first character is one of
 *  `= + - @` or a leading tab/CR can be interpreted as a formula by Excel,
 *  Google Sheets, and LibreOffice. Prefixing with a single apostrophe forces
 *  the spreadsheet to treat the cell as literal text. Applied BEFORE RFC-4180
 *  quoting so the apostrophe ends up inside the quoted value. */
function neutralizeFormula(s: string): string {
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) {
    return `'${s}`;
  }
  return s;
}

/** Quote a CSV cell per RFC 4180: wrap in quotes and double internal quotes when
 *  it contains a comma, quote, or newline. A leading formula trigger is
 *  neutralized first so spreadsheet apps never execute the cell. */
function csvCell(value: unknown): string {
  let s: string;
  if (value === undefined || value === null) s = "";
  else if (Array.isArray(value)) s = value.join("; ");
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  s = neutralizeFormula(s);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Export submissions to a CSV string. Header columns are the field names; each
 *  row pulls each field's value from the submission (blank when absent). */
export function submissionsToCsv(fields: FormField[], submissions: FormSubmission[]): string {
  const cols = fields.filter((f) => f.kind !== "submit");
  const header = cols.map((f) => csvCell(f.name)).join(",");
  const rows = submissions.map((sub) =>
    cols.map((f) => csvCell(sub.values[f.name])).join(","),
  );
  return [header, ...rows].join("\r\n");
}
