// @hc/website types: the site model, plus the form and
// release shapes the pure exporter consumes. These mirror the @hc/schema and
// @hc/sdk types; they live here so the renderer is
// framework-agnostic and depends only on @hc/schema + @hc/color.

/** A navigation menu item: links to a page, an in-page anchor, or an external URL. */
export interface NavItem {
  id: string;
  label: string;
  target:
    | { kind: "page"; pageId: string }
    | { kind: "anchor"; pageId?: string; anchor?: string }
    | { kind: "external"; url?: string };
  children?: NavItem[];
  visible: boolean;
}

/** A single SEO meta block; the per-page overrides reuse a Partial of this. */
export interface Seo {
  title?: string;
  description?: string;
  keywords?: string[];
  canonical?: string;
  robots?: string;
  perPage?: Record<string, Partial<Seo>>;
}

export interface SiteSocial {
  ogTitle?: string;
  ogDescription?: string;
  ogImageAssetId?: string;
  twitterCard?: "summary" | "summary_large_image";
}

export interface SiteSettings {
  seo: Seo;
  faviconAssetId?: string;
  social: SiteSocial;
  /** Hash + gate are a serving concern; only the on/off flag travels in the model. */
  password: { enabled: boolean };
  /** Untrusted custom code injected only into the published output. */
  customCode?: { head?: string; bodyEnd?: string };
}

export interface Site {
  id?: string;
  workspaceId: string;
  designId: string;
  title: string;
  slug: string;
  homePageId: string;
  pageOrder: string[];
  nav: NavItem[];
  settings: SiteSettings;
  status: "draft" | "published" | "unpublished";
  currentReleaseId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A field on a form block. `name` is the submission key. */
export interface FormField {
  id: string;
  name: string;
  label: string;
  kind:
    | "text"
    | "email"
    | "number"
    | "textarea"
    | "select"
    | "radio"
    | "checkbox"
    | "file"
    | "hidden"
    | "submit";
  required?: boolean;
  options?: string[];
  validation?: { pattern?: string; min?: number; max?: number; maxFileMB?: number };
  placeholder?: string;
}

/** A form block. In the open file format this lives in the scene graph as a node
 *  (type "form"); the renderer accepts it as plain input either way. */
export interface FormBlock {
  id: string;
  fields: FormField[];
  afterSubmit: { kind: "message"; text: string } | { kind: "redirect"; url: string };
  notifyEmails?: string[];
}

/** A captured submission (name -> value), used by CSV export. */
export interface FormSubmission {
  id?: string;
  values: Record<string, unknown>;
  submittedAt?: string;
}

/** An immutable publish. Versioned releases drive rollback (FR-13). */
export interface SiteRelease {
  id: string;
  siteId: string;
  version: number;
  bundleKey?: string;
  publishedBy?: string;
  publishedAt?: string;
}
