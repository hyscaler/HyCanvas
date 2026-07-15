// Accounts/auth/workspace data model. These mirror the Postgres rows and SDK
// payloads; the logic over them in this package is pure. The Go backend's auth
// module and Postgres persistence build on this core; OIDC SSO and MFA ship,
// while SAML/SCIM/LTI and some email flows remain on the roadmap.

export type WorkspaceKind = "personal" | "team" | "org" | "classroom";
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface AccountPrefs {
  notifications?: Record<string, boolean>;
  accessibility: { reduceMotion: boolean; highContrast: boolean };
  defaultWorkspaceId?: string;
}

// Regional preferences. "auto" defers to the browser/locale at render time, so a
// user who never sets these behaves exactly as before the fields existed.
export type TimeFormat = "auto" | "12h" | "24h";
export type WeekStart = "auto" | "sunday" | "monday";

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  avatarUrl?: string;
  locale: string;
  theme: "system" | "light" | "dark";
  // IANA timezone name (e.g. "Asia/Kolkata"); "" means auto (follow the browser).
  timezone: string;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
  prefs: AccountPrefs;
  mfaEnabled: boolean;
  createdAt: string;
}

export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  name: string;
  slug: string;
  avatarUrl?: string;
  ownerId: string;
  ssoConnectionId?: string;
  brandKitDefaultId?: string;
  createdAt: string;
}

export interface Membership {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  classroomRole?: "teacher" | "student";
  invitedBy?: string;
  joinedAt?: string;
  status: "invited" | "active" | "suspended";
}

export type AuthProvider = "password" | "google" | "apple" | "microsoft" | "oidc" | "saml";

export interface AuthIdentity {
  id: string;
  userId: string;
  provider: AuthProvider;
  providerSubject: string;
  connectionId?: string;
  email?: string;
  emailVerified?: boolean;
}

export interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  expiresAt: string; // ISO
  acceptedAt?: string | null;
}

export interface HomeItem {
  kind: "design" | "project" | "folder" | "template" | "asset";
  /** For designs: the document surface kind (whiteboard/doc/sheet/video) from the
   *  file's meta.kind; absent/"design" for a plain design. Drives dashboard type
   *  filters. */
  docKind?: string | null;
  id: string;
  title: string;
  thumbnailUrl?: string;
  workspaceId: string;
  updatedAt: string;
  starred: boolean;
  sharedWithMe: boolean;
}
