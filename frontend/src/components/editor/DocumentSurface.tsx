// Dispatcher for the non-canvas document types (docs 28-32). EditorApp mounts
// this in place of the design canvas when `doc.meta.kind` is a document type.
// Each surface is self-contained: it reads/writes the editor store (scene nodes
// for the whiteboard; `doc.meta.<kind>` for docs/sheets/video) and brings its
// own tools, so the shared chrome (top bar, save/export) stays in EditorApp.

import { WhiteboardSurface } from "./WhiteboardSurface";
import { DocSurface } from "./DocSurface";
import { SheetSurface } from "./SheetSurface";
import { VideoSurface } from "./VideoSurface";

export interface SurfaceProps {
  kind: string;
  workspaceId?: string;
  designId?: string;
}

export function DocumentSurface({ kind, workspaceId, designId }: SurfaceProps): React.ReactElement {
  switch (kind) {
    case "whiteboard":
      return <WhiteboardSurface workspaceId={workspaceId} designId={designId} />;
    case "doc":
      return <DocSurface workspaceId={workspaceId} designId={designId} />;
    case "sheet":
      return <SheetSurface workspaceId={workspaceId} designId={designId} />;
    case "video":
      return <VideoSurface workspaceId={workspaceId} designId={designId} />;
    default:
      return (
        <div className="grid flex-1 place-items-center text-sm text-neutral-500">
          Unsupported document type: {kind}
        </div>
      );
  }
}
