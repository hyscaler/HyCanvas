// @vitest-environment jsdom

// Making the whole editor a drop target means a drop now passes through
// handlers that already existed, so the risks are all about interference:
// uploading a file twice because both the canvas and the editor root took it,
// or hijacking an in-app drag that was never a file at all. Those are the cases
// covered here.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorFileDropProvider, useEditorFileDropTarget } from "./EditorFileDrop";

afterEach(cleanup);

const file = (name: string) => new File(["x"], name, { type: "image/png" });

/** A drag carrying OS files, as the browser reports it. */
function fileDrag(files: File[]) {
  return { dataTransfer: { types: ["Files"], files, dropEffect: "" } };
}

function Surface({ onFiles }: { onFiles: (f: File[]) => void }) {
  useEditorFileDropTarget(onFiles);
  return <div data-testid="surface">surface</div>;
}

/** Stands in for the canvas: claims the drop by calling preventDefault. */
function ClaimingChild() {
  return (
    <div
      data-testid="claiming"
      onDrop={(e) => e.preventDefault()}
    >
      canvas
    </div>
  );
}

describe("editor-wide file drop", () => {
  it("hands a file dropped on plain editor chrome to the active surface", () => {
    const onFiles = vi.fn();
    render(
      <EditorFileDropProvider className="root">
        <Surface onFiles={onFiles} />
      </EditorFileDropProvider>,
    );
    const f = file("a.png");
    fireEvent.drop(screen.getByTestId("surface"), fileDrag([f]));

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0]).toEqual([f]);
  });

  // The canvas places a dropped image at the point it was dropped on. If the
  // root handled it as well, that one file would be both placed AND uploaded.
  it("does not re-handle a drop a more specific target already claimed", () => {
    const onFiles = vi.fn();
    render(
      <EditorFileDropProvider className="root">
        <Surface onFiles={onFiles} />
        <ClaimingChild />
      </EditorFileDropProvider>,
    );
    fireEvent.drop(screen.getByTestId("claiming"), fileDrag([file("a.png")]));

    expect(onFiles).not.toHaveBeenCalled();
  });

  // Layer reordering and dragging an image out of the Uploads panel are in-app
  // drags. They carry no files and must pass through untouched.
  it("ignores an in-app drag that carries no files", () => {
    const onFiles = vi.fn();
    render(
      <EditorFileDropProvider className="root">
        <Surface onFiles={onFiles} />
      </EditorFileDropProvider>,
    );
    fireEvent.drop(screen.getByTestId("surface"), {
      dataTransfer: { types: ["application/x-oc-image"], files: [], dropEffect: "" },
    });

    expect(onFiles).not.toHaveBeenCalled();
  });

  it("shows the drop hint while files are dragged over, and clears it on drop", () => {
    render(
      <EditorFileDropProvider className="root">
        <Surface onFiles={vi.fn()} />
      </EditorFileDropProvider>,
    );
    const surface = screen.getByTestId("surface");
    expect(screen.queryByText(/drop files/i)).toBeNull();

    fireEvent.dragEnter(surface, fileDrag([file("a.png")]));
    expect(screen.getByText(/drop files/i)).toBeTruthy();

    fireEvent.drop(surface, fileDrag([file("a.png")]));
    expect(screen.queryByText(/drop files/i)).toBeNull();
  });

  // dragenter/dragleave fire for every child the pointer crosses, so a naive
  // boolean flickers the overlay off mid-drag.
  it("keeps the hint up while the drag crosses child elements", () => {
    render(
      <EditorFileDropProvider className="root">
        <Surface onFiles={vi.fn()} />
        <ClaimingChild />
      </EditorFileDropProvider>,
    );
    const surface = screen.getByTestId("surface");
    const child = screen.getByTestId("claiming");

    fireEvent.dragEnter(surface, fileDrag([file("a.png")]));
    fireEvent.dragEnter(child, fileDrag([file("a.png")])); // moved onto a child
    fireEvent.dragLeave(surface, fileDrag([file("a.png")])); // left the first one
    expect(screen.getByText(/drop files/i)).toBeTruthy();

    fireEvent.dragLeave(child, fileDrag([file("a.png")])); // left the editor
    expect(screen.queryByText(/drop files/i)).toBeNull();
  });

  // With nothing registered (a surface with no media library) the editor must
  // not swallow the drop and silently do nothing.
  it("accepts no drop when no surface has registered", () => {
    render(
      <EditorFileDropProvider className="root">
        <div data-testid="bare">no surface</div>
      </EditorFileDropProvider>,
    );
    fireEvent.dragEnter(screen.getByTestId("bare"), fileDrag([file("a.png")]));
    expect(screen.queryByText(/drop files/i)).toBeNull();
  });
});
