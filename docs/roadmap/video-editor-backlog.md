# Video Editor: Bug & Gap Backlog

Compiled 2026-07-17 from a code-level audit (every bug adversarially verified
against the working tree unless marked *unverified*). Fix order suggestion at
the bottom. Check items off as they land.

## A. Verified bugs

### High
- [x] **A1. Exact in-browser export records the 540p preview proxy**, not the original media, whenever a proxy exists; docs promise "exports keep the original". Needs an export-mode media rebind (originals during recording). `VideoSurface.tsx` player resolveMedia + `playback.ts elementFor`.
- [x] **A2. Single-clip delete always ripples; multi-delete never does.** No plain "lift/delete leaving a gap" exists, and the two paths disagree. Offer Delete = lift, Shift+Delete = ripple (both multi-track aware), align menu labels.

### Medium
- [x] **A3. In-edge trim mixes source frames with timeline frames** - trims of speed!=1 clips move the clip start by the wrong amount. `packages/timeline/src/edit.ts:60-62`.
- [x] **A4. Out-edge trim has no clamp at the media's real duration** - the timeline extends past available footage; preview freezes while server export behavior diverges. Model lacks a source-duration field; the surface knows probed durations and must clamp.
- [x] **A5. Speed changes and toolbar trim nudges bypass the no-overlap invariant** - a lengthened clip silently hides its neighbor. `doSetSpeed`/`doTrim` need the collision handling drag-trim already has.
- [x] **A6. Detach audio drops the clip at a shifted start when the audio lane is occupied** (freeStartFrame pushes it) - audio out of sync with its video without warning. Should create a new track when the sync spot is taken.
- [x] **A7. Fps change desyncs nested sequences** - the preview has no fps conversion at the sequence boundary, the server flatten converts differently; after a parent fps switch the two disagree with each other AND with intent. Cascade fps into child sequences, or convert at the boundary.
- [x] **A8. Timeline height grows unbounded with track count** - no vertical lane scrolling; enough tracks crush the preview and lower lanes become unreachable.
- [x] **A9. Zoom is not anchored** on the playhead or cursor - zooming jumps the visible region.
- [x] **A10. Shift-click deselect keeps the clip as primary selection** - Delete then removes the clip the user just deselected.
- [x] **A11. Multi-clip drag past frame 0 permanently distorts group spacing** (per-clip max(0,...) clamp). Clamp the group delta instead.
- [x] **A12. "loading media..." diagnostic is burned into exact exports** when a source stalls mid-recording. Suppress the overlay while recording (draw last good frame instead).
- [x] **A13. Positive dB gains (+1..+6 in the sliders) are clamped to x1.0 in preview but applied for real in server export** - the two outputs differ. Remove the clamp in `@hc/audio mixGains` (WebAudio handles >1 gains) or cap the sliders at 0.
- [x] **A14. Server MP4 renders an authored cross-dissolve as a dip through the background**, not a crossfade (both fades run against the base, not each other), and the export dialog does not disclose it. Use ffmpeg xfade for exact-cut dissolve pairs, or disclose.
- [x] **A15. Media panel upload/delete failures are swallowed** - empty catch, no toast/message (quota errors invisible even though the SDK surfaces problem+json detail).
- [x] **A16. Waveforms/filmstrips on clips are decorative repeating tiles** - not aligned to trim in-point, speed, or zoom; the picture lies about where content sits in the clip.

### Low
- [x] **A17. splitClip rounds vs ceil mismatch** creates a 1-frame overlap/gap at fractional speeds.
- [x] **A18. Fps re-timing rounds starts and durations independently** - abutting clips open 1-frame gaps/overlaps (speed != 1).
- [x] **A19. Stage-size select while editing a nested sequence** edits a stage the final render ignores; parent stage changes never propagate to children. Hide it (or make it read-only) in child scope.
- [x] **A20. Audio tracks render a no-op hide (eye) toggle.**
- [x] **A21. Ruler ticks fixed at one per second** - labels smear at low zoom, no finer ticks at high zoom.
- [x] **A22. Snap radius floor of 2 frames = 24px magnetism at max zoom.**
- [x] **A23. Multi-drag snapping computes against stale positions** of clips moving in the same selection.
- [x] **A24. Holding Space auto-repeats play/pause** (no e.repeat guard).

## B. Reported bugs, verifier interrupted (*unverified* unless noted)
- [x] **B1. Same-aspect stage-size changes give zero visual feedback** (1080p->720p->4K look identical in the aspect-fitted preview; the real resolution DOES change). *Re-confirmed manually.* Fix with a dimensions readout on the stage + preset labels showing use-case.
- [x] **B2. Fps change does not remap markers or the I/O export range** - they drift to different wall-clock times. *Re-confirmed manually (setProjectFps maps tracks+captions only).*
- [x] **B3. Play at the very end of the timeline does nothing** (must rewind first); pressing Play at the end should restart from 0.
- [x] **B4. Nesting drops track-level state** - child tracks reportedly lose gainDb/muted/solo/locked when clips are collapsed into a sequence.
- [x] **B5. Overlay-track clip audio plays in preview/exact export but is silent in the server export** (server mixes audio+video kinds only).
- [x] **B6. Trimming a reversed clip's in edge removes content from the wrong end.**
- [x] **B7. Copying a multi-selection copies only the primary clip.**
- [x] **B8. Global shortcuts stay live while modal dialogs are open; Escape closes no dialog.**
- [x] **B9. Stage selection outline is wrong for contain-fit, cropped, and rotated clips** (assumes cover fit, no rotation).
- [x] **B10. "Stop to start" and "Rewind to start" transport buttons do the same thing.**

## C. High-priority gaps
- [x] **C1. Delete a track** (no path exists at all, even for empty tracks). Include: warn/confirm when clips exist, ducking/solo reference cleanup.
- [x] **C2. Custom stage size + platform presets** - only 5 sizes today, no WxH input, no TikTok/Reels/Shorts/YouTube/4:5 labels, no orientation swap. Everything downstream already accepts arbitrary sizes.
- [x] **C3. Extend the timeline beyond the last clip** - durationFrames is always recomputed; no trailing black/hold for outros, no fixed target duration. (Server export already honors longer durations; the client stomps them - also a mixed-version data-alteration smell.)
- [x] **C4. Timeline follows the playhead** during playback/stepping + edge auto-pan while dragging clips.
- [x] **C5. On-stage title editing** - click a title on the preview to select/edit/reposition it.
- [x] **C6. Media panel search/sort** (and see C7 for scale).
- [ ] **C7. Uploads are base64 JSON with the whole file in memory** - BLOCKED on the unmerged feat/direct-uploads branch (kept unmerged on request); wire the video panel to the direct/chunked pipeline once that branch lands.

## D. Medium gaps
Track management
- [x] D1. Rename track (model field exists, displayed, not editable).
- [x] D2. Duplicate track. D3. Drag to reorder tracks (+disable arrows at edges). (edge-disabled arrows done; drag reorder still open)
- [x] D4. Create overlay tracks (kind fully works end-to-end; +Video/+Audio/+Text only today).
- [x] D5. Per-video-track audio controls (video tracks carry sound but have no mute/solo/gain; audio-track solo silently kills video sound).
Clip operations
- [x] D6. Reverse playback UI (model/engine/server all support negative speed; inputs reject it).
- [x] D7. Crop tool (Clip.crop rendered by compositor; no UI, and server export drops it - add both).
- [x] D8. Replace media keeping trim/effects. D9. Disable/enable clip. D10. Slip edit.
- [x] D11. Group/link clips (esp. video + its detached audio moving together).
- [x] D12. Multi-track ripple (ripple delete / close gap across all tracks to keep sync).
Timeline UX
- [x] D13. Marquee selection + Select All. D14. Arrow-key clip nudge. D15. J/K/L shuttle.
- [x] D16. Snap toggle in the toolbar + snapping for trim drags + snap to markers/range.
- [x] D17. Wheel/pinch zoom + zoom-to-fit button.
Preview
- [x] D18. Fullscreen/theater preview. D19. Play-selection (range) without loop.
- [x] D21. Stage zoom/pan 100% pixel view DONE. D20 partially: the optimizing badge ships; a manual proxy/original quality toggle is still open:
- [x] D20b. Manual preview-quality toggle (proxy vs original).
- [x] D22. Click the stage to select the clip under the pointer.
- [x] D23. Poster frame for the dashboard card + export current frame as PNG.
Audio
- [x] D24. Master volume UI (model+engine honor master.gainDb; nothing exposes it).
- [x] D25. Ducking config (choose music/voice tracks, amount, attack/release; today hardcoded).
- [x] D26. Waveforms for the audio of video clips (peaks pipeline supports it).
Export
- [x] D27. Exact-path choices (container preference, bitrate, resolution).
- [x] D28. Server export custom resolution/fps; WebM container option.
- [x] D29. Export queue/history UI (jobs API exists; closed tab orphans a finished render).

## E. Low / polish
- [x] E1. Freeze frame; E2. Rate-stretch edge (retime by dragging); E3. Per-clip lock; E4. Clip color labels.
- [x] E5. Direct keyframe editing on the clip-body gain envelope; E6. Track height presets; E7. Per-track meters.
- [x] E8. Draggable markers + draggable range edges + click-to-jump; E9. Adaptive ruler ticks (with A21).
- [x] E10. Safe-area/thirds guides; E11. Persistent dimensions/fps readout on the stage; E12. Scrub audio.
- [x] E13. Export size estimate; E14. Caption burn-in choice at export; E15. Per-track stems export.
- [x] E16. Import-from-URL + usage badge in the media panel (folders/tags deferred with C7); E17. Hover-scrub previews.
- [x] E18. Decide dormant model fields: implement or drop Track.pan and Clip.frameBlend; remove or implement the dead "effects" track kind.

## Suggested fix order
1. Correctness of core edits (A1-A5, A17): export fidelity + trim/speed/split math.
2. User-reported UX blockers (C1 track delete, C2 sizes+feedback/B1, C3 duration, A2 delete semantics).
3. Timeline flow (C4 follow+autopan, A8 lane scroll, A9 zoom anchor, D16/D17).
4. Sync-safety (A6, A7, B2, D11, D12).
5. Dormant quick wins (D6 reverse, D7 crop, D24 master gain, D4 overlay tracks, D1 rename).
6. The rest by section priority.
