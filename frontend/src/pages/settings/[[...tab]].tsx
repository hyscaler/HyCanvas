import Head from "next/head";
import dynamic from "next/dynamic";
import type { GetStaticPaths, GetStaticProps } from "next";
import { RequireAuth } from "@/components/RequireAuth";
import {
  settingsTabTitles,
  settingsTabs,
  type SettingsTab,
} from "@/components/settings/tabs";
import { tr } from "@/lib/i18n";

// Client-only: depends on auth state and live API calls.
const SettingsApp = dynamic(() => import("@/components/settings/SettingsApp").then((m) => m.SettingsApp), {
  ssr: false,
  loading: () => <div className="grid min-h-screen place-items-center text-sm text-neutral-500">{tr("page.loading")}</div>,
});

interface SettingsPageProps {
  // null on the bare /settings path, which defaults to the Account tab (or
  // Security when returning from the SSO connect flow; see SettingsApp).
  tab: SettingsTab | null;
}

// One exported static page per settings tab, so each tab has a real URL:
// deep-linkable, refresh-safe, and back/forward-friendly. All of them render
// this same page component, so switching tabs keeps SettingsApp mounted.
export const getStaticPaths: GetStaticPaths = async () => ({
  paths: settingsTabs.map((t) => ({ params: { tab: t === "account" ? [] : [t] } })),
  fallback: false,
});

export const getStaticProps: GetStaticProps<SettingsPageProps> = async ({ params }) => {
  const slug = Array.isArray(params?.tab) ? params.tab[0] : null;
  return { props: { tab: (slug as SettingsTab | undefined) ?? null } };
};

export default function SettingsPage({ tab }: SettingsPageProps) {
  return (
    <>
      <Head>
        <title>{`${settingsTabTitles[tab ?? "account"]} · HyCanvas`}</title>
      </Head>
      <RequireAuth>
        <SettingsApp tab={tab} />
      </RequireAuth>
    </>
  );
}
