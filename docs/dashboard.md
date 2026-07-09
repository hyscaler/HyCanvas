# The Dashboard

The dashboard is the home surface after signing in: it holds your designs, the template library, workspace membership, and your account settings.

![The dashboard home](images/dashboard.png)

## Layout

- **Top bar**: one search box across your designs and the template library, the **Create** button, notifications, and your account menu.
- **Left sidebar**: the workspace switcher, the section rail, and your storage meters. The panel icon next to the logo collapses the sidebar to icons; HyCanvas remembers your choice.
- **Main area**: quick-start format tiles and your recent designs, switchable between grid and list views and sortable by last edited.

## Workspaces

Every design lives in exactly one workspace. You get a personal workspace on signup and can create or join others; the switcher at the top of the sidebar moves between them. Workspace data is isolated: members of one workspace never see another workspace's designs, uploads, or brand kit.

## Sections

- **Home**: quick-start tiles and recent designs.
- **Favorites**: designs you starred.
- **My tasks**: items assigned to you (for example from design comments).
- **Templates**: the template library (below).
- **Members**: who is in the workspace, their roles, and invitations.
- **Trash**: deleted designs, restorable until emptied.

## Templates

The **Templates** section browses the library by category: business, education, events, food, marketing, personal, presentations, print, quotes, and social. Picking a template creates a new design from it in the current workspace. The same library is searchable from the top bar and reachable from the editor.

![The template library](images/templates.png)

Self-hosters can curate this library; see [Built-in Templates](../README.md#built-in-templates) in the root README.

## Storage meters

The bottom of the sidebar shows how much storage your uploads use:

- **Workspace storage**: everything uploaded into the current workspace, against the per-workspace limit (`ASSET_QUOTA_BYTES`).
- **Your storage**: everything you personally uploaded across all workspaces, against the per-user limit. This bar appears when the operator sets `USER_STORAGE_QUOTA_BYTES`.

A bar turns red as it approaches its limit. When a limit is reached, uploads are rejected with a message naming which limit was hit; deleting uploads frees space immediately.

## Members, roles, and sharing

**Members** lists everyone in the workspace with their role, and is where owners and admins invite people by email (invitees receive an email link; the invite is bound to that address) or remove them.

![The members panel](images/members.png)

- **Roles**: Owner and Admin manage everything; Member can view, comment, edit, and share; Viewer can view and comment. Personal workspaces cannot be invited into.
- **Custom roles**: named capability sets (view, comment, edit, share, approve, manage roles, manage brand, delete) that admins define here and assign per design from the editor's Share dialog.

Sharing a single design with specific people or via link happens from the **Share** button inside the editor; see [the editor guide](editor.md#sharing-and-permissions).

## My tasks

Comments converted to tasks (from the editor's comment panel) land in **My tasks** when assigned to you, with status (Open, In progress, Done) and optional due dates.

## Dark mode

The interface follows your OS theme by default, and you can pin it light or dark from the avatar menu or Settings. Your designs, template previews, and present mode always keep their own colors.

![The dashboard in dark mode](images/dark-dashboard.png)

## Account settings

The avatar menu in the top-right opens **Settings**.

![Account settings](images/settings.png)

- **Account**: display name, language, appearance, and your data. **Appearance** picks the interface theme (system, light, or dark; your designs are never restyled), also toggleable from the avatar menu on the dashboard. **Download my data** exports everything in your account; **Delete account** permanently removes it.
- **Security**: change your password, enroll two-step verification (a TOTP authenticator app), review and revoke active sessions, and link your organization's single sign-on (for example Google) to the account when the server has it configured.

![Security settings](images/settings-security.png)

- **Notifications**: per-type email and push preferences for mentions, replies, task assignments, shares, approval requests and decisions, workspace invites, and access requests.
