// Comments store. Holds the comment threads for the design open
// in the editor, the caller's comment capability, the comment-placement mode (a
// pending anchor while the "comment" tool is active), and which thread is open.
// The data is fetched over REST and refreshed live via the realtime
// `{ t: "comment" }` signal; clients without a socket still work via REST.

import { create } from "zustand";
import type { CommentAnchor, CommentFilter, CommentThread } from "@hc/sdk";
import { oc } from "@/lib/sdk";

interface CommentsState {
  /** The design these comments belong to, or null when no saved design is open. */
  designId: string | null;
  /** True when the caller has the `comment` capability (gates the composer). */
  canComment: boolean;
  /** Whether the Comments panel is open. */
  panelOpen: boolean;
  /** Whether the comment-placement tool is active (next canvas click drops a pin). */
  placing: boolean;
  /** Thread list filter. */
  filter: CommentFilter;
  threads: CommentThread[];
  loading: boolean;
  /** The thread whose detail/replies are expanded, or null. */
  openThreadId: string | null;
  /** A pin being composed (anchor chosen, awaiting body), or null. */
  draftAnchor: CommentAnchor | null;

  setDesign(designId: string | null, canComment: boolean): void;
  setPanelOpen(open: boolean): void;
  togglePanel(): void;
  setPlacing(on: boolean): void;
  setFilter(filter: CommentFilter): void;
  setOpenThread(id: string | null): void;
  setDraftAnchor(anchor: CommentAnchor | null): void;
  refresh(): Promise<void>;
}

export const useComments = create<CommentsState>((set, get) => ({
  designId: null,
  canComment: false,
  panelOpen: false,
  placing: false,
  filter: "all",
  threads: [],
  loading: false,
  openThreadId: null,
  draftAnchor: null,

  setDesign: (designId, canComment) => {
    set({ designId, canComment, threads: [], openThreadId: null, draftAnchor: null, placing: false });
    if (designId) void get().refresh();
  },
  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => {
    const open = !get().panelOpen;
    set({ panelOpen: open });
    if (open && get().designId) void get().refresh();
  },
  setPlacing: (on) => set({ placing: on }),
  setFilter: (filter) => {
    set({ filter });
    if (get().designId) void get().refresh();
  },
  setOpenThread: (id) => set({ openThreadId: id }),
  setDraftAnchor: (anchor) => set({ draftAnchor: anchor, placing: false, panelOpen: anchor ? true : get().panelOpen }),

  refresh: async () => {
    const { designId, filter } = get();
    if (!designId) return;
    set({ loading: true });
    try {
      const threads = await oc.listComments(designId, filter);
      // Ignore a stale response if the open design changed mid-flight.
      if (get().designId === designId) set({ threads });
    } catch {
      /* keep the prior list; the panel shows the last good state */
    } finally {
      if (get().designId === designId) set({ loading: false });
    }
  },
}));
