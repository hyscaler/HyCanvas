// Settings tabs addressable by URL: /settings plus /settings/<tab>.
// pages/settings/[[...tab]].tsx exports one static page per entry. Kept free
// of the (client-only) SettingsApp so the page can import it for
// getStaticPaths without pulling the whole settings UI into the page bundle.

export const SETTINGS_TABS = ["account", "security", "notifications"] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_TITLES: Record<SettingsTab, string> = {
  account: "Settings",
  security: "Security settings",
  notifications: "Notification settings",
};

/** Route for a tab; account lives at the bare /settings path. */
export function settingsPath(tab: SettingsTab): string {
  return tab === "account" ? "/settings/" : `/settings/${tab}/`;
}
