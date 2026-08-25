// @hc/sdk - typed client for the HyCanvas REST API (served under /api/v1).
// Used by the web app (cookie auth, credentials: "include") and by third-party
// integrators (bearer token). See docs 15/04/11/36.

import type { Color, DesignFile } from "@hc/schema";
import type { AccessMode, Capability, HomeItem, Membership, TimeFormat, User, WeekStart, Workspace, WorkspaceRole } from "@hc/authz";
import type { BrandLintViolation } from "@hc/brandkit";

// Re-export the shared domain types so the SDK is a single import surface for
// consumers (the web app imports User/Workspace/HomeItem etc. from here).
export type { DesignFile } from "@hc/schema";
export type { HomeItem, Membership, TimeFormat, User, WeekStart, Workspace, WorkspaceKind, WorkspaceRole } from "@hc/authz";
// Sharing + permissions vocabulary lives in @hc/authz so client and
// server share it verbatim.
export type { AccessMode, Capability } from "@hc/authz";
// Brand-governance violation + applyable-fix model lives in
// @hc/brandkit so the editor's live lint and the SDK gate share one shape.
export type { BrandLintViolation, BrandLintFix } from "@hc/brandkit";

/** Owner-safe view of a background job returned by GET /jobs/:id. */
/** Which sign-in methods and account-creation paths an instance allows, mirrored
 *  from the backend AuthPolicy (AUTH_*_ENABLED env). Drives the sign-in UI. */
export interface AuthPolicy {
  passwordLogin: boolean;
  passwordSignup: boolean;
  magicLinkLogin: boolean;
  magicLinkSignup: boolean;
  oidcLogin: boolean;
  oidcSignup: boolean;
}

/** CAPTCHA settings for the sign-in page when one is configured (null otherwise).
 *  `siteKey` is the provider's public key; the secret stays server-side. */
export interface CaptchaSettings {
  provider: "turnstile" | "recaptcha";
  siteKey: string;
}

/** The X-Captcha-Token header the auth endpoints check, or {} when no token. */
function captchaHeaders(token?: string): { headers: Record<string, string> } | undefined {
  return token ? { headers: { "x-captcha-token": token } } : undefined;
}

export interface JobStatusView<R = unknown> {
  id: string;
  name: string;
  status: "queued" | "active" | "completed" | "failed";
  result?: R;
  error?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

/** Result payload of a completed video export job. */
export interface VideoExportResult {
  key: string;
  url: string;
  sizeBytes: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

/** Result payload of a completed doc export job. */
export interface DocExportResult {
  key: string;
  url: string;
  sizeBytes: number;
  format: "docx" | "pdf";
}

/** Result payload of a completed whiteboard-to-deck conversion. */
export interface WhiteboardToDeckResult {
  designId: string;
  slides: number;
}

export interface ClientOptions {
  /** Base URL of the API, e.g. "http://localhost:8005/api" or "/api". */
  baseUrl: string;
  /** Optional bearer token for non-browser/programmatic use. */
  token?: string;
  /** Send cookies with requests (web app uses "include" for httpOnly auth). */
  credentials?: RequestCredentials;
  /** Override fetch (Node before global fetch, tests, etc.). */
  fetch?: typeof fetch;
}

export interface WorkspaceWithRole extends Workspace {
  role: WorkspaceRole;
}

/** A workspace member as shown in the roster (richer than authz Membership: it
 *  joins the user's profile so the UI can render names/emails). */
export interface WorkspaceMemberView {
  userId: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: WorkspaceRole;
  status: "invited" | "active" | "suspended";
  joinedAt?: string;
}

/** A pending or accepted workspace invitation. `workspaceName` is populated for
 *  the invitee's own view (the in-app accept/decline surface). */
export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspaceName?: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  expiresAt: string;
  acceptedAt?: string | null;
  createdAt: string;
}

export interface DesignRecord {
  id: string;
  workspaceId: string;
  title: string;
  schemaVersion: number;
  currentSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  purgeAfter: string | null;
}

/** A version's author, resolved for the history time machine. */
export interface VersionAuthor {
  id: string;
  name: string;
}

export interface VersionEntry {
  id: string;
  designId: string;
  snapshotId: string;
  label: string | null;
  authorId: string | null;
  /** Resolved author (id + display name); null when unknown (FR-9). */
  author?: VersionAuthor | null;
  /** The underlying snapshot kind, so the panel can highlight named checkpoints
   *  and restores. */
  kind?: SnapshotKind;
  createdAt: string;
}

/** One paginated page of a design's version history. */
export interface VersionPage {
  items: VersionEntry[];
  nextCursor?: string;
}

/** One journaled realtime update from the CRDT history log (FR-9): a base64
 *  y-protocols update frame the client folds into an ephemeral Y.Doc to scrub
 *  history, plus its author and timestamp. */
export interface DesignUpdateEntry {
  seq: number;
  authorId?: string | null;
  /** Resolved author display name; empty when unknown. */
  authorName?: string;
  /** base64-encoded y-protocols sync update (message type 2). */
  update: string;
  createdAt: string;
  /** True for a full-state checkpoint row that begins a compacted log: fold from
   *  it as the base, then apply the tail deltas (FR-11). */
  isCheckpoint?: boolean;
}

/** Live audience (doc 28): one viewer question with computed votes. */
export interface AudienceQuestion {
  id: string;
  authorName: string;
  text: string;
  votes: number;
  answered: boolean;
  dismissed?: boolean;
  createdAt: string;
  voted?: boolean;
}
/** Live audience: one presenter poll with computed per-option counts. */
export interface AudiencePoll {
  id: string;
  question: string;
  options: string[];
  counts: number[];
  open: boolean;
  createdAt: string;
  myVote: number;
}
export interface AudienceState {
  questions: AudienceQuestion[];
  polls: AudiencePoll[];
  /** The presenter's live slide position (slide-follow), when one is fresh. */
  live?: { slide: number; updatedAt: string };
}

/** A named in-CRDT branch of a design (doc 16 FR-10): a fork point inside one
 *  design whose state is the parent lineage up to `forkedFromSeq` plus the
 *  branch's own update rows. */
export interface CrdtBranch {
  id: string;
  designId: string;
  name: string;
  forkedFromSeq: number;
  parentBranchId?: string;
  createdById?: string;
  createdAt: string;
}

/** A forward-paginated, ascending-seq slice of the CRDT update log. */
export interface DesignUpdatePage {
  items: DesignUpdateEntry[];
  /** Pass back as `afterSeq` to fetch the next page; absent when exhausted. */
  nextSeq?: number;
}

/** A design branched from another design's history point. */
export interface BranchEntry {
  id: string;
  title: string;
  sourceDesignId: string | null;
  sourceVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  id: string;
  device: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/** TOTP enrollment material: the otpauth URL plus the raw secret. */
export interface MfaEnrollment {
  otpauthUrl: string;
  secret: string;
}

/**
 * The result of a password login: either a completed sign-in (`user`), or an
 * MFA challenge (`mfaRequired`) that must be redeemed via `verifyMfa`.
 */
export type LoginResult =
  | { user: User; mfaRequired?: false }
  | { mfaRequired: true; mfaToken: string };

/** A recorded dev-mail message (returned by the dev-only outbox route). */
export interface OutboxMessage {
  to: string;
  subject: string;
  text: string;
  link?: string;
  sentAt?: string;
}

export type SnapshotKind = "auto" | "checkpoint" | "named" | "restore" | "branch";
/** Kinds a client may save. "branch" is minted by the branch endpoint only;
 *  the snapshot route rejects it with 422. */
export type SavableSnapshotKind = Exclude<SnapshotKind, "branch">;

export interface TemplateSummary {
  id: string;
  title: string;
  categories: string[];
  previewUrls: string[];
  format: { width: number; height: number; unit: string };
}

export type TemplateVisibility = "private" | "workspace" | "public";

export interface TemplateListFilter {
  q?: string;
  category?: string;
  collection?: string;
  workspaceId?: string;
}

export interface SaveAsTemplateInput {
  workspaceId: string;
  /** Provide one of designId or file. */
  designId?: string;
  file?: DesignFile;
  title: string;
  category?: string;
  tags?: string[];
  thumbnail?: string;
  visibility?: TemplateVisibility;
  collectionId?: string;
}

// --- bulk create + data autofill ----------------

/** A fillable field a dataset can map onto. `nodeId` is the stable key; `label`
 *  is the human name used to auto-match dataset columns. */
export interface FillableFieldSummary {
  nodeId: string;
  kind: "text" | "image" | "color";
  label: string;
  hint?: string;
  constraints?: { maxChars?: number; aspect?: number; required?: boolean };
}

/** One row of fill values, keyed by field nodeId. */
export type FillRowValues = Record<string, { text?: string; imageUrl?: string }>;

export interface BulkCreateInput {
  workspaceId: string;
  /** Provide exactly one base source. */
  sourceTemplateId?: string;
  sourceDesignId?: string;
  /** Dataset rows, each a flat map of field nodeId -> string value. */
  rows: Array<Record<string, string>>;
  /** Naming pattern with `{field}` placeholders (label or nodeId). */
  titlePattern?: string;
}

export interface BulkCreateResult {
  created: Array<{ id: string; title: string }>;
  truncated: boolean;
  requestedRows: number;
  skipped: Array<{ row: number; reason: string }>;
}

export interface TemplateCollectionSummary {
  id: string;
  workspaceId: string;
  name: string;
}

export interface StockAssetSummary {
  id: string;
  kind: string;
  title: string;
  previewUrl: string;
  sourceUrl: string;
  format: string;
  width?: number;
  height?: number;
  category?: string;
  collectionIds?: string[];
  /** Whether the current user has favorited this asset. */
  favorited?: boolean;
  /** Inline SVG markup for vector kinds (icons), for editable vector insertion. */
  svg?: string;
  /** Bundled-library pack id (e.g. "twemoji"), when the asset ships with the app. */
  pack?: string;
  /** True for a live upstream-provider asset (Openverse photo, Iconify icon) that
   *  is not in the bundled catalog: favorites/recents don't apply and it is
   *  imported/inlined on placement rather than drag-proxied. */
  live?: boolean;
  /** License metadata; attribution-required assets are stamped with provenance
   *  on insert so credits compile from the design. */
  license?: { type?: string; holder?: string; url?: string; attributionRequired?: boolean; attributionText?: string; attributionUrl?: string };
}

export interface StockCollectionSummary {
  id: string;
  title: string;
  description?: string;
  kind?: string;
  trending?: boolean;
  seasonal?: boolean;
  /** "pack" for a bundled-library source (ManyPixels, Open Doodles, Tabler, ...),
   *  absent for a curated theme. The browse UI shows curated themes as top-level
   *  Collection chips and pack sources as a per-kind Source facet. */
  source?: string;
  /** Curated seed collections list their members; bundled-pack collections
   *  omit this (assets point back via collectionIds instead). */
  assetIds?: string[];
}

/** One value of a filterable stock facet (category/style/orientation), scoped
 *  to an asset kind, with how many bundled assets carry it. */
export interface StockFacetValue {
  id: string;
  kind: string;
  count: number;
}

/** The bundled catalog's filterable facets, aggregated per kind and sorted by
 *  count. Facets apply to the bundled catalog only: a faceted photo search
 *  stays on the bundled catalog instead of the live provider. */
export interface StockFiltersSummary {
  categories: StockFacetValue[];
  styles: StockFacetValue[];
  orientations: StockFacetValue[];
}

export interface MiniAppSummary {
  id: string;
  name: string;
  icon: string;
  builtIn: boolean;
  scopes: string[];
  entry: string;
}

/** What an AI provider can do (mirrors the Go ai.Capabilities record). */
export interface AiCapabilities {
  text: boolean;
  image: boolean;
  describeImage: boolean;
  editImage: boolean;
}

export interface AiConfigView {
  provider: string;
  model: string | null;
  imageModel: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  /** What the configured provider can do (gates image-dependent features). */
  capabilities: AiCapabilities;
}

/** One entry of the server's provider preset catalog (GET /ai/providers). */
export interface AiProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  defaultImageModel?: string;
  capabilities: AiCapabilities;
  /** True when the user must supply the base URL (Azure/custom). */
  needsBaseUrl?: boolean;
}

// --- AI Creative Studio (F39) views, returned by the orchestration endpoints.
export type AiStudioDesignType = "deck" | "doc" | "social-set" | "poster";
export interface AiOutlineItem {
  title: string;
  points: string[];
  visualRole: string;
  /** Speaker note: 1-3 spoken-style plain-text sentences (100-500 chars). */
  note?: string;
}
export interface AiDesignOutline {
  title: string;
  theme: string;
  pages: AiOutlineItem[];
}
export interface AiChartSpec {
  chartType: string;
  categories: string[];
  series: { name: string; values: number[] }[];
}
export interface AiPlanStep {
  action: string;
  args: Record<string, unknown>;
}
export interface AiAssistantReply {
  reply: string;
  clarify?: string;
  plan: AiPlanStep[];
}
export interface AiStyleProfile {
  palette: string[];
  mood: string;
  typeFeel: string;
  composition: string;
}
export interface AiSessionView {
  id: string;
  workspaceId: string;
  designId: string;
  createdAt: string;
}
export interface AiTurnView {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  plan?: unknown;
  provenance?: unknown;
  createdAt: string;
}

// Org AI governance policy: provider allow/block lists + monthly token
// cap, enforced server-side before each AI call.
export interface AiPolicy {
  allowedProviders?: string[];
  blockedProviders?: string[];
  monthlyTokenCap?: number;
}

// --- sharing + permissions --------------------------------------

/**
 * A per-design access grant for a member (by user id) or invitee (by email).
 * For user-kind grants the sharing view also carries the person's display
 * `name`/`email` so the UI can show who they are rather than a raw id.
 */
export interface ShareGrant {
  id: string;
  designId: string;
  principal: { kind: "user" | "email"; id: string; name?: string; email?: string };
  mode: AccessMode;
  roleId?: string | null;
  invitedBy?: string | null;
  /** Display name of the inviter, when resolvable (attribution). */
  invitedByName?: string;
  createdAt: string;
}

/** A pending (or resolved) request to access a design (FR-5 request access). */
export interface AccessRequestView {
  id: string;
  designId: string;
  requester: { kind: "user" | "email"; id: string; name?: string; email?: string };
  mode: AccessMode;
  message?: string;
  status: "pending" | "granted" | "denied";
  createdAt: string;
}

/** A share link. `token` is the URL secret; the password is never returned. */
export interface ShareLinkView {
  id: string;
  designId: string;
  token: string;
  mode: AccessMode;
  hasPassword: boolean;
  expiresAt?: string | null;
  disabled: boolean;
  requireSignin: boolean;
  /** Audience name for the link ("Investors", "All-hands"); labels per-link
   *  analytics (C36). Empty when unnamed. */
  label?: string;
  createdAt: string;
}

/** A named capability set assignable at workspace or design scope. */
export interface CustomRoleView {
  id: string;
  workspaceId: string;
  designId?: string | null;
  name: string;
  capabilities: Capability[];
  scope: "workspace" | "design";
  createdAt: string;
}

/** The caller's resolved access to a design (mode + capability set). */
export interface DesignAccessView {
  mode: AccessMode;
  capabilities: Capability[];
}

/** Everything the Share dialog needs: the caller's access plus grants/links/roles. */
export interface DesignSharingView {
  myAccess: DesignAccessView;
  /** The design's creator, for owner attribution (absent if unknown). */
  owner?: { kind: "user" | "email"; id: string; name?: string; email?: string };
  grants: ShareGrant[];
  links: ShareLinkView[];
  customRoles: CustomRoleView[];
}

/** The result of resolving a share link by token. */
export interface ResolvedLink {
  designId: string;
  mode: AccessMode;
}

// --- comments + tasks ------------------------------------

/** Where a comment is pinned on a design. `orphaned` is set on read
 *  when an element anchor's node no longer exists (the pin hides, the thread
 *  still lists). */
export interface CommentAnchor {
  kind: "design" | "page" | "element" | "region" | "video";
  pageId?: string;
  nodeId?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  timeMs?: number;
  orphaned?: boolean;
}

export type TaskStatus = "open" | "in_progress" | "done";

/** The task facet of a comment once converted to a task. */
export interface CommentTask {
  assigneeId: string | null;
  status: TaskStatus;
  dueAt: string | null;
}

/** A reaction bucket: an emoji and the user ids who reacted with it. */
export interface CommentReaction {
  emoji: string;
  userIds: string[];
}

/** A single comment (thread root or reply). Replies nest under their root in
 *  {@link CommentThread}. `mentions` are recorded @mention user ids (FR-3). */
export interface Comment {
  id: string;
  designId: string;
  parentId: string | null;
  authorId: string | null;
  authorName: string;
  anchor: CommentAnchor;
  body: string;
  mentions: string[];
  reactions: CommentReaction[];
  resolved: boolean;
  resolvedById?: string | null;
  task?: CommentTask | null;
  editedAt?: string | null;
  createdAt: string;
}

/** A thread: a root comment plus its replies in creation order. */
export interface CommentThread extends Comment {
  replies: Comment[];
}

/** A person who can be @mentioned or assigned on a design. */
export interface MentionablePerson {
  id: string;
  name: string;
  email?: string | null;
}

/** A task in the assignee's "my tasks" view, carrying its design for deep-link. */
export interface MyTask extends Comment {
  designTitle: string;
}

/** Filters for {@link HyCanvasClient.listComments}. */
export type CommentFilter = "open" | "resolved" | "mine" | "assigned" | "all";

// --- approval workflows ----------------------------------

/** Whether one approver suffices or all must approve. */
export type ApprovalPolicy = "any" | "all";
/** Lifecycle of an approval; 'approved' locks the design (FR-11). */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "reopened";
export type ApprovalDecisionKind = "approve" | "reject";

/** A requester/approver identity for the banner. */
export interface ApprovalPerson {
  id: string;
  name: string;
}

/** One approver's recorded verdict. */
export interface ApprovalDecisionView {
  approverId: string;
  approverName: string;
  decision: ApprovalDecisionKind;
  note?: string | null;
  decidedAt: string;
}

/** What the calling user may do on the current approval (server-computed). */
export interface ApprovalActions {
  canRequest: boolean;
  canDecide: boolean;
  canReopen: boolean;
}

/** One approval workflow. */
export interface ApprovalView {
  id: string;
  designId: string;
  requester: ApprovalPerson;
  policy: ApprovalPolicy;
  status: ApprovalStatus;
  approvers: ApprovalPerson[];
  decisions: ApprovalDecisionView[];
  approvedCount: number;
  approverCount: number;
  createdAt: string;
  decidedAt?: string | null;
}

/** A design's current approval state + the caller's allowed actions (FR-10,
 *  FR-11), returned by GET /v1/designs/:id/approval. `locked` is the derived
 *  approval-lock state (an active approved approval). */
export interface DesignApprovalView {
  approval: ApprovalView | null;
  locked: boolean;
  actions: ApprovalActions;
}

// --- whiteboard voting (F30 FR-19/FR-20) -----------------

/** A server-authoritative dot-vote round. */
export interface WhiteboardVoteSession {
  id: string;
  designId: string;
  budgetPerUser: number;
  anonymous: boolean;
  revealed: boolean;
  open: boolean;
}

/** Standings for one viewer. `counts` is per node id; `mine` is the caller's own
 *  picks; `voters` (per node) is present only when revealed and not anonymous. */
export interface WhiteboardVoteTally {
  session: WhiteboardVoteSession;
  counts: Record<string, number>;
  mine: string[];
  remainingBudget: number;
  voters?: Record<string, string[]>;
}

// --- activity, notifications, insights -------------------

/** Every activity-feed item type. `edit` items are folded in
 *  from the version history at read time; the rest are stored activity events. */
export type ActivityType =
  | "edit" | "comment" | "resolve" | "reply" | "reaction"
  | "share" | "link_change" | "role_change"
  | "task_assign" | "task_status"
  | "approval_request" | "approval_decision" | "reopen";

/** A single attributed feed item with a rendered human summary (FR-12). */
export interface ActivityItem {
  id: string;
  designId: string;
  type: ActivityType;
  actorId: string | null;
  actorName: string | null;
  summary: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  source: "activity" | "version";
}

/** A page of activity items, newest-first, with an opaque cursor (FR-12). */
export interface ActivityPage {
  items: ActivityItem[];
  nextCursor?: string;
}

/** Notification types the center aggregates. */
export type NotificationType =
  | "mention" | "reply" | "task_assign"
  | "share" | "approval_request" | "approval_decision"
  | "access_request" | "access_decision"
  | "workspace_invite";

/** An in-app notification for the bell/center (FR-13). */
export interface NotificationView {
  id: string;
  type: NotificationType;
  designId: string | null;
  text: string;
  link: string;
  read: boolean;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor?: string;
}

/** Per-user notification-channel preference (FR-13). `emailTypes` are delivered
 *  by email and `pushTypes` by web push, each in addition to always-on in-app. */
export interface NotificationPrefView {
  emailTypes: NotificationType[];
  pushTypes: NotificationType[];
}

/** Aggregated engagement insights for a design. */
export interface DesignInsights {
  uniqueViewers: number;
  uniqueAnonViewers: number;
  totalViews: number;
  views: { date: string; count: number }[];
  avgTimeMs: number;
  perPage: { pageId: string; engagementMs: number }[];
  /** Per share link (C36): sessions attributed to the link they arrived
   *  through. Absent/empty when no share-link views were recorded. */
  links?: { linkId: string; label?: string; views: number; viewers: number; totalMs: number }[];
}

export interface UploadedAsset {
  id: string;
  workspaceId: string;
  kind: string;
  filename: string | null;
  mimeType: string | null;
  byteSize: number | null;
  folderId: string | null;
  tags: string[];
  url: string;
  /** Optional client-generated downscaled preview (data URL); grid falls back to url. */
  thumbnail: string | null;
  createdAt: string;
}

export interface AssetFolder {
  id: string;
  workspaceId: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface StorageUsageView {
  usedBytes: number;
  quotaBytes: number;
  /** The caller's uploads across ALL workspaces (global account usage). */
  userUsedBytes: number;
  /** Global per-user cap; 0 = unlimited. */
  userQuotaBytes: number;
}

/** Filters for {@link HyCanvasClient.listAssets}. `folderId: null` = root. */
export interface AssetListFilter {
  folderId?: string | null;
  tag?: string;
  q?: string;
}

// --- brand kits + controls ---------------------------------------

/** A named brand swatch within a palette; `value` is a canonical sRGB Color. */
export interface BrandSwatch {
  id: string;
  role: string;
  name?: string;
  value: Color;
}
export interface BrandPalette {
  id: string;
  name: string;
  colors: BrandSwatch[];
}
export interface BrandFont {
  id: string;
  role: string;
  fontFamily: string;
  fontAssetId?: string | null;
  defaultStyle?: { weight?: number; size?: number; tracking?: number };
}
export interface BrandLogo {
  id: string;
  label: string;
  assetId: string;
  variants?: { dark?: string; light?: string };
  clearSpaceRatio?: number;
  minSizePx?: number;
}
export interface BrandVoice {
  tone: string[];
  doSay: string[];
  dontSay: string[];
  sampleCopy?: string;
  modelProfileId?: string;
}
export interface BrandCollection {
  id: string;
  kind: "photos" | "graphics" | "icons";
  assetIds: string[];
}
/** Brand controls: lock colors/fonts, restrict templates (FR-4, FR-5), and the
 *  slice-B pre-export/publish lint strictness (FR-8). `lintPolicy` is 'off'
 *  (never lint), 'warn' (surface violations), or 'block' (gate export). */
export interface BrandControls {
  lockColors: boolean;
  lockFonts: boolean;
  restrictTemplates: boolean;
  lintPolicy: "off" | "warn" | "block";
}
/** A workspace brand kit. `version` is the current version
 *  number, incremented on every write and recorded in {@link BrandKitVersion}. */
export interface BrandKit {
  id: string;
  workspaceId: string;
  name: string;
  /** Current version number (FR-9); incremented on every write. */
  version: number;
  isDefault: boolean;
  palettes: BrandPalette[];
  fonts: BrandFont[];
  logos: BrandLogo[];
  voice: BrandVoice | null;
  collections: BrandCollection[];
  controls: BrandControls;
  createdAt: string;
  updatedAt: string;
}
/** One versioned snapshot of a kit's state. `snapshot` is the full
 *  BrandKit at that version, so restore can rebuild it exactly. */
export interface BrandKitVersion {
  id: string;
  brandKitId: string;
  version: number;
  snapshot: BrandKit;
  authorId: string | null;
  createdAt: string;
}
/** A brand-template editable field descriptor: a node a filler may
 *  populate, with a label and optional fill constraints. Mirrors the @hc/templates
 *  FillableField shape; informational at the brand layer. */
export interface BrandEditableField {
  nodeId: string;
  kind?: "text" | "image" | "color";
  label: string;
  hint?: string;
  constraints?: { maxChars?: number; aspect?: number; required?: boolean };
}
/** The design's active resolved brand + whether the caller may manage it
 *. `kit` is null when no brand is assigned/default. */
export interface ResolvedBrand {
  kit: BrandKit | null;
  canManage: boolean;
  /** The pinned kit version this design references, or null when it tracks the
   *  latest (FR-10). Null + a kit means "track latest". */
  pinnedVersion?: number | null;
  /** Brand-template locked-region node ids the design carries (FR-6, AC-4); the
   *  editor gates structural mutation of these for non-manage-brand users. */
  lockedRegions: string[];
  /** Brand-template editable fields the design carries (FR-6): the nodes a
   *  filler may populate. Informational; empty when none are marked. */
  editableFields?: BrandEditableField[];
}
/** Whether a tracked kit advanced past what a design reflects,
 *  with a summary of what changed, so the editor can prompt "Brand updated -
 *  review" rather than silently mutating the design. */
export interface BrandUpdateSummary {
  /** True when the design TRACKS the kit (not pinned) and the kit advanced. */
  hasUpdate: boolean;
  /** The version the design currently reflects; null when tracking with no record. */
  designVersion: number | null;
  /** The kit's current (latest) version. */
  latestVersion: number;
  /** Whether the design pins a specific version (true) or tracks latest. */
  pinned: boolean;
  /** Human-readable diffs of what changed (palette/font counts, controls). */
  changes: string[];
}
/** The brand gate decision for a design's pre-export/publish check (FR-8). */
export interface BrandLintResult {
  policy: "off" | "warn" | "block";
  blocked: boolean;
  violations: BrandLintViolation[];
}
/** Patch for {@link HyCanvasClient.updateBrandKit}. */
export interface BrandKitPatch {
  name?: string;
  isDefault?: boolean;
  palettes?: BrandPalette[];
  fonts?: BrandFont[];
  logos?: BrandLogo[];
  voice?: BrandVoice | null;
  collections?: BrandCollection[];
  controls?: Partial<BrandControls>;
}

/** Thrown on a non-2xx response; carries the status and parsed problem body. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: unknown,
  ) {
    super(`HyCanvas API ${status} on ${path}`);
    this.name = "ApiError";
  }
}

export class HyCanvasClient {
  private readonly baseUrl: string;
  private token?: string;
  private readonly credentials: RequestCredentials;
  private readonly fetchImpl: typeof fetch;
  // De-duped in-flight refresh: concurrent 401s share one refresh, then retry.
  private refreshing: Promise<boolean> | null = null;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.credentials = opts.credentials ?? "same-origin";
    // Wrap fetch so the global is always called as a bare function, never as a
    // method of this client. Browsers brand-check fetch's receiver and throw
    // "TypeError: Illegal invocation" if `this` isn't the Window/Worker global,
    // which would surface as a thrown error with no request ever sent. (Node's
    // fetch has no such check, so this only bit in the browser.)
    const impl = opts.fetch ?? fetch;
    this.fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => impl(input, init);
  }

  /** Set/clear the bearer token (no-op for cookie auth). */
  setToken(token?: string): void {
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { headers?: Record<string, string> },
    retried = false,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts?.headers) Object.assign(headers, opts.headers);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      credentials: this.credentials,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Cookie-auth sessions: the short-lived access token expires well before the
    // refresh token. On a 401, transparently refresh once (using the refresh
    // cookie) and retry the original request, so callers never see a spurious
    // auth failure mid-session. Auth endpoints are excluded to avoid loops (a
    // 401 from login/refresh is a real failure).
    if (res.status === 401 && !retried && !path.startsWith("/v1/auth/")) {
      if (await this.tryRefresh()) return this.request<T>(method, path, body, opts, true);
    }
    if (!res.ok) {
      let parsed: unknown = undefined;
      try {
        parsed = await res.json();
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, path, parsed);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Refresh the session once, de-duping concurrent callers. Resolves true when
   *  a new access cookie was minted (caller may retry). */
  private tryRefresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = this.fetchImpl(`${this.baseUrl}/v1/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: this.credentials,
        body: "{}",
      })
        .then((r) => r.ok)
        .catch(() => false)
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  // --- health --------------------------------------------------------------
  health(): Promise<{ status: string }> {
    return this.request("GET", "/healthz");
  }

  // --- auth -------------------------------------------------------
  signup(
    input: { email: string; password: string; name?: string },
    captchaToken?: string,
  ): Promise<{ user: User; workspace: Workspace }> {
    return this.request("POST", "/v1/auth/signup", input, captchaHeaders(captchaToken));
  }
  /**
   * Sign in with email + password. If the account has MFA enabled the server
   * returns `{ mfaRequired: true, mfaToken }` and sets no session cookie; the
   * client must then call `verifyMfa(mfaToken, code)` to finish signing in.
   * `captchaToken` is required when the instance has a CAPTCHA on the auth forms.
   */
  login(input: { email: string; password: string }, captchaToken?: string): Promise<LoginResult> {
    return this.request("POST", "/v1/auth/login", input, captchaHeaders(captchaToken));
  }

  // --- MFA: TOTP + recovery codes ----------------------------
  /** Begin TOTP enrollment; returns the otpauth URL (for a QR) and raw secret. */
  enrollMfa(): Promise<MfaEnrollment> {
    return this.request("POST", "/v1/auth/mfa/enroll", {});
  }
  /** Confirm enrollment with a code; returns the one-time recovery codes. */
  confirmMfa(code: string): Promise<{ recoveryCodes: string[] }> {
    return this.request("POST", "/v1/auth/mfa/confirm", { code });
  }
  /** Disable MFA after proving a current TOTP code or an unused recovery code. */
  disableMfa(code: string): Promise<void> {
    return this.request("POST", "/v1/auth/mfa/disable", { code });
  }
  /** Finish an MFA-gated login; sets the session cookies like login. */
  verifyMfa(mfaToken: string, code: string): Promise<{ user: User }> {
    return this.request("POST", "/v1/auth/mfa/verify", { mfaToken, code });
  }
  /** Refresh the session, sharing the same de-duped in-flight refresh as the
   *  automatic 401 retry. Parallel refresh POSTs carrying the same cookie race
   *  the server-side rotation and can strand the browser on a dead token, so
   *  every caller (401 interceptor, bootstrap, tabs) must funnel through one
   *  request. Resolves { ok: false } instead of throwing on failure. */
  async refresh(): Promise<{ ok: boolean }> {
    return { ok: await this.tryRefresh() };
  }
  logout(all = false): Promise<void> {
    return this.request("POST", "/v1/auth/logout", { all });
  }
  /** Update the signed-in user's profile: name, avatar, locale, and the regional
   *  preferences (timezone, timeFormat, weekStart). Pass `avatarUrl: ""` to clear
   *  the avatar. Omitted fields are left unchanged. Returns the refreshed user. */
  updateProfile(input: {
    name?: string;
    avatarUrl?: string;
    locale?: string;
    timezone?: string;
    timeFormat?: TimeFormat;
    weekStart?: WeekStart;
  }): Promise<User> {
    return this.request("PATCH", "/v1/me", input);
  }
  me(): Promise<User> {
    return this.request("GET", "/v1/me");
  }
  sessions(): Promise<SessionInfo[]> {
    return this.request("GET", "/v1/auth/sessions");
  }

  // --- account data portability -----------------------------
  /** Download a full export of the user's data (profile, workspaces, designs). */
  exportAccount(): Promise<unknown> {
    return this.request("GET", "/v1/account/export");
  }
  /**
   * Permanently delete the account after re-authentication. Always requires the
   * current password; `code` is a TOTP or recovery code when MFA is enabled.
   */
  deleteAccount(input: { password: string; code?: string }): Promise<void> {
    return this.request("DELETE", "/v1/account", input);
  }

  // --- email flows -------------------------------------------
  /** Request (or re-send) an email-verification link. Always resolves. */
  requestEmailVerification(email: string): Promise<void> {
    return this.request("POST", "/v1/auth/verify-email/request", { email });
  }
  /** Verify an email with the token from the link; returns the updated user. */
  verifyEmail(token: string): Promise<{ user: User }> {
    return this.request("POST", "/v1/auth/verify-email", { token });
  }
  /** Request a password-reset link. Always resolves (no account enumeration). */
  requestPasswordReset(email: string, captchaToken?: string): Promise<void> {
    return this.request("POST", "/v1/auth/password-reset/request", { email }, captchaHeaders(captchaToken));
  }
  /** Set a new password using the token from the reset link. */
  resetPassword(token: string, password: string): Promise<void> {
    return this.request("POST", "/v1/auth/password-reset", { token, password });
  }
  /** Request a passwordless sign-in link. Always resolves (no enumeration). */
  requestMagicLink(email: string, captchaToken?: string): Promise<void> {
    return this.request("POST", "/v1/auth/magic-link/request", { email }, captchaHeaders(captchaToken));
  }
  /** Complete a magic-link sign-in; sets the session cookies like login. */
  magicLink(token: string): Promise<{ user: User }> {
    return this.request("POST", "/v1/auth/magic-link", { token });
  }
  /** Enabled social sign-in providers (empty unless configured server-side).
   *  The login UI renders a button per entry; start the flow by navigating the
   *  browser to `${baseUrl}/v1/auth/{id}/start`. */
  authProviders(): Promise<{ id: string; label: string }[]> {
    return this.authConfig().then((r) => r.providers);
  }
  /** The instance's auth configuration: the SSO providers plus which sign-in
   *  methods and account-creation paths are enabled (AUTH_*_ENABLED). The sign-in
   *  page renders only the methods the policy allows. */
  authConfig(): Promise<{ providers: { id: string; label: string }[]; policy: AuthPolicy; captcha: CaptchaSettings | null }> {
    return this.request<{ providers: { id: string; label: string }[]; policy: AuthPolicy; captcha: CaptchaSettings | null }>(
      "GET",
      "/v1/auth/providers",
    );
  }
  /** SSO status for the signed-in user: whether an OIDC identity is linked and
   *  whether SSO is configured at all (so the UI can hide the card when it isn't).
   *  Start the connect flow by navigating to `${baseUrl}/v1/auth/oidc/link`. */
  oidcIdentity(): Promise<{ linked: boolean; configured: boolean }> {
    return this.request("GET", "/v1/auth/oidc/identity");
  }
  /** Disconnect the caller's SSO identity. Refused (409) if SSO is their only
   *  way to sign in (no password set), to avoid locking them out. */
  disconnectOidc(): Promise<void> {
    return this.request("DELETE", "/v1/auth/oidc/identity");
  }
  /** Dev-only: read the in-memory mail outbox (404/403 in production). */
  devOutbox(): Promise<OutboxMessage[]> {
    return this.request("GET", "/v1/auth/dev/outbox");
  }

  // --- workspaces -------------------------------------------------
  listWorkspaces(): Promise<WorkspaceWithRole[]> {
    return this.request("GET", "/v1/workspaces");
  }
  createWorkspace(input: { name: string; kind?: Workspace["kind"] }): Promise<Workspace> {
    return this.request("POST", "/v1/workspaces", input);
  }
  /** Permanently delete a team/org/classroom workspace and everything in it
   *  (owner only; personal workspaces cannot be deleted). */
  deleteWorkspace(workspaceId: string): Promise<void> {
    return this.request("DELETE", `/v1/workspaces/${workspaceId}`);
  }
  workspaceMembers(workspaceId: string): Promise<WorkspaceMemberView[]> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/members`);
  }
  invite(workspaceId: string, input: { email: string; role?: WorkspaceRole }): Promise<{ invitation: WorkspaceInvitation; token: string }> {
    return this.request("POST", `/v1/workspaces/${workspaceId}/invitations`, input);
  }
  acceptInvitation(token: string): Promise<Membership> {
    return this.request("POST", `/v1/invitations/${encodeURIComponent(token)}/accept`, {});
  }
  /** The signed-in user's own pending invitations (for the in-app accept/decline surface). */
  myInvitations(): Promise<WorkspaceInvitation[]> {
    return this.request("GET", "/v1/invitations/mine");
  }
  /** Accept (true) or decline (false) one of the caller's invitations by id. */
  respondToInvitation(invitationId: string, accept: boolean): Promise<Membership | void> {
    return this.request("POST", `/v1/invitations/${invitationId}/respond`, { accept });
  }
  workspaceInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/invitations`);
  }
  revokeInvitation(workspaceId: string, invitationId: string): Promise<void> {
    return this.request("DELETE", `/v1/workspaces/${workspaceId}/invitations/${invitationId}`);
  }
  changeMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    return this.request("PATCH", `/v1/workspaces/${workspaceId}/members/${userId}`, { role });
  }
  removeMember(workspaceId: string, userId: string): Promise<void> {
    return this.request("DELETE", `/v1/workspaces/${workspaceId}/members/${userId}`);
  }

  // --- home + search ----------------------------------------------
  home(workspaceId: string, section: "recent" | "favorites" | "shared" = "recent"): Promise<HomeItem[]> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/home?section=${section}`);
  }
  search(workspaceId: string, q?: string, type?: HomeItem["kind"] | HomeItem["kind"][]): Promise<HomeItem[]> {
    const params = new URLSearchParams({ workspaceId });
    if (q) params.set("q", q);
    if (type) params.set("type", Array.isArray(type) ? type.join(",") : type);
    return this.request("GET", `/v1/search?${params.toString()}`);
  }
  /** Star/unstar a design for the current user; returns the resulting state. */
  toggleFavorite(designId: string, on: boolean): Promise<{ starred: boolean }> {
    return this.request(on ? "POST" : "DELETE", `/v1/designs/${designId}/favorite`);
  }

  // --- designs ----------------------------------------------------
  createDesign(input: { workspaceId: string; title?: string; from?: DesignFile }): Promise<DesignRecord> {
    return this.request("POST", "/v1/designs", input);
  }
  getDesign(id: string): Promise<DesignRecord & { recovered?: boolean }> {
    return this.request("GET", `/v1/designs/${id}`);
  }
  renameDesign(id: string, title: string): Promise<DesignRecord> {
    return this.request("PATCH", `/v1/designs/${id}`, { title });
  }
  /** Fetch the design's current file. `trashed: true` lets workspace members
   *  read a design that sits in the trash (Trash-view preview thumbnails). */
  getDesignFile(id: string, opts?: { trashed?: boolean }): Promise<DesignFile> {
    return this.request("GET", `/v1/designs/${id}/file${opts?.trashed ? "?trashed=1" : ""}`);
  }
  saveSnapshot(id: string, input: { file: DesignFile; label?: string; kind?: SavableSnapshotKind }): Promise<DesignRecord> {
    return this.request("POST", `/v1/designs/${id}/snapshots`, input);
  }
  /** A page of a design's version history, newest first. Each
   *  entry carries its resolved author, kind, label, and timestamp. Pass the
   *  returned `nextCursor` to lazy-load older pages. */
  listVersions(id: string, cursor?: string): Promise<VersionPage> {
    return this.request("GET", `/v1/designs/${id}/versions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  }
  /** A historical version's DesignFile for READ-ONLY preview. Does
   *  not mutate the live design; the time machine loads it into the canvas under
   *  a preview banner. */
  versionFile(id: string, versionId: string): Promise<DesignFile> {
    return this.request("GET", `/v1/designs/${id}/versions/${versionId}/file`);
  }
  /** The append-only CRDT update log in ascending seq order (FR-9): the raw
   *  y-protocols frames the client folds into an ephemeral Y.Doc to scrub
   *  history. Pass the returned `nextSeq` as `afterSeq` to page forward.
   *  `branch` selects an in-CRDT branch's lineage (FR-10): the parent prefix up
   *  to the fork plus the branch's own rows, one ascending seq stream. */
  designUpdates(id: string, afterSeq?: number, limit?: number, branch?: string): Promise<DesignUpdatePage> {
    const q = new URLSearchParams();
    if (afterSeq) q.set("afterSeq", String(afterSeq));
    if (limit) q.set("limit", String(limit));
    if (branch) q.set("branch", branch);
    const qs = q.toString();
    return this.request("GET", `/v1/designs/${id}/updates${qs ? `?${qs}` : ""}`);
  }
  /** Journal a CRDT full-state checkpoint and compact the update log (FR-11):
   *  older rows are deleted server-side, so the log stays bounded. `update` is a
   *  base64 y-protocols update frame from the live Y.Doc (encodeStateAsUpdate).
   *  `branch` scopes the checkpoint (and its compaction) to that in-CRDT
   *  branch's own lineage. */
  checkpointDesign(id: string, update: string, branch?: string): Promise<void> {
    const qs = branch ? `?branch=${encodeURIComponent(branch)}` : "";
    return this.request("POST", `/v1/designs/${id}/updates/checkpoint${qs}`, { update });
  }
  /** The design's in-CRDT named branches (FR-10), oldest first. Distinct from
   *  {@link listBranches}, the fork model (new designs copied from a version). */
  listCrdtBranches(id: string): Promise<CrdtBranch[]> {
    return this.request("GET", `/v1/designs/${id}/crdt-branches`);
  }
  /** Fork a named in-CRDT branch at a history point (FR-10). `forkedFromSeq` is
   *  a seq of the parent lineage (0 = the empty beginning); `parentBranchId`
   *  nests a branch under another branch (default: the main lineage). Purely
   *  additive: existing history is never touched. */
  createCrdtBranch(id: string, input: { name: string; forkedFromSeq: number; parentBranchId?: string }): Promise<CrdtBranch> {
    return this.request("POST", `/v1/designs/${id}/crdt-branches`, input);
  }
  /** Restore a prior version as a NEW snapshot (kind 'restore'), making it the
   *  current state without discarding anything. Distinct from
   *  {@link restoreDesign}, which un-trashes a soft-deleted design. */
  restoreVersion(id: string, versionId: string): Promise<VersionEntry> {
    return this.request("POST", `/v1/designs/${id}/versions/${versionId}/restore`, {});
  }
  /** Create a new design branched from a history point.
   *  Returns the new design; the source is left untouched. */
  branchFromVersion(id: string, versionId: string, name?: string): Promise<DesignRecord> {
    return this.request("POST", `/v1/designs/${id}/versions/${versionId}/branch`, name ? { title: name } : {});
  }
  /** Designs branched off this design, for the branch switcher. */
  listBranches(id: string): Promise<BranchEntry[]> {
    return this.request("GET", `/v1/designs/${id}/branches`);
  }
  deleteDesign(id: string, purge = false): Promise<void> {
    return this.request("DELETE", `/v1/designs/${id}${purge ? "?purge=true" : ""}`);
  }
  restoreDesign(id: string): Promise<void> {
    return this.request("POST", `/v1/designs/${id}/restore`, {});
  }
  listTrash(workspaceId: string): Promise<DesignRecord[]> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/trash`);
  }

  // --- sharing + permissions --------------------------------------
  /** The caller's resolved access (mode + capabilities) to a design (FR-7). */
  designAccess(designId: string): Promise<DesignAccessView> {
    return this.request("GET", `/v1/designs/${designId}/access`);
  }
  /** The full Share dialog payload: the caller's access plus grants, links, and
   *  in-scope custom roles (FR-5). */
  designSharing(designId: string): Promise<DesignSharingView> {
    return this.request("GET", `/v1/designs/${designId}/sharing`);
  }
  /** Grant a member (by user id) or invitee (by email) access at a mode (FR-5). */
  addGrant(designId: string, input: { principal: { kind: "user" | "email"; id: string }; mode: AccessMode; roleId?: string }): Promise<ShareGrant> {
    return this.request("POST", `/v1/designs/${designId}/grants`, input);
  }
  updateGrant(grantId: string, patch: { mode?: AccessMode; roleId?: string | null }): Promise<ShareGrant> {
    return this.request("PATCH", `/v1/grants/${grantId}`, patch);
  }
  removeGrant(grantId: string): Promise<void> {
    return this.request("DELETE", `/v1/grants/${grantId}`);
  }
  /** Create a share link at an access mode, optionally password-protected and/or
   *  expiring (FR-5, FR-6). */
  createShareLink(designId: string, input: { mode: AccessMode; password?: string; expiresAt?: string; requireSignin?: boolean; label?: string }): Promise<ShareLinkView> {
    return this.request("POST", `/v1/designs/${designId}/links`, input);
  }
  updateShareLink(linkId: string, patch: { mode?: AccessMode; disabled?: boolean; expiresAt?: string | null; requireSignin?: boolean; label?: string }): Promise<ShareLinkView> {
    return this.request("PATCH", `/v1/links/${linkId}`, patch);
  }
  /** Rotate a link's token: the old URL stops working (FR-6). */
  rotateShareLink(linkId: string): Promise<ShareLinkView> {
    return this.request("POST", `/v1/links/${linkId}/rotate`, {});
  }
  /** Permanently delete a share link; its URL stops resolving (FR-6). */
  deleteShareLink(linkId: string): Promise<void> {
    return this.request("DELETE", `/v1/links/${linkId}`);
  }
  /** PUBLIC: resolve a share link by token (FR-6, FR-15). No account needed for a
   *  view/comment link. Throws ApiError 404 (missing/disabled), 410 (expired), or
   *  403 (wrong password / sign-in required). */
  resolveShareLink(token: string, password?: string): Promise<ResolvedLink> {
    return this.request("POST", `/v1/links/${encodeURIComponent(token)}/resolve`, password ? { password } : {});
  }
  /** PUBLIC: resolve a link and fetch the design file for a read-only open
   *  (FR-15). Backs anonymous view/comment landing. Same denial semantics as
   *  resolveShareLink. */
  resolveShareLinkFile(token: string, password?: string): Promise<ResolvedLink & { file: DesignFile }> {
    return this.request("POST", `/v1/links/${encodeURIComponent(token)}/file`, password ? { password } : {});
  }
  /** List the workspace's custom roles (requires manage-roles, FR-8). */
  listCustomRoles(workspaceId: string): Promise<CustomRoleView[]> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/roles`);
  }
  createCustomRole(workspaceId: string, input: { name: string; capabilities: Capability[]; designId?: string }): Promise<CustomRoleView> {
    return this.request("POST", `/v1/workspaces/${workspaceId}/roles`, input);
  }
  updateCustomRole(roleId: string, patch: { name?: string; capabilities?: Capability[] }): Promise<CustomRoleView> {
    return this.request("PATCH", `/v1/roles/${roleId}`, patch);
  }
  deleteCustomRole(roleId: string): Promise<void> {
    return this.request("DELETE", `/v1/roles/${roleId}`);
  }
  /** Assign a custom role to a member on a design at a mode floor (FR-8). */
  assignCustomRole(designId: string, input: { targetUserId: string; roleId: string; mode?: AccessMode }): Promise<ShareGrant> {
    return this.request("POST", `/v1/designs/${designId}/role-assignments`, input);
  }
  /** Request access to a design the caller cannot open; notifies its
   *  owners/admins. Throws ApiError 400 if the caller already has that access. */
  requestAccess(designId: string, input: { mode?: AccessMode; message?: string } = {}): Promise<AccessRequestView> {
    return this.request("POST", `/v1/designs/${designId}/access-requests`, input);
  }
  /** List pending access requests for a design (requires the `share` capability). */
  listAccessRequests(designId: string): Promise<AccessRequestView[]> {
    return this.request("GET", `/v1/designs/${designId}/access-requests`);
  }
  /** Approve a pending access request, creating a grant (optionally at a chosen mode). */
  approveAccessRequest(requestId: string, mode?: AccessMode): Promise<AccessRequestView> {
    return this.request("POST", `/v1/access-requests/${requestId}/approve`, mode ? { mode } : {});
  }
  /** Deny a pending access request. */
  denyAccessRequest(requestId: string): Promise<AccessRequestView> {
    return this.request("POST", `/v1/access-requests/${requestId}/deny`, {});
  }

  // --- comments + tasks -----------------------------------
  /** Comment threads for a design (roots with replies, reactions, task info).
   *  Requires the `view` capability; filter narrows open/resolved/mine/assigned. */
  listComments(designId: string, filter: CommentFilter = "all"): Promise<CommentThread[]> {
    return this.request("GET", `/v1/designs/${designId}/comments?filter=${filter}`);
  }
  /** People who can be @mentioned or assigned on a design (FR-3, FR-4). */
  mentionablePeople(designId: string): Promise<MentionablePerson[]> {
    return this.request("GET", `/v1/designs/${designId}/mentionable`);
  }
  /** Create a comment at an anchor, optionally @mentioning people (FR-1, FR-3).
   *  Requires the `comment` capability (a view/comment user can comment). */
  createComment(designId: string, input: { anchor: CommentAnchor; body: string; mentions?: string[] }): Promise<Comment> {
    return this.request("POST", `/v1/designs/${designId}/comments`, input);
  }
  /** Reply to a thread root (FR-2). */
  replyComment(commentId: string, input: { body: string; mentions?: string[] }): Promise<Comment> {
    return this.request("POST", `/v1/comments/${commentId}/replies`, input);
  }
  /** Edit a comment's body (author or admin override, FR-2). */
  editComment(commentId: string, input: { body: string; mentions?: string[] }): Promise<Comment> {
    return this.request("PATCH", `/v1/comments/${commentId}`, input);
  }
  /** Resolve or reopen a thread (FR-2). */
  resolveComment(commentId: string, resolved: boolean): Promise<Comment> {
    return this.request("POST", `/v1/comments/${commentId}/resolve`, { resolved });
  }
  /** Delete a comment (author or `delete` capability, FR-2). */
  deleteComment(commentId: string): Promise<void> {
    return this.request("DELETE", `/v1/comments/${commentId}`);
  }
  /** Toggle an emoji reaction for the current user on a comment (FR-2). */
  reactComment(commentId: string, emoji: string): Promise<Comment> {
    return this.request("POST", `/v1/comments/${commentId}/reactions`, { emoji });
  }
  /** Convert a comment to a task or update its task fields (FR-4). Pass status
   *  null with no assignee to clear the task. */
  setCommentTask(commentId: string, input: { assigneeId?: string | null; status?: TaskStatus | null; dueAt?: string | null }): Promise<Comment> {
    return this.request("PUT", `/v1/comments/${commentId}/task`, input);
  }
  /** Tasks assigned to the current user across their designs (FR-4). */
  myTasks(status?: TaskStatus): Promise<MyTask[]> {
    return this.request("GET", `/v1/me/tasks${status ? `?status=${status}` : ""}`);
  }
  /** Comments that @mention the current user across their designs (FR-3). */
  myMentions(): Promise<MyTask[]> {
    return this.request("GET", "/v1/me/mentions");
  }

  // --- approval workflows ---------------------------------
  /** The design's current approval state + the caller's allowed actions (FR-10,
   *  FR-11). `locked` reflects whether the design is approval-locked. */
  designApproval(designId: string): Promise<DesignApprovalView> {
    return this.request("GET", `/v1/designs/${designId}/approval`);
  }
  /** Request approval from one or more approvers under an any/all policy (FR-10).
   *  Requires the `share` or `edit` capability; rejects if one is already active. */
  requestApproval(designId: string, input: { approverIds: string[]; policy: ApprovalPolicy }): Promise<DesignApprovalView> {
    return this.request("POST", `/v1/designs/${designId}/approvals`, input);
  }
  /** Record this approver's decision (FR-10). On grant the design locks (FR-11).
   *  Requires the `approve` capability and being a selected approver. */
  decideApproval(approvalId: string, input: { decision: ApprovalDecisionKind; note?: string }): Promise<DesignApprovalView> {
    return this.request("POST", `/v1/approvals/${approvalId}/decide`, input);
  }
  /** Reopen an approved+locked design (FR-11): clears the lock, restores edit.
   *  By owner/admin or a selected approver. */
  reopenApproval(approvalId: string): Promise<DesignApprovalView> {
    return this.request("POST", `/v1/approvals/${approvalId}/reopen`, {});
  }

  // --- whiteboard server-authoritative voting (F30 FR-19/FR-20) -------------
  /** Open a dot-vote round on a board (facilitator/edit only). */
  openVoteSession(designId: string, input: { budgetPerUser: number; anonymous: boolean }): Promise<WhiteboardVoteSession> {
    return this.request("POST", `/v1/designs/${designId}/whiteboard/sessions`, input);
  }
  /** Close/reopen and/or reveal a vote session (facilitator/edit only). */
  setVoteSessionState(designId: string, sessionId: string, input: { open: boolean; revealed: boolean }): Promise<WhiteboardVoteSession> {
    return this.request("POST", `/v1/designs/${designId}/whiteboard/sessions/${sessionId}/state`, input);
  }
  /** Current standings for a session (view level; anonymity/reveal enforced server-side). */
  getVoteTally(designId: string, sessionId: string): Promise<WhiteboardVoteTally> {
    return this.request("GET", `/v1/designs/${designId}/whiteboard/sessions/${sessionId}`);
  }
  /** Toggle the caller's dot-vote on a node (comment level). 409 when closed or
   *  over budget. Returns the refreshed tally for the caller. */
  castVote(designId: string, input: { sessionId: string; nodeId: string }): Promise<WhiteboardVoteTally> {
    return this.request("POST", `/v1/designs/${designId}/whiteboard/votes`, input);
  }

  // --- activity log --------------------------------
  /** The merged, newest-first activity feed for a design (edits folded in from
   *  version history). `type` narrows to one activity type; `cursor` pages. */
  designActivity(designId: string, opts: { type?: ActivityType; cursor?: string } = {}): Promise<ActivityPage> {
    const params = new URLSearchParams();
    if (opts.type) params.set("type", opts.type);
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return this.request("GET", `/v1/designs/${designId}/activity${qs ? `?${qs}` : ""}`);
  }

  // --- notifications center ------------------------
  /** The caller's notifications, newest-first, paginated. */
  notifications(opts: { unread?: boolean; cursor?: string } = {}): Promise<NotificationPage> {
    const params = new URLSearchParams();
    if (opts.unread) params.set("unread", "true");
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return this.request("GET", `/v1/notifications${qs ? `?${qs}` : ""}`);
  }
  /** The caller's unread notification count (for the bell badge). */
  unreadNotificationCount(): Promise<{ count: number }> {
    return this.request("GET", "/v1/notifications/unread-count");
  }
  markNotificationRead(id: string): Promise<void> {
    return this.request("POST", `/v1/notifications/${id}/read`, {});
  }
  markAllNotificationsRead(): Promise<void> {
    return this.request("POST", "/v1/notifications/read-all", {});
  }
  /** The caller's notification channel preferences: email + web push (FR-13). */
  notificationPrefs(): Promise<NotificationPrefView> {
    return this.request("GET", "/v1/me/notification-prefs");
  }
  /** Update the email and/or web-push notification type sets (FR-13). Pass only
   *  the channel(s) you are changing; an omitted channel is left untouched. The
   *  back-compat string-array overload updates the email channel. */
  setNotificationPrefs(
    input: NotificationType[] | { emailTypes?: NotificationType[]; pushTypes?: NotificationType[] },
  ): Promise<NotificationPrefView> {
    const body = Array.isArray(input) ? { emailTypes: input } : input;
    return this.request("PUT", "/v1/me/notification-prefs", body);
  }

  // --- web push ---------------------------------------------
  /** The public VAPID key to subscribe with, or null when web push is not
   *  configured server-side (the device toggle is hidden then). */
  pushVapidPublicKey(): Promise<{ key: string | null }> {
    return this.request("GET", "/v1/push/vapid-public-key");
  }
  /** Register this device's browser push subscription for the current user. */
  pushSubscribe(input: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
    return this.request("POST", "/v1/push/subscribe", input);
  }
  /** Remove a device's push subscription by endpoint. */
  pushUnsubscribe(endpoint: string): Promise<void> {
    return this.request("POST", "/v1/push/unsubscribe", { endpoint });
  }

  // --- engagement insights -------------------------
  /** Record a view-session heartbeat for an authenticated viewer (FR-14). */
  viewBeat(designId: string, input: { sessionId: string; pageId?: string | null; ms: number }): Promise<void> {
    return this.request("POST", `/v1/designs/${designId}/view-beat`, input);
  }
  /** PUBLIC: record an anonymous (share-link) view-session heartbeat (FR-14,
   *  FR-15). Validated by the link token; no account needed. */
  sharedViewBeat(token: string, input: { anonId: string; sessionId: string; pageId?: string | null; ms: number; password?: string }): Promise<void> {
    return this.request("POST", `/v1/shared/${encodeURIComponent(token)}/view-beat`, input);
  }
  /** Aggregated engagement insights for a design (FR-14), member/owner only. */
  designInsights(designId: string): Promise<DesignInsights> {
    return this.request("GET", `/v1/designs/${designId}/insights`);
  }

  // --- templates --------------------------------------------------
  /** List templates. Accepts a keyword string (back-compat) or a filter. */
  listTemplates(filter?: string | TemplateListFilter): Promise<TemplateSummary[]> {
    const f: TemplateListFilter = typeof filter === "string" ? { q: filter } : filter ?? {};
    const params = new URLSearchParams();
    if (f.q) params.set("q", f.q);
    if (f.category) params.set("category", f.category);
    if (f.collection) params.set("collection", f.collection);
    if (f.workspaceId) params.set("workspaceId", f.workspaceId);
    const qs = params.toString();
    return this.request("GET", `/v1/templates${qs ? `?${qs}` : ""}`);
  }
  getTemplateFile(id: string): Promise<DesignFile> {
    return this.request("GET", `/v1/templates/${id}/file`);
  }
  /** A template's declared fillable fields, for the bulk-create mapping UI. */
  templateFillableFields(id: string): Promise<FillableFieldSummary[]> {
    return this.request("GET", `/v1/templates/${id}/fillable-fields`);
  }
  /** A design's declared fillable fields. */
  designFillableFields(id: string): Promise<FillableFieldSummary[]> {
    return this.request("GET", `/v1/designs/${id}/fillable-fields`);
  }
  /** Data merge / bulk create: one design per dataset row from a template or
   *  base design. Synchronous + batched; the result reports the
   *  created designs, a truncated flag (when the dataset exceeded the cap), and
   *  any rows skipped for failing field validation. */
  bulkCreate(input: BulkCreateInput): Promise<BulkCreateResult> {
    return this.request("POST", "/v1/designs/bulk-create", input);
  }
  /** Poll a background job (export, video render, bulk create, ...) by id. Only
   *  visible to the user that enqueued it (job-status contract). */
  getJob<R = unknown>(jobId: string): Promise<JobStatusView<R>> {
    return this.request("GET", `/v1/jobs/${jobId}`);
  }
  /** Enqueue an MP4 render of a design's video timeline. Poll the
   *  returned jobId via getJob, then download from videoExportDownloadUrl. */
  /** Start a server video export. For video documents this renders the full
   *  timeline (ffmpeg); opts tune the output (scale multiplier, x264 CRF). */
  startVideoExport(
    designId: string,
    opts: {
      scale?: number;
      crf?: number;
      startFrame?: number;
      endFrame?: number;
      format?: "mp4" | "webm" | "gif" | "mp3";
      /** Output frame rate override (frames duplicate/drop; timing holds). */
      fps?: number;
      skipCaptions?: boolean;
      /** Render only this track's audio (pre-master stem), mp3 format. */
      stemTrackId?: string;
      /** Render THIS file's timeline instead of the design's stored one (doc 28
       *  FR-19 deck-to-video: the client converts the deck to a video project on
       *  the fly and nothing is persisted). Same workspace asset scope. */
      file?: DesignFile;
    } = {},
  ): Promise<{ jobId: string }> {
    return this.request("POST", `/v1/designs/${designId}/export/video`, opts);
  }
  /** The authenticated download URL for a completed video export (cookie auth). */
  videoExportDownloadUrl(designId: string, jobId: string): string {
    return `${this.baseUrl}/v1/designs/${encodeURIComponent(designId)}/export/video/${encodeURIComponent(jobId)}/download`;
  }
  /** Enqueue a DOCX or PDF render of a doc design. Poll via getJob,
   *  then download from docExportDownloadUrl. */
  startDocExport(designId: string, format: "docx" | "pdf"): Promise<{ jobId: string }> {
    return this.request("POST", `/v1/designs/${designId}/export/doc`, { format });
  }
  /** The authenticated download URL for a completed doc export (cookie auth). */
  docExportDownloadUrl(designId: string, jobId: string): string {
    return `${this.baseUrl}/v1/designs/${encodeURIComponent(designId)}/export/doc/${encodeURIComponent(jobId)}/download`;
  }
  /** The authenticated URL for an accessibility-tagged PDF of the whole deck,
   *  rendered by the Go encoder (doc 28 FR-22). It serves the design as last
   *  saved, and its text is real text: selectable, searchable, and readable by
   *  assistive technology in the author's reading order. */
  taggedPdfUrl(designId: string): string {
    return `${this.baseUrl}/v1/designs/${encodeURIComponent(designId)}/render.pdf?page=all`;
  }
  /** Convert a whiteboard design into a presentation deck. Poll via
   *  getJob; the result carries the new design id to open. */
  convertWhiteboardToDeck(designId: string): Promise<{ jobId: string }> {
    return this.request("POST", `/v1/designs/${designId}/convert/whiteboard-to-deck`);
  }
  /** Autofill a single existing design from one row of values. */
  autofillDesign(id: string, values: FillRowValues): Promise<{ designId: string }> {
    return this.request("POST", `/v1/designs/${id}/autofill`, { values });
  }
  applyTemplate(id: string, workspaceId: string): Promise<{ designId: string }> {
    return this.request("POST", `/v1/templates/${id}/apply`, { workspaceId });
  }
  /** Save the current design (by id or inline file) as a template (FR-9). */
  saveAsTemplate(input: SaveAsTemplateInput): Promise<TemplateSummary> {
    return this.request("POST", "/v1/templates", input);
  }
  assignTemplateCollection(id: string, collectionId: string | null): Promise<TemplateSummary> {
    return this.request("POST", `/v1/templates/${id}/collection`, { collectionId });
  }
  // Collections.
  listTemplateCollections(workspaceId: string): Promise<TemplateCollectionSummary[]> {
    return this.request("GET", `/v1/templates/collections?workspaceId=${encodeURIComponent(workspaceId)}`);
  }
  createTemplateCollection(workspaceId: string, name: string): Promise<TemplateCollectionSummary> {
    return this.request("POST", "/v1/templates/collections", { workspaceId, name });
  }
  deleteTemplateCollection(id: string): Promise<void> {
    return this.request("DELETE", `/v1/templates/collections/${id}`);
  }

  // --- stock catalog ----------------------------------------------
  stockSearch(
    q?: string,
    kind?: string,
    opts: { category?: string; style?: string; orientation?: string; collection?: string; limit?: number; offset?: number } = {},
  ): Promise<StockAssetSummary[]> {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (kind) params.set("kind", kind);
    if (opts.category) params.set("category", opts.category);
    if (opts.style) params.set("style", opts.style);
    if (opts.orientation) params.set("orientation", opts.orientation);
    if (opts.collection) params.set("collection", opts.collection);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.request("GET", `/v1/stock/search${qs ? `?${qs}` : ""}`);
  }
  /** The curated stock collections. */
  stockCollections(): Promise<StockCollectionSummary[]> {
    return this.request("GET", "/v1/stock/collections");
  }
  /** The catalog's filterable facets (categories, styles, orientations) per kind. */
  stockFilters(): Promise<StockFiltersSummary> {
    return this.request("GET", "/v1/stock/filters");
  }
  /** The current user's favorited stock assets (newest first). */
  stockFavorites(): Promise<StockAssetSummary[]> {
    return this.request("GET", "/v1/stock/favorites");
  }
  /** Toggle the current user's favorite on a stock asset; returns the new state. */
  toggleStockFavorite(stockId: string): Promise<{ favorited: boolean }> {
    return this.request("POST", `/v1/stock/favorites/${stockId}`);
  }
  /** The current user's recently-used stock assets (most recent first). */
  stockRecent(): Promise<StockAssetSummary[]> {
    return this.request("GET", "/v1/stock/recent");
  }
  /** Record a stock asset as recently used (called when it is placed). 204, no body. */
  recordStockRecent(stockId: string): Promise<void> {
    return this.request("POST", `/v1/stock/recent/${stockId}`);
  }
  /** The built-in mini apps + their granted scopes. */
  listApps(): Promise<MiniAppSummary[]> {
    return this.request("GET", "/v1/apps");
  }

  // --- AI (bring-your-own key) -------------------------------------
  /** The server's provider preset catalog (ids, labels, defaults,
   *  capabilities); drives the config UI so the client never hardcodes it. */
  aiProviders(): Promise<AiProviderPreset[]> {
    return this.request("GET", "/v1/ai/providers");
  }
  getAiConfig(workspaceId: string): Promise<AiConfigView | null> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/ai-config`);
  }
  /** Upsert the workspace AI provider config. `baseUrl` uses PATCH semantics:
   *  omitted preserves the stored URL (the server clears it itself on a
   *  provider change), an empty string clears it explicitly. Changing the
   *  provider while a key is stored requires `apiKey` for the new provider
   *  (400 `ai_key_required_for_provider_change` otherwise). */
  setAiConfig(workspaceId: string, input: { provider: string; model?: string; imageModel?: string; baseUrl?: string; apiKey?: string }): Promise<AiConfigView> {
    return this.request("PUT", `/v1/workspaces/${workspaceId}/ai-config`, input);
  }
  getAiPolicy(workspaceId: string): Promise<AiPolicy> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/ai-policy`);
  }
  setAiPolicy(workspaceId: string, input: AiPolicy): Promise<AiPolicy> {
    return this.request("PUT", `/v1/workspaces/${workspaceId}/ai-policy`, input);
  }
  getAiUsage(workspaceId: string): Promise<{ tokensThisMonth: number }> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/ai-usage`);
  }
  // --- live audience (doc 28): share-link viewers <-> presenter -------------
  /** Audience state (visible questions + polls), personalized by voterKey.
   *  POST so a link password never rides a URL. */
  audienceState(token: string, input: { voterKey: string; password?: string }): Promise<AudienceState> {
    return this.request("POST", `/v1/links/${encodeURIComponent(token)}/audience/state`, input);
  }
  audienceAsk(token: string, input: { name?: string; text: string; password?: string }): Promise<AudienceQuestion> {
    return this.request("POST", `/v1/links/${encodeURIComponent(token)}/audience/questions`, input);
  }
  audienceVoteQuestion(token: string, questionId: string, input: { voterKey: string; password?: string }): Promise<void> {
    return this.request("POST", `/v1/links/${encodeURIComponent(token)}/audience/questions/${encodeURIComponent(questionId)}/vote`, input);
  }
  audienceVotePoll(token: string, pollId: string, input: { voterKey: string; option: number; password?: string }): Promise<void> {
    return this.request("POST", `/v1/links/${encodeURIComponent(token)}/audience/polls/${encodeURIComponent(pollId)}/vote`, input);
  }
  audienceReact(token: string, input: { emoji: string; password?: string }): Promise<void> {
    return this.request("POST", `/v1/links/${encodeURIComponent(token)}/audience/react`, input);
  }
  /** Phone remote (F28 C21): relay a control action to the presenter, tagged
   *  with the pairing code the presenter verifies locally. */
  audienceRemote(token: string, input: { code: string; action: "next" | "prev" | "blank"; password?: string }): Promise<void> {
    return this.request("POST", `/v1/links/${encodeURIComponent(token)}/audience/remote`, input);
  }
  /** Presenter: full audience state incl. dismissed questions. */
  presenterAudienceState(designId: string): Promise<AudienceState> {
    return this.request("GET", `/v1/designs/${designId}/audience/state`);
  }
  presenterModerateQuestion(designId: string, questionId: string, input: { answered?: boolean; dismissed?: boolean }): Promise<void> {
    return this.request("POST", `/v1/designs/${designId}/audience/questions/${encodeURIComponent(questionId)}/moderate`, input);
  }
  presenterCreatePoll(designId: string, input: { question: string; options: string[] }): Promise<AudiencePoll> {
    return this.request("POST", `/v1/designs/${designId}/audience/polls`, input);
  }
  presenterSetPollOpen(designId: string, pollId: string, open: boolean): Promise<void> {
    return this.request("POST", `/v1/designs/${designId}/audience/polls/${encodeURIComponent(pollId)}/open`, { open });
  }
  presenterClearAudience(designId: string): Promise<void> {
    return this.request("POST", `/v1/designs/${designId}/audience/clear`, {});
  }
  /** Presenter: publish the current slide for audience slide-follow (-1 ends). */
  presenterSetLiveSlide(designId: string, slide: number): Promise<void> {
    return this.request("POST", `/v1/designs/${designId}/audience/live`, { slide });
  }
  /** Server-side data-source proxy (doc 28 / F27 live bindings): fetches a
   *  remote CSV/TSV/JSON URL past CORS, behind the same SSRF gate. */
  dataFetch(input: { url: string }): Promise<{ text: string }> {
    return this.request("POST", "/v1/data/fetch", input);
  }
  /** Server-side URL-to-text extraction (doc 28 FR-23): fetches a public web
   *  page (SSRF-guarded) and returns its readable text for deck grounding. */
  aiExtractUrl(input: { url: string }): Promise<{ title: string; text: string }> {
    return this.request("POST", "/v1/ai/extract-url", input);
  }
  /** Extract text from an office document (.docx/.pptx/.xlsx) for generation
   *  grounding: paragraphs, slide texts in deck order, or tab-separated sheet
   *  rows. Nothing is stored server-side. */
  aiExtractFile(input: { filename: string; mimeType?: string; dataBase64: string }): Promise<{ name: string; text: string }> {
    return this.request("POST", "/v1/ai/extract-file", input);
  }
  /** Draft a brand kit from a company web page (F28 T21): candidate logo URLs,
   *  3..6 palette colors, and font guesses, scanned behind the SSRF gate. A
   *  DRAFT only - the caller confirms before anything is saved. */
  aiBrandFromUrl(input: { workspaceId: string; url: string }): Promise<{ name: string; logoUrls: string[]; colors: string[]; fonts: string[] }> {
    return this.request("POST", "/v1/ai/brand-from-url", input);
  }
  /** The workspace's web-search provider config, or null when unset. */
  getSearchConfig(workspaceId: string): Promise<{ provider: string; baseUrl: string | null; hasKey: boolean } | null> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/search-config`);
  }
  /** Set (or clear, with provider "") the workspace's web-search provider.
   *  baseUrl uses PATCH semantics like setAiConfig. */
  setSearchConfig(workspaceId: string, input: { provider: string; baseUrl?: string; apiKey?: string }): Promise<{ provider: string; baseUrl: string | null; hasKey: boolean } | null> {
    return this.request("PUT", `/v1/workspaces/${workspaceId}/search-config`, input);
  }
  /** Streaming design generation (SSE): onEvent receives ("outline", outline)
   *  as soon as the outline validates, ("page", {index, points}) per polished
   *  page, ("done", outline) at the end, and ("error", {code,message}) on a
   *  provider failure. Resolves when the stream closes; rejects on transport
   *  failure (callers fall back to the job-based endpoint). */
  async aiGenerateDesignStream(
    input: { workspaceId: string; designType: string; prompt: string; brandClause?: string; pageCount?: number },
    onEvent: (event: string, data: unknown) => void,
    opts?: { signal?: AbortSignal },
    retried = false,
  ): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/ai/generate-design/stream`, {
      method: "POST",
      headers,
      credentials: this.credentials,
      body: JSON.stringify(input),
      // Aborting cancels the server run too: the request context propagates
      // into every model call, so an early-resolved caller stops paying for
      // polish passes it will discard.
      signal: opts?.signal,
    });
    // Same transparent one-shot refresh as request(): an expired access token
    // mid-session must not fail a generation the JSON path would survive.
    if (res.status === 401 && !retried) {
      if (await this.tryRefresh()) return this.aiGenerateDesignStream(input, onEvent, opts, true);
    }
    if (!res.ok || !res.body) throw new ApiError(res.status, "/v1/ai/generate-design/stream", await res.json().catch(() => null));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; parse complete frames only.
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        try {
          onEvent(event, JSON.parse(data));
        } catch {
          // a malformed frame is skipped; the stream continues
        }
      }
    }
  }
  /** Web search for generation grounding: the server writes ONE query from the
   *  brief and executes it. Results are UNTRUSTED reference material. */
  aiSearch(input: { workspaceId: string; prompt: string; maxResults?: number }): Promise<{ query: string; results: { title: string; url: string; content: string }[] }> {
    return this.request("POST", "/v1/ai/search", input);
  }
  aiText(input: { workspaceId: string; prompt: string; system?: string }): Promise<{ text: string }> {
    return this.request("POST", "/v1/ai/text", input);
  }
  /** Schema-constrained text generation: the provider is asked for natively
   *  schema-valid output (falling back to plain text where unsupported). The
   *  reply is still free text - callers keep validating. */
  aiTextStructured(input: { workspaceId: string; prompt: string; system?: string; schema: Record<string, unknown> }): Promise<{ text: string }> {
    return this.request("POST", "/v1/ai/text-structured", input);
  }
  aiImage(input: { workspaceId: string; prompt: string; size?: string }): Promise<{ image: string }> {
    return this.request("POST", "/v1/ai/image", input);
  }
  /** Describe an image in words for accessibility alt text (F22 FR-12).
   *  `imageBase64` is a base64 PNG/JPEG (a leading data: prefix is allowed).
   *  Needs a vision-capable model; throws ApiError 502 otherwise. */
  aiDescribeImage(input: { workspaceId: string; imageBase64: string; instruction?: string }): Promise<{ text: string }> {
    return this.request("POST", "/v1/ai/describe-image", input);
  }
  /** Edit an image by prompt, or outpaint it (Magic Expand) when `maskBase64` is
   *  supplied. `imageBase64`/`maskBase64` are base64 PNGs (a leading data: prefix
   *  is allowed). Returns the result image as a data URL (or remote URL). */
  aiEditImage(input: { workspaceId: string; imageBase64: string; prompt: string; maskBase64?: string; size?: string }): Promise<{ image: string }> {
    return this.request("POST", "/v1/ai/image/edit", input);
  }

  // --- AI Creative Studio (F39): server-side orchestration -----------
  // These call the AI proxy server-side with schema validation + retry, so the
  // client gets clean, typed objects (FR-12). The deterministic layout still
  // happens client-side from the returned outline/specs.

  /** Generate + validate a multi-page design outline (FR-2). */
  aiOutline(input: { workspaceId: string; designType: AiStudioDesignType; prompt: string; brandClause?: string; pageCount?: number }): Promise<AiDesignOutline> {
    return this.request("POST", "/v1/ai/outline", input);
  }
  /** Generate a polished design as a job (outline + per-page copy). Poll getJob;
   *  the result is an AiDesignOutline to lay out (FR-1/FR-25). */
  aiGenerateDesign(input: { workspaceId: string; designType: AiStudioDesignType; prompt: string; brandClause?: string; pageCount?: number }): Promise<{ jobId: string }> {
    return this.request("POST", "/v1/ai/generate-design", input);
  }
  /** Generate N distinct outline options as a job (FR-4). Result: {variations}. */
  aiVariations(input: { workspaceId: string; designType: AiStudioDesignType; prompt: string; brandClause?: string; count?: number }): Promise<{ jobId: string }> {
    return this.request("POST", "/v1/ai/variations", input);
  }
  /** Validate a chart spec from a data description (FR-21). */
  aiChart(input: { workspaceId: string; description: string }): Promise<AiChartSpec> {
    return this.request("POST", "/v1/ai/chart", input);
  }
  /** Run one agentic assistant turn: a validated plan or a clarifying question
   *  (FR-6/7/10). The client executes the plan and re-validates arg types. */
  aiAssistant(input: { workspaceId: string; designSummary: string; history?: string; message: string }): Promise<AiAssistantReply> {
    return this.request("POST", "/v1/ai/assistant", input);
  }
  /** Extract a style profile from a reference for style transfer (FR-18). */
  aiStyleProfile(input: { workspaceId: string; referenceText?: string; seedPalette?: string[] }): Promise<AiStyleProfile> {
    return this.request("POST", "/v1/ai/style-profile", input);
  }
  /** AI design-critique suggestions for a posted design summary (FR-15). */
  aiCritique(input: { workspaceId: string; designSummary: string }): Promise<{ suggestions: string }> {
    return this.request("POST", "/v1/ai/critique", input);
  }
  /** Generate a complete design as a single editable SVG document at the target
   *  size. Works with text-only providers (e.g. DeepSeek): the model draws the
   *  design with vector primitives, and the client flattens the SVG to scene
   *  nodes so the result stays fully editable (no rasterization). */
  aiDesignSvg(input: { workspaceId: string; designType: string; prompt: string; width?: number; height?: number }): Promise<{ title: string; width: number; height: number; svg: string }> {
    return this.request("POST", "/v1/ai/design-svg", input);
  }
  // Session history (FR-9 / FR-27).
  listAiSessions(designId: string): Promise<{ sessions: AiSessionView[] }> {
    return this.request("GET", `/v1/designs/${designId}/ai-sessions`);
  }
  createAiSession(designId: string): Promise<AiSessionView> {
    return this.request("POST", `/v1/designs/${designId}/ai-sessions`);
  }
  listAiTurns(designId: string, sessionId: string): Promise<{ turns: AiTurnView[] }> {
    return this.request("GET", `/v1/designs/${designId}/ai-sessions/${sessionId}/turns`);
  }
  appendAiTurn(designId: string, sessionId: string, turn: { role: "user" | "assistant"; text: string; plan?: unknown; provenance?: unknown }): Promise<AiTurnView> {
    return this.request("POST", `/v1/designs/${designId}/ai-sessions/${sessionId}/turns`, turn);
  }

  // --- uploads + asset organization -------------------------------
  listAssets(workspaceId: string, filter: AssetListFilter = {}): Promise<UploadedAsset[]> {
    const params = new URLSearchParams();
    if (filter.folderId !== undefined) params.set("folderId", filter.folderId ?? "root");
    if (filter.tag) params.set("tag", filter.tag);
    if (filter.q) params.set("q", filter.q);
    const qs = params.toString();
    return this.request("GET", `/v1/workspaces/${workspaceId}/assets${qs ? `?${qs}` : ""}`);
  }
  uploadAsset(workspaceId: string, input: { filename: string; dataBase64: string; folderId?: string | null; thumbnail?: string }): Promise<UploadedAsset> {
    return this.request("POST", `/v1/workspaces/${workspaceId}/assets`, input);
  }
  /**
   * Import an image from a remote URL. The server validates the host (SSRF) and
   * re-checks the resolved IP (anti-DNS-rebinding) before fetching, then stores
   * it as an asset. Returns the created asset.
   */
  importAssetFromUrl(workspaceId: string, url: string, folderId?: string | null): Promise<UploadedAsset> {
    return this.request("POST", `/v1/workspaces/${workspaceId}/assets/from-url`, { url, folderId });
  }
  /** Rename, move-to-folder, and/or set tags on an asset. */
  updateAsset(id: string, patch: { filename?: string; folderId?: string | null; tags?: string[] }): Promise<UploadedAsset> {
    return this.request("PATCH", `/v1/assets/${id}`, patch);
  }
  deleteAsset(id: string): Promise<void> {
    return this.request("DELETE", `/v1/assets/${id}`);
  }
  /** Current storage usage + cap for the workspace (FR-11). */
  assetUsage(workspaceId: string): Promise<StorageUsageView> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/assets/usage`);
  }

  // Asset folders.
  listAssetFolders(workspaceId: string): Promise<AssetFolder[]> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/asset-folders`);
  }
  createAssetFolder(workspaceId: string, input: { name: string; parentId?: string | null }): Promise<AssetFolder> {
    return this.request("POST", `/v1/workspaces/${workspaceId}/asset-folders`, input);
  }
  renameAssetFolder(id: string, name: string): Promise<AssetFolder> {
    return this.request("PATCH", `/v1/asset-folders/${id}`, { name });
  }
  deleteAssetFolder(id: string): Promise<void> {
    return this.request("DELETE", `/v1/asset-folders/${id}`);
  }

  // --- brand kits + controls --------------------------------------
  /** The workspace's brand kits, default first (FR-1). Membership-gated. */
  listBrandKits(workspaceId: string): Promise<BrandKit[]> {
    return this.request("GET", `/v1/workspaces/${workspaceId}/brand-kits`);
  }
  /** Create a brand kit (FR-1); needs manage-brand. First kit becomes default. */
  createBrandKit(workspaceId: string, input: { name?: string; isDefault?: boolean } = {}): Promise<BrandKit> {
    return this.request("POST", `/v1/workspaces/${workspaceId}/brand-kits`, input);
  }
  getBrandKit(kitId: string): Promise<BrandKit> {
    return this.request("GET", `/v1/brand-kits/${kitId}`);
  }
  /** Update a kit's metadata, contents, and controls (FR-1, FR-4, FR-5);
   *  needs manage-brand. */
  updateBrandKit(kitId: string, patch: BrandKitPatch): Promise<BrandKit> {
    return this.request("PATCH", `/v1/brand-kits/${kitId}`, patch);
  }
  deleteBrandKit(kitId: string): Promise<void> {
    return this.request("DELETE", `/v1/brand-kits/${kitId}`);
  }
  /** Set a kit as the workspace default (FR-2); needs manage-brand. */
  setDefaultBrandKit(kitId: string): Promise<BrandKit> {
    return this.request("POST", `/v1/brand-kits/${kitId}/default`, {});
  }
  /** The design's active resolved brand + the caller's manage flag (FR-11). */
  getDesignBrand(designId: string): Promise<ResolvedBrand> {
    return this.request("GET", `/v1/designs/${designId}/brand`);
  }
  /** Assign (or clear, with null) a design's active brand kit (FR-2); needs
   *  manage-brand. Writes DesignFile.meta.brandKitId server-side. */
  assignDesignBrand(designId: string, brandKitId: string | null): Promise<ResolvedBrand> {
    return this.request("POST", `/v1/designs/${designId}/brand`, { brandKitId });
  }

  // --- brand versioning --------------------------------------
  /** A kit's version history, newest first (FR-9); needs manage-brand. */
  listBrandKitVersions(kitId: string): Promise<BrandKitVersion[]> {
    return this.request("GET", `/v1/brand-kits/${kitId}/versions`);
  }
  /** Restore a kit to a prior version (FR-9); needs manage-brand. The prior
   *  snapshot is written back as a NEW version (history is never destroyed). */
  restoreBrandKitVersion(kitId: string, version: number): Promise<BrandKit> {
    return this.request("POST", `/v1/brand-kits/${kitId}/restore`, { version });
  }

  // --- brand linting -----------------------------------
  /** Lint a design against its active brand kit (FR-7). Membership-gated.
   *  Returns every violation found, each with an applyable fix where safe. */
  brandLint(designId: string): Promise<BrandLintViolation[]> {
    return this.request("GET", `/v1/designs/${designId}/brand-lint`);
  }
  /** The pre-export/publish brand gate for a design (FR-8). `blocked` is true
   *  under lintPolicy 'block' with any non-info violation, so the export refuses. */
  brandLintGate(designId: string): Promise<BrandLintResult> {
    return this.request("GET", `/v1/designs/${designId}/brand-lint/gate`);
  }

  // --- pin / track ------------------------------------------
  /** Whether the tracked kit advanced past what the design reflects (FR-10),
   *  with a change summary, so the editor can prompt to review the update. */
  brandUpdates(designId: string): Promise<BrandUpdateSummary> {
    return this.request("GET", `/v1/designs/${designId}/brand-updates`);
  }
  /** Pin a design to a specific kit version, or track latest with null (FR-10);
   *  needs manage-brand. Never mutates the scene graph. */
  setDesignBrandVersion(designId: string, version: number | null): Promise<ResolvedBrand> {
    return this.request("POST", `/v1/designs/${designId}/brand-version`, { version });
  }
  /** Record the tracked kit's current version as reviewed (FR-10); needs
   *  manage-brand. Clears the "Brand updated - review" banner until the kit
   *  advances again. Writes `meta.brandReviewedVersion`; never mutates the scene
   *  graph. Returns the design's resolved brand. */
  markBrandReviewed(designId: string): Promise<ResolvedBrand> {
    return this.request("POST", `/v1/designs/${designId}/brand-reviewed`, {});
  }

  // --- locked regions + editable fields ----------------
  /** Mark (or replace, an empty array clears) a design's brand locked-region
   *  node ids and, optionally, its editable fields (FR-6); needs manage-brand.
   *  Pass `editableFields` to record which nodes a filler may populate (omit to
   *  leave them untouched, `[]` to clear). Returns the design's resolved brand
   *  with the new locked-region + editable-field lists. */
  setDesignLockedRegions(
    designId: string,
    lockedRegions: string[],
    editableFields?: BrandEditableField[],
  ): Promise<ResolvedBrand> {
    return this.request("POST", `/v1/designs/${designId}/brand-locked-regions`, {
      lockedRegions,
      ...(editableFields !== undefined ? { editableFields } : {}),
    });
  }
}
