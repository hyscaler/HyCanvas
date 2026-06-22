// Shared, framework-agnostic types for F33 (Publishing and scheduling).
// These mirror the publishing feature's data interfaces.
// so the backend and frontend can import a single definition. OAuth tokens are
// deliberately NOT part of any API-facing type; they live encrypted server-side.

export type SocialPlatform =
  | "instagram"
  | "facebook"
  | "x"
  | "linkedin"
  | "tiktok"
  | "pinterest"
  | "youtube";

export interface SocialAccount {
  id: string;
  workspaceId: string;
  platform: SocialPlatform;
  externalUserId: string; // platform account id
  displayName: string;
  avatarUrl?: string;
  scopes: string[];
  status: "active" | "expired" | "revoked";
  connectedBy: string; // userId
  connectedAt: string; // ISO
}

export interface PublishTarget {
  id: string;
  accountId: string;
  platform: SocialPlatform;
  kind: "profile" | "page" | "board" | "channel" | "organization";
  externalId: string; // page/board/channel id
  name: string;
}

export type PostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "canceled";

export interface ScheduledPost {
  id: string;
  workspaceId: string;
  designId: string;
  sourcePageId?: string; // which page renders the asset
  targets: PublishTargetSelection[];
  status: PostStatus;
  scheduledAt?: string; // ISO, undefined for post-now
  timezone: string; // IANA tz
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishTargetSelection {
  targetId: string;
  platform: SocialPlatform;
  caption: string;
  hashtags?: string[];
  firstComment?: string;
  link?: string;
  altText?: string;
  privacy?: "public" | "unlisted" | "private";
  renderVariantId: string; // the per-platform export variant
  externalPostId?: string; // set after publish
  externalPostUrl?: string;
  state: "pending" | "rendering" | "uploading" | "published" | "failed";
  error?: { code: string; message: string };
}

export interface RenderVariant {
  id: string;
  designId: string;
  pageId: string;
  width: number;
  height: number;
  format: "png" | "jpg" | "mp4";
  storageKey: string; // S3 key of rendered bytes
  bytes: number;
  createdAt: string;
}

export interface PostInsights {
  postId: string; // ScheduledPost id
  targetId: string;
  platform: SocialPlatform;
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  fetchedAt: string;
}

export interface DesignEmbed {
  id: string;
  designId: string;
  pageId?: string;
  mode: "live" | "snapshot";
  snapshotId?: string; // when mode === "snapshot"
  width?: number;
  height?: number;
  responsive: boolean;
  publicSlug: string; // used in embed URL
  createdAt: string;
}

export interface QrCode {
  id: string;
  workspaceId: string;
  targetType: "published_url" | "embed_url" | "custom";
  targetValue: string;
  ecLevel: "L" | "M" | "Q" | "H";
  fgColor: string;
  bgColor: string;
  logoAssetId?: string;
  format: "svg" | "png";
  storageKey: string;
  createdAt: string;
}
