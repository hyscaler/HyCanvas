// Per-slide workflow status + assignee (F28 completion C35), read from the
// page's open `data` record. Statuses are PLAIN STRINGS end to end (never an
// enum: an unknown value from a newer client must keep rendering); the three
// offered values just get colors and localized labels. An unrecognized status
// renders with its raw text and the neutral color.

import { tr } from "@/lib/i18n";

export const pageStatusValues = ["draft", "review", "approved"] as const;

type PageLike = { data?: Record<string, unknown> };

export function pageStatusOf(page: unknown): string | undefined {
  const v = (page as PageLike).data?.status;
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function pageAssigneeOf(page: unknown): { id?: string; name: string } | undefined {
  const d = (page as PageLike).data;
  const name = typeof d?.assigneeName === "string" && d.assigneeName.trim() ? d.assigneeName : undefined;
  if (!name) return undefined;
  const id = typeof d?.assigneeId === "string" ? d.assigneeId : undefined;
  return { id, name };
}

export function pageStatusLabel(status: string): string {
  switch (status) {
    case "draft": return tr("editor.status_draft");
    case "review": return tr("editor.status_in_review");
    case "approved": return tr("editor.status_approved");
    default: return status; // a newer client's status renders as-is
  }
}

/** Tailwind classes for the status pill/dot. */
export function pageStatusColor(status: string): { dot: string; pill: string } {
  switch (status) {
    case "draft": return { dot: "bg-amber-400", pill: "bg-amber-50 text-amber-700" };
    case "review": return { dot: "bg-violet-400", pill: "bg-violet-50 text-violet-700" };
    case "approved": return { dot: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700" };
    default: return { dot: "bg-neutral-400", pill: "bg-neutral-100 text-neutral-600" };
  }
}
