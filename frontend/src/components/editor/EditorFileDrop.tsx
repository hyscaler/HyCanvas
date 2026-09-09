// Dropping a file used to work only over the media panel on the left, so
// adding one always meant travelling to that panel first, even when working
// elsewhere on the canvas.
//
// This makes the whole editor a drop target while keeping the targets that
// already exist. A drop is offered to the most specific handler under the
// cursor first: the canvas places an image at the point it was dropped on, and
// a panel's own drop zone still takes its own files. Only a drop that nothing
// more specific claimed falls through to here, and it goes to the media library
// of whichever document surface is mounted. That surface registers itself,
// because the surfaces disagree about what they accept (the design panel takes
// images, the video panel takes video and audio) and each has its own progress
// and error reporting that a generic uploader here would bypass.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { tr } from "@/lib/i18n";

type DropHandler = (files: File[]) => void;

const FileDropContext = createContext<{ register: (h: DropHandler | null) => void } | null>(null);

/** True when the drag carries OS files, as opposed to an in-app drag (a layer
 *  being reordered, an image dragged out of the Uploads panel). */
function carriesFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Registers the active surface's uploader as the editor-wide drop target.
 * Pass null to accept nothing (a read-only session, or a surface with no
 * media library of its own).
 */
export function useEditorFileDropTarget(handler: DropHandler | null): void {
  const ctx = useContext(FileDropContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.register(handler);
    return () => ctx.register(null);
  }, [ctx, handler]);
}

/**
 * Renders the editor's root element as a drop target. Owns the element itself
 * rather than handing back props, so the drag state, the overlay, and the
 * context that surfaces register into cannot drift apart.
 */
export function EditorFileDropProvider({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const handlerRef = useRef<DropHandler | null>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child the pointer crosses, so a plain
  // boolean flickers off the moment the drag moves between elements. Counting
  // enters against leaves keeps the overlay steady for the whole drag.
  const depth = useRef(0);

  const register = useCallback((h: DropHandler | null) => {
    handlerRef.current = h;
  }, []);

  const end = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);

  return (
    <FileDropContext.Provider value={{ register }}>
      <div
        className={className}
        onDragEnter={(e) => {
          if (!carriesFiles(e) || !handlerRef.current) return;
          depth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (!carriesFiles(e) || !handlerRef.current) return;
          // Without preventDefault on dragover the browser refuses the drop
          // outright and opens the file instead.
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(e) => {
          if (!carriesFiles(e)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          end();
          // Something more specific already took it: the canvas placing an
          // image where it was dropped, or a panel's own drop zone. Handling it
          // again here would upload the same file twice.
          if (e.defaultPrevented) return;
          if (!carriesFiles(e)) return;
          const files = Array.from(e.dataTransfer.files ?? []);
          if (!files.length) return;
          e.preventDefault();
          handlerRef.current?.(files);
        }}
      >
        {children}
        {dragging && <DropOverlay />}
      </div>
    </FileDropContext.Provider>
  );
}

/**
 * The whole-editor drop hint. pointer-events-none is load-bearing: the overlay
 * covers every drop target underneath it, so intercepting the pointer would
 * stop the canvas and the panels ever seeing the drop.
 */
function DropOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-50 grid place-items-center bg-brand-600/10 backdrop-blur-[1px]"
      aria-hidden="true"
    >
      <div className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-brand-500 bg-surface px-6 py-4 shadow-lg">
        <Upload size={20} className="text-brand-ink" />
        <span className="text-sm font-medium text-neutral-800">{tr("editor.drop_files_to_add_them")}</span>
      </div>
    </div>
  );
}
