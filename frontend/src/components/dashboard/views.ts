// Dashboard sections addressable by URL: /dashboard plus /dashboard/<view>.
// pages/dashboard/[[...view]].tsx exports one static page per entry, so this
// list is the single source of truth for both the left rail and the routes.
// Kept free of the (client-only) DashboardApp so the page can import it for
// getStaticPaths without pulling the whole dashboard into the page bundle.

export const dashboardViews = [
  "home",
  "favorites",
  "tasks",
  "templates",
  "members",
  "trash",
] as const;

export type DashboardView = (typeof dashboardViews)[number];

export const dashboardTitles: Record<DashboardView, string> = {
  home: "Your designs",
  favorites: "Favorites",
  tasks: "My tasks",
  templates: "Templates",
  members: "Members",
  trash: "Trash",
};

/** Route for a section; home lives at the bare /dashboard path. */
export function dashboardPath(view: DashboardView): string {
  return view === "home" ? "/dashboard/" : `/dashboard/${view}/`;
}
