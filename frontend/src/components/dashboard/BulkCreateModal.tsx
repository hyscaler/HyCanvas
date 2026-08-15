// Bulk create / data merge: the differentiator that
// turns a dataset plus a base design/template with named fillable fields into
// many finished designs (one per row). A four-step flow inside a modal:
//   1. pick a base (a template from the gallery, or one of your designs)
//   2. paste CSV / tabular data (parsed client-side; first row = headers)
//   3. map dataset columns -> the base's fillable fields (auto-matched by name)
//      and set a title pattern
//   4. preview the count + a sample, then Generate -> server bulk-create
// On completion the created designs are listed with links to open each.
//
// Bulk create is synchronous + batched on the server (capped); the result
// reports a truncated flag when the dataset exceeds the cap. The async (job)
// path for very large datasets is deferred.

import { useEffect, useMemo, useState } from "react";
// The body mounts fresh each time the modal opens (via the `open` guard in the
// wrapper), so all step/data state initializes clean with no reset effect.
import { Loader2 } from "lucide-react";
import type {
  BulkCreateResult,
  FillableFieldSummary,
  TemplateSummary,
} from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { parseCsv, type ParsedCsv } from "@/lib/csv";
import { tr } from "@/lib/i18n";

type Base =
  | { kind: "template"; id: string; title: string }
  | { kind: "design"; id: string; title: string };

type Step = "data" | "map" | "review" | "done";

const SAMPLE_CSV = "name,role\nAda Lovelace,Engineer\nGrace Hopper,Admiral";

interface BulkCreateProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string | null;
  templates: TemplateSummary[];
  designs: Array<{ id: string; title: string }>;
  onOpenDesign: (id: string) => void;
}

export function BulkCreateModal(props: BulkCreateProps) {
  // Only mount the body when open, so its state initializes fresh each time
  // (no reset effect needed).
  return (
    <Modal open={props.open} onClose={props.onClose} title={tr("dashboard.bulk_create_from_data")} width="w-[44rem]">
      {props.open && <BulkCreateBody {...props} />}
    </Modal>
  );
}

function BulkCreateBody({
  onClose,
  workspaceId,
  templates,
  designs,
  onOpenDesign,
}: BulkCreateProps) {
  const toast = useToast();
  const [base, setBase] = useState<Base | null>(null);
  const [fields, setFields] = useState<FillableFieldSummary[]>([]);
  const [loadingFields, setLoadingFields] = useState(false);
  const [step, setStep] = useState<Step>("data");
  const [csvText, setCsvText] = useState("");
  const [parsed, setParsed] = useState<ParsedCsv>({ headers: [], rows: [], matrix: [] });
  // field nodeId -> dataset column (header). Empty string = unmapped.
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [titlePattern, setTitlePattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkCreateResult | null>(null);

  // Load the base's fillable fields when a base is chosen, then auto-match the
  // mapping by case-insensitive name once data has been parsed.
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    void (async () => {
      if (!cancelled) setLoadingFields(true);
      try {
        const f =
          base.kind === "template"
            ? await oc.templateFillableFields(base.id)
            : await oc.designFillableFields(base.id);
        if (!cancelled) setFields(f);
      } catch {
        if (!cancelled) setFields([]);
      } finally {
        if (!cancelled) setLoadingFields(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  function autoMap(headers: string[], flds: FillableFieldSummary[]): Record<string, string> {
    const byLower = new Map(headers.map((h) => [h.toLowerCase(), h]));
    const next: Record<string, string> = {};
    for (const f of flds) {
      const hit = byLower.get(f.label.toLowerCase()) ?? byLower.get(f.nodeId.toLowerCase());
      next[f.nodeId] = hit ?? "";
    }
    return next;
  }

  function parseData() {
    const p = parseCsv(csvText);
    if (p.headers.length === 0 || p.rows.length === 0) {
      toast.error(tr("dashboard.paste_at_least_a_header_row_and_one_data_row"));
      return;
    }
    setParsed(p);
    setMapping(autoMap(p.headers, fields));
    setStep("map");
  }

  const mappedFields = useMemo(
    () => fields.filter((f) => mapping[f.nodeId]),
    [fields, mapping],
  );

  // Build the request rows: keyed by field nodeId, from each parsed row's mapped
  // column. Only mapped fields are included.
  function buildRows(): Array<Record<string, string>> {
    return parsed.rows.map((row) => {
      const out: Record<string, string> = {};
      for (const f of fields) {
        const col = mapping[f.nodeId];
        if (col && row[col] !== undefined) out[f.nodeId] = row[col];
      }
      return out;
    });
  }

  async function generate() {
    if (!workspaceId || !base) return;
    setBusy(true);
    try {
      const res = await oc.bulkCreate({
        workspaceId,
        sourceTemplateId: base.kind === "template" ? base.id : undefined,
        sourceDesignId: base.kind === "design" ? base.id : undefined,
        rows: buildRows(),
        titlePattern: titlePattern.trim() || undefined,
      });
      setResult(res);
      setStep("done");
      if (res.truncated) {
        toast.toast(`Generated ${res.created.length} designs (dataset truncated to the cap).`, "info");
      } else {
        toast.success(`Generated ${res.created.length} designs.`);
      }
    } catch {
      toast.error(tr("dashboard.bulk_create_failed"));
    } finally {
      setBusy(false);
    }
  }

  const previewCount = parsed.rows.length;

  return (
    <>
      {/* Step 1: choose a base. Always visible at the top so it can be changed. */}
      <div className="mb-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{tr("dashboard.1_pick_a_base")}</p>
        {base ? (
          <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
            <span className="truncate text-sm font-medium text-neutral-800">
              {base.kind === "template" ? tr("dashboard.template") : tr("dashboard.design")}: {base.title}
            </span>
            <Button variant="ghost" size="sm" onClick={() => { setBase(null); setStep("data"); }}>
              {tr("dashboard.change")}
            </Button>
          </div>
        ) : (
          <BasePicker templates={templates} designs={designs} onPick={setBase} />
        )}
        {base && !loadingFields && fields.length === 0 && (
          <p className="mt-2 text-xs text-amber-700">
            {tr("dashboard.this_base_has_no_fillable_fields_mark_fields")}
          </p>
        )}
      </div>

      {base && fields.length > 0 && (
        <>
          {/* Step 2: paste data */}
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{tr("dashboard.2_paste_your_data_csv")}</p>
              <button className="text-xs font-medium text-brand-ink hover:underline" onClick={() => setCsvText(SAMPLE_CSV)}>
                {tr("dashboard.use_sample")}
              </button>
            </div>
            <textarea
              value={csvText}
              onChange={(e) => { setCsvText(e.target.value); setStep("data"); }}
              rows={5}
              placeholder={"name,role\nAda Lovelace,Engineer"}
              className="oc-scroll w-full rounded-xl border border-neutral-200 p-3 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            {step === "data" && (
              <div className="mt-2 flex justify-end">
                <Button size="sm" onClick={parseData} disabled={!csvText.trim()}>{tr("dashboard.parse_data")}</Button>
              </div>
            )}
          </div>

          {/* Step 3: map columns -> fields + title pattern */}
          {step !== "data" && parsed.headers.length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{tr("dashboard.3_map_columns_to_fields")}</p>
              <div className="space-y-2">
                {fields.map((f) => (
                  <div key={f.nodeId} className="flex items-center gap-3">
                    <span className="w-40 shrink-0 truncate text-sm text-neutral-700" title={f.label}>
                      {f.label}
                      <span className="ms-1 text-xs text-neutral-400">({f.kind})</span>
                    </span>
                    <select
                      value={mapping[f.nodeId] ?? ""}
                      onChange={(e) => setMapping((m) => ({ ...m, [f.nodeId]: e.target.value }))}
                      className="h-9 flex-1 rounded-lg border border-neutral-200 bg-surface px-2 text-sm outline-none focus:border-brand-500"
                    >
                      <option value="">(not mapped)</option>
                      {parsed.headers.map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <Input
                  label={tr("dashboard.title_pattern_optional")}
                  value={titlePattern}
                  onChange={(e) => setTitlePattern(e.target.value)}
                  placeholder={fields[0] ? `{${fields[0].label}} - card` : "{name} - card"}
                />
                <p className="mt-1 text-xs text-neutral-400">
                  Use {"{field}"} placeholders. Empty falls back to a numbered title.
                </p>
              </div>
              <div className="mt-3 flex justify-end">
                <Button size="sm" onClick={() => setStep("review")} disabled={mappedFields.length === 0}>
                  {tr("dashboard.preview")}
                </Button>
              </div>
            </div>
          )}

          {/* Step 4: review + generate */}
          {step === "review" && (
            <div className="mb-2">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{tr("dashboard.4_review")}</p>
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm">
                <p className="text-neutral-700">
                  {tr("dashboard.this_will_generate")} <span className="font-semibold">{previewCount}</span> design
                  {previewCount === 1 ? "" : "s"} from <span className="font-semibold">{base.title}</span>.
                </p>
                {previewCount > 200 && (
                  <p className="mt-1 text-xs text-amber-700">
                    {tr("dashboard.only_the_first_200_rows_will_be_generated_in")}
                  </p>
                )}
                <SamplePreview parsed={parsed} fields={fields} mapping={mapping} titlePattern={titlePattern} baseTitle={base.title} />
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep("map")}>{tr("dashboard.back")}</Button>
                <Button onClick={() => void generate()} disabled={busy}>
                  {busy && <Loader2 size={16} className="animate-spin" />}
                  Generate {previewCount} design{previewCount === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Results */}
      {step === "done" && result && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{tr("dashboard.created_designs")}</p>
          {result.truncated && (
            <p className="mb-2 text-xs text-amber-700">
              Dataset truncated: {result.requestedRows} rows requested, {result.created.length} created (cap reached).
            </p>
          )}
          {result.skipped.length > 0 && (
            <p className="mb-2 text-xs text-amber-700">{result.skipped.length} row(s) skipped (failed validation).</p>
          )}
          <ul className="oc-scroll max-h-64 divide-y divide-neutral-100 overflow-y-auto rounded-xl border border-neutral-200">
            {result.created.map((c) => (
              <li key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="truncate text-neutral-700">{c.title}</span>
                <button className="shrink-0 font-medium text-brand-ink hover:underline" onClick={() => onOpenDesign(c.id)}>
                  {tr("dashboard.open")}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end">
            <Button onClick={onClose}>{tr("dashboard.done")}</Button>
          </div>
        </div>
      )}
    </>
  );
}

function BasePicker({
  templates,
  designs,
  onPick,
}: {
  templates: TemplateSummary[];
  designs: Array<{ id: string; title: string }>;
  onPick: (b: Base) => void;
}) {
  const [tab, setTab] = useState<"template" | "design">("template");
  const list = tab === "template" ? templates : designs;
  return (
    <div className="rounded-xl border border-neutral-200">
      <div className="flex border-b border-neutral-100 text-sm">
        <TabButton active={tab === "template"} onClick={() => setTab("template")}>{tr("dashboard.templates")}</TabButton>
        <TabButton active={tab === "design"} onClick={() => setTab("design")}>{tr("dashboard.your_designs")}</TabButton>
      </div>
      <div className="oc-scroll max-h-48 overflow-y-auto p-1">
        {list.length === 0 ? (
          <p className="p-3 text-sm text-neutral-400">{tr("dashboard.nothing_here_yet")}</p>
        ) : (
          list.map((x) => (
            <button
              key={x.id}
              onClick={() => onPick({ kind: tab, id: x.id, title: x.title })}
              className="block w-full truncate rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-brand-50"
            >
              {x.title}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 font-medium ${active ? "border-b-2 border-brand-600 text-brand-ink" : "text-neutral-500 hover:text-neutral-800"}`}
    >
      {children}
    </button>
  );
}

// A small preview: the first row's mapped values and the title it would produce.
function SamplePreview({
  parsed,
  fields,
  mapping,
  titlePattern,
  baseTitle,
}: {
  parsed: ParsedCsv;
  fields: FillableFieldSummary[];
  mapping: Record<string, string>;
  titlePattern: string;
  baseTitle: string;
}) {
  const first = parsed.rows[0];
  if (!first) return null;
  const title = renderTitlePreview(titlePattern, fields, mapping, first, baseTitle, 0);
  const mapped = fields.filter((f) => mapping[f.nodeId]);
  return (
    <div className="mt-3 border-t border-neutral-200 pt-3">
      <p className="text-xs font-medium text-neutral-500">{tr("dashboard.first_design_preview")}</p>
      <p className="mt-1 text-sm font-semibold text-neutral-800">{title}</p>
      <dl className="mt-1 space-y-0.5">
        {mapped.map((f) => (
          <div key={f.nodeId} className="flex gap-2 text-xs">
            <dt className="w-32 shrink-0 truncate text-neutral-400">{f.label}</dt>
            <dd className="truncate text-neutral-700">{first[mapping[f.nodeId]] || "(blank)"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// Mirror the server's title rendering for the preview: {field} placeholders may
// reference a field label or nodeId, resolved through the current mapping.
function renderTitlePreview(
  pattern: string,
  fields: FillableFieldSummary[],
  mapping: Record<string, string>,
  row: Record<string, string>,
  baseTitle: string,
  index: number,
): string {
  if (!pattern.trim()) return `${baseTitle} ${index + 1}`;
  // Mirror the server: resolve {key} nodeId-first, then by label. The server's
  // rows are keyed by nodeId; here rows are keyed by CSV column, so map the
  // resolved nodeId through the column mapping. Unmatched placeholders emit ''.
  const byNodeId = new Map(fields.map((f) => [f.nodeId, f]));
  const byLabel = new Map(fields.map((f) => [f.label.toLowerCase(), f] as const));
  const out = pattern.replace(/\{([^}]+)\}/g, (_m, key: string) => {
    const k = key.trim();
    const field = byNodeId.get(k) ?? byLabel.get(k.toLowerCase());
    if (!field) return "";
    const col = mapping[field.nodeId];
    if (!col) return "";
    const v = row[col];
    return v === undefined || v === null ? "" : String(v);
  });
  return out.trim() || `${baseTitle} ${index + 1}`;
}
