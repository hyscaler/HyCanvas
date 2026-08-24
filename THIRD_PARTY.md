# Third-party code adaptations

Close adaptations of third-party code (as opposed to independently implemented
logic), recorded per the F28 porting rules. Each line names the source
repository, the source path, its license, and the date of adaptation.

- presenton (`servers/fastapi/utils/theme_utils.py`), Apache-2.0, 2026-08-24:
  the OKLCH color conversions (`packages/color/src/convert.ts`) and the
  lightness-ladder palette derivation constants and stepping rules
  (`packages/aistudio/src/themeGen.ts`). The randomized retry-until-contrast
  generation was replaced with a deterministic AA repair.
- presentation-ai (`src/lib/presentation/themes.ts`), MIT, 2026-08-24: a
  curated subset of the built-in theme palettes and font pairings, adapted to
  the 6-slot theme convention in
  `frontend/src/components/editor/PropertiesPanel.tsx` (seed deck themes).
- presentation-ai (`src/lib/presentation/generated-theme.ts`), MIT,
  2026-08-24: the strict 6-digit hex validation approach for AI-generated
  theme colors in `packages/aistudio/src/themeGen.ts`.
- presentation-ai (`src/hooks/presentation/useRecording.ts`), MIT, 2026-08-24:
  the webcam bubble compositor math (object-fit cover-cropping and the
  rounded-rect clipping path) in `drawCameraBubble`,
  `frontend/src/components/editor/PresentMode.tsx`.
