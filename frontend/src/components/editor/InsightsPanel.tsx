// Engagement insights panel for a design. Shows the
// aggregated stats to members/owners: unique viewers (named + anonymous),
// total views, a views-over-time sparkline, average time-on-design, and a
// per-page engagement bar chart. Visuals are inline SVG (no chart dependency).
// Gated server-side on member/owner access; a 403 is shown as a friendly note.

import { useEffect, useState } from "react";
import { BarChart3, X } from "lucide-react";
import { ApiError, type DesignInsights } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { tr } from "@/lib/i18n";

function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-surface p-3">
      <div className="text-2xl font-bold text-neutral-900">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </div>
  );
}

// A small views-over-time sparkline (inline SVG). Empty -> a flat baseline.
function Sparkline({ data }: { data: { date: string; count: number }[] }) {
  const w = 240;
  const h = 48;
  if (data.length === 0)
    return <div className="text-xs text-neutral-400">{tr("editor.no_views_yet")}</div>;
  const max = Math.max(1, ...data.map((d) => d.count));
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const pts = data
    .map((d, i) => {
      const x = data.length > 1 ? i * step : w / 2;
      const y = h - (d.count / max) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={tr("editor.views_over_time")}>
      <polyline points={pts} fill="none" stroke="rgb(99 102 241)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// A per-page engagement horizontal bar chart (inline SVG via flex bars).
function PerPageBars({ data }: { data: { pageId: string; engagementMs: number }[] }) {
  if (data.length === 0)
    return <div className="text-xs text-neutral-400">{tr("editor.no_per_page_data_yet")}</div>;
  const max = Math.max(1, ...data.map((d) => d.engagementMs));
  return (
    <div className="flex flex-col gap-2">
      {data.map((d, i) => (
        <div key={d.pageId} className="flex items-center gap-2">
          <span className="w-16 shrink-0 truncate text-xs text-neutral-500" title={d.pageId}>
            Page {i + 1}
          </span>
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-neutral-100">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${Math.max(4, (d.engagementMs / max) * 100)}%` }}
            />
          </div>
          <span className="w-14 shrink-0 text-end text-xs text-neutral-500">{fmtDuration(d.engagementMs)}</span>
        </div>
      ))}
    </div>
  );
}

export function InsightsPanel({ designId, onClose }: { designId: string; onClose: () => void }) {
  const [data, setData] = useState<DesignInsights | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "forbidden" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await oc.designInsights(designId);
        if (!cancelled) {
          setData(d);
          setStatus("ok");
        }
      } catch (e) {
        if (cancelled) return;
        setStatus(e instanceof ApiError && e.status === 403 ? "forbidden" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [designId]);

  const empty = status === "ok" && data && data.totalViews === 0;

  return (
    <aside className="oc-scroll flex w-80 shrink-0 flex-col overflow-y-auto border-s border-neutral-200 bg-surface">
      <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-neutral-800">
          <BarChart3 size={16} /> {tr("editor.insights")}
        </span>
        <button onClick={onClose} aria-label={tr("editor.close_insights")} className="text-neutral-400 hover:text-neutral-700">
          <X size={18} />
        </button>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {status === "loading" && <div className="text-center text-sm text-neutral-400">{tr("editor.loading")}</div>}
        {status === "forbidden" && (
          <div className="text-sm text-neutral-500">{tr("editor.insights_are_available_to_members_of_this_de")}</div>
        )}
        {status === "error" && <div className="text-sm text-neutral-500">{tr("editor.could_not_load_insights")}</div>}
        {status === "ok" && data && (
          <>
            {empty ? (
              <div className="text-sm text-neutral-500">{tr("editor.no_views_yet_share_to_start_collecting_insig")}</div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Stat label={tr("editor.unique_viewers")} value={data.uniqueViewers} />
                  <Stat label={tr("editor.anonymous")} value={data.uniqueAnonViewers} />
                  <Stat label={tr("editor.total_views")} value={data.totalViews} />
                  <Stat label={tr("editor.avg_time")} value={fmtDuration(data.avgTimeMs)} />
                </div>

                <div>
                  <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-neutral-400">{tr("editor.views_over_time")}</h3>
                  <Sparkline data={data.views} />
                </div>

                <div>
                  <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-neutral-400">{tr("editor.per_page_engagement")}</h3>
                  <PerPageBars data={data.perPage} />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
