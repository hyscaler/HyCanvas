// Stock/elements catalog data model. The catalog is global
// (not workspace-scoped); favorites/recents are per user per workspace. The
// types and the logic over them are pure; the REST surface, CDN, pgvector
// similarity, and mini-app sandbox runtime are the backend/runtime layer.

export type StockKind =
  | "photo" | "video" | "audio" | "illustration" | "icon" | "sticker"
  | "shape" | "gradient" | "background" | "frame" | "grid" | "chart" | "model3d";

// "placeholder" marks bundled demo/sample assets (not owned by HyCanvas) that a
// deployment is expected to replace before production. "mit" covers bundled
// open-source packs whose license text ships in the library's LICENSE/NOTICE.
export type LicenseType = "hycanvas-free" | "cc0" | "cc-by" | "mit" | "public-domain" | "editorial" | "placeholder";

export interface LicenseInfo {
  type: LicenseType;
  attributionRequired: boolean;
  attributionText?: string;
  attributionUrl?: string;
  notes?: string;
}

export type StockFormat = "jpg" | "png" | "webp" | "svg" | "mp4" | "webm" | "mp3" | "glb" | "json";

export interface StockAsset {
  id: string;
  kind: StockKind;
  title: string;
  tags: string[];
  previewUrl: string;
  sourceUrl: string;
  format: StockFormat;
  animated: boolean;
  width?: number;
  height?: number;
  durationMs?: number;
  dominantColors: string[];
  orientation?: "landscape" | "portrait" | "square";
  style?: string[];
  peopleAttributes?: string[];
  license: LicenseInfo;
  embeddingId?: string;
  collectionIds: string[];
  /** Broad category for browse/filtering (for example "nature", "ui"). */
  category?: string;
  /** Inline SVG markup for vector kinds (icon/illustration/shape) when available. */
  svg?: string;
}

export interface Collection {
  id: string;
  title: string;
  description?: string;
  kind?: StockKind;
  trending?: boolean;
  seasonal?: boolean;
  assetIds: string[];
}

export type AppScope = "insert-node" | "edit-own-nodes" | "network" | "read-selection";

export interface MiniApp {
  id: string;
  name: string;
  icon: string;
  builtIn: boolean;
  scopes: AppScope[];
  entry: string;
}

export interface AttributionEntry {
  assetId: string;
  source: "stock";
  attributionText: string;
  attributionUrl?: string;
  nodeIds: string[];
}

/** Provenance attached to an inserted node (serialized under node.data). */
export interface NodeProvenance {
  origin: "stock" | "upload" | "ai" | "user";
  stockAssetId?: string;
  license?: LicenseInfo;
}

/** Combined catalog search query (FR-1, FR-2). Unset fields do not constrain. */
export interface StockQuery {
  text?: string;
  kind?: StockKind | StockKind[];
  orientation?: "landscape" | "portrait" | "square";
  color?: string; // hex
  category?: string;
  style?: string | string[];
  license?: LicenseType | LicenseType[];
  durationMs?: { min?: number; max?: number };
  collectionId?: string;
  sort?: "relevance" | "newest";
}

/** The data key under which NodeProvenance is serialized on a node. */
export const PROVENANCE_KEY = "provenance";
