# Editor ergonomics backlog

Small things that make editing feel right, gathered from hands-on use of the editor rather than from a capability audit. Each item names what was hard, what shipped, and how it was verified. Items are done unless marked otherwise.

| ID | Item | Status |
|----|------|--------|
| G01 | Rulers that read: minor marks between the labelled majors, the selection's extent as a band on both rulers, the pointer's position as a marker with its coordinate | done 2026-09-30 |
| G02 | Alignment where the element is: an Align button on the floating selection toolbar opening left, centre, right, top, middle, bottom and centre on page; the panel's Arrange section open by default and captioned "Align to page" or "Align to selection" | done 2026-09-30 |
| G03 | Brand colours from the work: an add row in the Brand panel's Colors section with a picker, a hex field, the selection's colours and the page's colours | done 2026-09-30 |
| G04 | Layers that move: a drop lands directly in front of the row it lands on in either direction, a zone under the last row sends to the back, every row has a step forward and a step back, and Alt with the arrow keys moves the focused layer | done 2026-09-30 |
| G05 | Layers inside groups: a group opens to list its children indented, and every restack (drop, step, forward, back, front, the toolbar and shortcuts) acts among a node's own siblings | done 2026-09-30 |

## G01: Rulers that read

- Was: the rulers carried one labelled mark every sixty pixels or so and nothing else, so a position could only be estimated.
- Shipped: `rulerTicks` plans labelled majors with minors between them (fifths when a major spans at least 75px on screen, halves otherwise). The strips draw the selection's extent as a band with its two edges marked, and the pointer's position as a marker carrying the rounded coordinate. The pointer is published from the canvas surface through a small module store so only the two strips repaint on a move. The rulers toggle is unchanged.
- Verified: the tick plan's step ladder, minor spacing and no duplicated majors; the strips in the editor with a selection and a moving pointer.

## G02: Alignment where the element is

- Was: alignment lived in the properties panel's Arrange section, collapsed by default, and in the command menu; centring a picture on the page took a search.
- Shipped: the floating selection toolbar has an Align button that opens a row with the six edges and Center on page, captioned for the page (one element) or the selection (many). The store's `alignSelection` takes "center", both axes summed into one undo step. The Arrange section opens by default and carries the same caption; the command menu lists Center on page. Bring forward and Send backward sit on the toolbar beside Bring to front and Send to back.
- Verified: centre on page for one node and for many, undo in one step, the single-axis edges unchanged.

## G03: Brand colours from the work

- Was: the only way to add a colour was a bare 28px colour input at the end of the manage list, under an admin section further down.
- Shipped: the Colors section, for brand managers, carries a picker with a hex field and an Add button, a From selection button that takes every solid fill, stroke and text colour of the selected elements, and a From this page button that takes the page's colours most used first. Colours already in the palette are skipped and the count added is said.
- Verified: the page colour harvest (fills, strokes, text runs, groups, background, ordering, transparency, cap) and the selection harvest.

## G04: Layers that move

- Was: a drop computed its index from the target's array position, so a layer dragged down the list landed one slot too far back; nothing could be dropped behind everything; a single step meant a precise drag.
- Shipped: `layerDropIndex` works in the panel's own front-first order (remove the dragged row, insert before the target) and maps back to the children index, so the result is the same whichever way the drag went. A dashed zone under the last row appears while dragging and sends the layer to the back. Every row shows a step forward and a step back on hover, disabled at the ends, and Alt with the arrow keys moves the focused row.
- Verified: the drop maths in both directions, the no-op cases and the back zone; the panel's drag, zone, buttons and keys in a rendered test.

## G05: Layers inside groups

- Was: the panel listed the page's top-level layers only, and the z-order commands looked for the selection among them, so a node inside a group could not be listed, dragged or moved with Bring forward and Send backward at all.
- Shipped: a group row opens (chevron, or Right and Left on the keyboard) to list its children indented, with the same hide, lock, rename, step, duplicate and delete controls. The store's `reorderLayer` and `orderSelection` locate each node and restack it among its own siblings, a selection spanning containers restacking within each as one undo step, so the toolbar buttons, the context menu and the bracket shortcuts work inside a group too. A drop restacks within the same container; a drop across containers changes nothing, and the send-to-back zone is offered for top-level layers only.
- Verified: reorder and every z-order command inside a group, the cross-container selection as one undo step, and the panel's expand, indent, restack-within and ignored cross-container drop in a rendered test.

Still open: moving a layer between containers (into or out of a group) is done by grouping and ungrouping, not by dragging in the panel.
