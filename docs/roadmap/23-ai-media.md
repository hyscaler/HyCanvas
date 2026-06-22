# F23: AI Media

| Field | Value |
| --- | --- |
| Feature ID | F23 |
| Phase | 4 AI |
| Sequence | 23 |
| Status | Not started |

## 1. Context and Goal

AI Media is the set of AI tools that operate on time-based media: video, audio, and voice. It covers removing or replacing a video background, detecting scene cuts, generating captions and subtitles, generating or matching music, synthesizing speech in many languages, lip-syncing and avatar video, and turning a still image into motion. Like the rest of the AI tier it follows one rule above all: every output is an editable native artifact. Captions become an editable subtitle track and text nodes; music becomes an editable audio clip on the timeline; a generated narration becomes a voice clip with its transcript; image-to-video produces clips and motion keyframes the user can edit. Nothing is permanently baked.

This document defines the AI behaviors and their data; the underlying video timeline, tracks, audio mixing, and playback engine are owned by the video editor and the animation/timeline model. AI Media emits into those structures and is usable both inside the video editor and standalone on any design with media.

Intended outcome: a creator can drop in a clip and, in a few clicks, strip its background, split it into scenes, caption it accurately, score it with fitting music, add a multilingual voiceover, lip-sync a presenter, or animate a still, and then refine every result by hand on the timeline.

## 2. Scope

In scope:
- Video background removal (and replacement) with editable matte.
- Scene detection (automatic cut/shot detection producing editable scene markers and split points).
- Auto-captions and subtitles (transcription, timing, editable caption track, multi-language subtitle export).
- AI music generation and royalty-free soundtrack matching (mood/length-aware), producing editable audio clips.
- Text-to-speech with natural multilingual voices, producing editable voice clips with transcripts.
- Lip-sync and avatar video (drive a face/avatar from audio or text).
- AI image-to-video and motion effects (animate a still image into a clip; pan/zoom/parallax motion).
- Editable output timelines for all of the above.

Out of scope (owned elsewhere, invoked here):
- The video editor UI, timeline data model, track mixing, transitions, and render/export pipeline (the video editor; export via the export engine).
- The animation/keyframe model used by motion effects.
- Raw text-to-video clip generation from a prompt with no source media (AI generative); image-to-video here animates an existing still and may delegate to the same generative models via the AI platform.
- The provider-adapter layer, BYO keys, routing, quotas, and capability metadata (the AI platform).
- Talking-avatar presenter integration into presentations (presentations consume this feature's avatar output).
- Text rewrite/translation primitives (AI writing); subtitle translation delegates to it.

Deferred:
- Real-time/live captioning during presenting (hooks left for presentations; batch captioning ships first).
- Voice cloning of a user's own voice (requires consent/verification flow; deferred pending the enterprise consent/policy framework).

## 3. User Stories

- As a video creator, I want to remove the background from a clip and drop in a new one without a green screen.
- As an editor, I want long footage auto-split into scenes so I can cut faster.
- As a content creator, I want accurate captions generated and burned-in or exported as SRT, and editable when the model mishears a word.
- As a marketer, I want background music that fits the mood and length of my video, royalty-free, that I can trim and re-level.
- As a global brand, I want a natural-sounding voiceover in several languages from my script.
- As a course creator, I want a talking avatar to narrate my slides without filming myself.
- As a social marketer, I want to turn a product photo into a short motion clip with a tasteful pan and zoom.
- As an accessibility-focused team, we want subtitles in multiple languages exported alongside the video.

## 4. Functional Requirements

- FR-1: Video background removal produces an editable alpha matte for a clip; the user can keep transparency, replace with a color/image/video background, and adjust matte edge feathering; the original clip is never destroyed.
- FR-2: Scene detection analyzes a clip and emits scene markers with timecodes; the user can accept all as split points, split selectively, or adjust/delete markers; splits create editable sub-clips on the timeline (the video editor).
- FR-3: Auto-captions transcribe a clip's audio into a timed, editable caption track with per-cue text, start/end, and speaker labels where detectable; the user can edit text and timing.
- FR-4: Subtitles can be translated into other languages (delegating to AI writing) producing additional caption tracks per language; captions export as SRT/VTT and can be burned in on render (export engine / video editor).
- FR-5: AI music generation accepts a mood/genre/length (and optional reference) and returns an editable audio clip; soundtrack matching searches royalty-free tracks ranked by mood and target length and returns selectable clips.
- FR-6: Generated/selected music is placed as an editable audio clip on an audio track with trim, fade, loop, and volume controls (the video editor); duration can auto-fit the video length.
- FR-7: Text-to-speech accepts text and a chosen voice/language and returns an editable voice clip with its transcript attached and word-level timing where the provider exposes it (enabling caption sync).
- FR-8: Lip-sync drives a provided face video or a selected avatar from an audio clip or TTS output, producing a video clip; the user can re-time or replace the driving audio and regenerate.
- FR-9: Avatar video generates a talking-presenter clip from text or audio and a chosen avatar/voice; output is a clip on the timeline with its transcript and is usable as a presenter (presentations).
- FR-10: Image-to-video animates a still image node into a clip (generative motion or parametric camera motion: pan/zoom/parallax/ken-burns) with editable motion keyframes (the animation model) and a chosen duration.
- FR-11: Motion effects can be applied to any image/clip as editable, parametric keyframed transforms that the user can tweak or remove without re-running AI.
- FR-12: All AI calls route through `@hc/ai` (the AI platform), honoring per-feature routing, BYO keys, fallback chain, quotas, capability detection, and redaction; no provider SDK is called directly.
- FR-13: Every output is written into the timeline/scene as editable native artifacts (clips, tracks, cues, keyframes, transcripts), never as a flattened, non-editable render.
- FR-14: All long-running media work runs as background jobs on workers with WebCodecs/ffmpeg, with progress and cancellation; results stream back and apply through the same edit path as manual edits (collaborative-safe, undoable, versioned via the realtime, history, and persistence layers).
- FR-15: Source media is read from and results written to object storage (uploads/media) as new assets; the original asset is always retained for non-destructive editing and undo.
- FR-16: Each AI media artifact records provenance (model id, source asset, parameters, seed where available) for reproducibility and re-generation.

## 5. UX and Interaction Behavior

Entry points:
- An "AI Media" panel available on any clip/audio/image selection, with sections: Remove Background, Detect Scenes, Captions, Music, Voiceover, Avatar/Lip-sync, Motion.
- Inside the video editor, the same tools appear as timeline-context actions on the selected clip/track.

Background removal:
1. Select a clip, choose Remove Background; a job runs and shows a live preview of the matte.
2. The user keeps transparency or picks a replacement (color/image/video), tunes edge feather, and applies; result is an editable clip with the matte stored.

Scene detection:
- Run on a clip; markers appear on the timeline. The user reviews, then "Split at all" or splits individually; sub-clips become independently editable.

Captions:
- Run captions; cues appear in an editable caption editor synced to the playhead. The user fixes text inline, drags cue edges to retime, assigns speakers. "Translate" adds a language track. Style controls (font, position, background) apply to burned-in captions.

Music / voiceover:
- Music: pick mood/genre/length or describe it; generated or matched tracks list with waveform previews; selecting drops an editable clip on an audio track that can auto-fit to video length.
- Voiceover: paste text, pick voice and language, preview, generate; the voice clip lands on the timeline with its transcript, optionally feeding the caption track.

Avatar / lip-sync:
- Choose an avatar or upload a face clip, provide text or an audio clip, generate; the resulting talking clip appears on the timeline, re-generatable after edits.

Motion:
- Select a still; choose generative motion or a camera-motion preset (pan/zoom/parallax); set duration; the clip and its editable keyframes appear; keyframes are tweakable afterward without re-running AI.

States:
- Loading: per-tool progress with stage labels (uploading, analyzing, generating, finalizing) and cancellation; queue position for long jobs.
- Empty: each tool explains required input (a clip, audio, text, an image).
- Error: AI-platform provider/quota errors surfaced (rate limit, invalid key, model not found, unsupported capability) with retry and model-switch; partial outputs retained.
- Offline: AI media tools disabled with explanation; manual timeline editing unaffected.

## 6. Data Model

### TypeScript interfaces

```ts
// @hc/ai-media (consumes @hc/ai; emits into the video-editor timeline / animation keyframes)

export type MediaOp =
  | "bg_remove" | "scene_detect" | "captions" | "subtitle_translate"
  | "music_generate" | "music_match" | "tts" | "lipsync" | "avatar"
  | "image_to_video" | "motion_effect";

export interface MediaJobRequest<T extends MediaOp = MediaOp> {
  op: T;
  designId: string;
  trackId?: string;            // target timeline track, when applicable
  clipId?: string;             // source clip
  nodeId?: string;             // source image node (image_to_video/motion)
  sourceAssetId?: string;      // source media asset (uploads/media)
  input: MediaInput[T];        // op-specific payload
  routingKey: string;          // @hc/ai per-feature route, e.g. "ai_media.tts"
}

export interface CaptionCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

export interface CaptionTrack {
  id: string;
  lang: string;                // BCP-47
  source: "ai" | "human" | "translated";
  cues: CaptionCue[];
  style?: CaptionStyle;        // font/position/background for burn-in
}

export interface MusicInput {
  mode: "generate" | "match";
  mood?: string;
  genre?: string;
  lengthMs?: number;           // auto-fit to video when omitted
  referenceAssetId?: string;
}

export interface TtsInput {
  text: string;
  voiceId: string;
  lang: string;
  speed?: number;
  pitch?: number;
}

export interface MotionInput {
  mode: "generative" | "camera";
  preset?: "pan" | "zoom" | "parallax" | "kenburns";
  durationMs: number;
  intensity?: number;          // for camera presets
  seed?: number;               // generative reproducibility
}

export interface MediaArtifact {
  kind: "clip" | "audioClip" | "captionTrack" | "matte" | "keyframes";
  assetId?: string;            // new asset in object storage
  clipId?: string;             // timeline clip id
  captionTrack?: CaptionTrack;
  keyframes?: Keyframe[];      // motion keyframes
  transcript?: { text: string; wordTimings?: { w: string; ms: number }[] };
  provenance: {
    op: MediaOp; modelId: string; sourceAssetId?: string;
    params: Record<string, unknown>; seed?: number;
  };
}

export interface MediaJobResult {
  jobId: string;
  op: MediaOp;
  status: "succeeded" | "partial" | "failed";
  artifacts: MediaArtifact[];
  sceneMarkers?: { ms: number; confidence: number }[];   // scene_detect
  usage?: AiUsage;             // from @hc/ai
  warnings?: string[];
}
```

`Keyframe`, timeline `Clip`/`Track`, `AiUsage`, and audio-mix types are imported from the animation model, the video editor, and the AI platform. AI Media introduces caption/matte/provenance data attached to existing timeline structures; it defines no standalone document type.

### Postgres tables

```
ai_media_jobs(
  id, design_id, workspace_id, user_id,
  op, routing_key, status,            -- queued|running|succeeded|partial|failed
  source_asset_id, result_asset_ids text[],
  input_json, provenance_json,        -- model id, params, seed (no keys)
  provider_meta_json,                 -- usage; redacted per the AI platform
  progress int,                       -- 0..100
  created_at, started_at, finished_at, error
)

ai_caption_tracks(
  id, design_id, clip_id, lang, source,   -- ai|human|translated
  cues_json,                              -- CaptionCue[]
  style_json, updated_at,
  unique (design_id, clip_id, lang)
)

ai_media_voices(                          -- catalog of available TTS/avatar voices
  id, provider, voice_id, name, lang, gender, sample_url, capability_json
)
```

Generated media (clips, audio, mattes, captions exported as SRT/VTT) are stored as assets in object storage (uploads/media); timeline references point to them. Caption cue text is also persisted relationally for editing and search. Source assets are always retained.

## 7. API and Interfaces

REST under `/api/v1` (RFC 7807 errors, bearer JWT):

```
POST /api/v1/designs/:id/ai/media             -> { jobId }         # body: MediaJobRequest
GET  /api/v1/ai/media/jobs/:jobId             -> MediaJobResult     # poll; or subscribe via WS
POST /api/v1/ai/media/jobs/:jobId/cancel      -> { ok }

# Convenience wrappers (all -> ai/media jobs)
POST /api/v1/designs/:id/clips/:clipId/bg-remove
POST /api/v1/designs/:id/clips/:clipId/scenes
POST /api/v1/designs/:id/clips/:clipId/captions
POST /api/v1/designs/:id/captions/:trackId/translate     # body: { lang }
POST /api/v1/designs/:id/ai/music                        # generate or match
POST /api/v1/designs/:id/ai/tts
POST /api/v1/designs/:id/ai/avatar
POST /api/v1/designs/:id/nodes/:nodeId/animate           # image-to-video / motion

# Captions editing
GET  /api/v1/designs/:id/clips/:clipId/captions          -> CaptionTrack[]
PUT  /api/v1/designs/:id/captions/:trackId               -> { ok }   # edit cues/timing/style
GET  /api/v1/designs/:id/captions/:trackId/export.(srt|vtt)

# Voice catalog
GET  /api/v1/ai/media/voices?lang=                       -> ai_media_voices[]
```

WebSocket (`/realtime`): job progress and applied media artifacts push on the design channel; timeline mutations sync through the CRDT so collaborators see AI media edits live.

Internal package contracts:
- `@hc/ai`: `transcribe()`, `tts()`, `video()`, `audio()`, `route(featureKey)`, `withFallback()`, `usage()`, capability metadata. All AI access goes through here.
- `@hc/ai-media`: `runMedia(req): Promise<MediaJobResult>` (worker entry), `removeBackground()`, `detectScenes()`, `caption()`, `generateMusic()`, `synthesizeSpeech()`, `lipSync()`, `imageToVideo()`.
- `@hc/media`: WebCodecs/ffmpeg pipeline for decode/encode, matte compositing, audio mixing, frame extraction.
- Timeline mutations applied via the video editor's clip/track command API (which itself rides the command/CRDT path) so they are collaborative, undoable, and versioned.

## 8. Technical Approach and Architecture

- All operations are typed BullMQ jobs on `apps/worker`. Media workers carry WebCodecs/ffmpeg for decode, frame extraction, compositing, muxing, and re-encode.
- AI access is exclusively through `@hc/ai`: transcription for captions, audio models for music, TTS voices, video models for avatar/lip-sync/image-to-video. Routing, BYO keys, fallback, quotas, capability checks, and redaction are all handled there; this doc imports no provider SDK.
- Background removal runs a matting model per frame (or temporally-aware model where available) via `@hc/ai`, producing an alpha matte stored as a sidecar; compositing the matte with a replacement background is done locally in the media pipeline so it stays editable and the matte can be re-tuned without re-inference.
- Scene detection combines a fast deterministic shot-boundary pass (frame-difference/histogram in `@hc/media`) with an optional model pass for semantic scenes; output is markers, not destructive splits.
- Captions: extract audio, transcribe via `@hc/ai` (word timings when available), align into cues, store as an editable caption track; translation delegates to AI writing producing parallel tracks; burn-in is a render-time option (export engine / video editor).
- Music: generative music via `@hc/ai` audio models; matching queries the royalty-free catalog (the stock/asset library) ranked by mood embedding and length; both yield editable audio clips with auto-fit-to-length.
- TTS: synthesize via `@hc/ai` voices; attach transcript and word timings so the voice clip can drive a caption track and lip-sync.
- Lip-sync / avatar: drive a face or avatar from audio/TTS via `@hc/ai` video models; output is a timeline clip with transcript and provenance, re-generatable.
- Image-to-video / motion: generative motion via `@hc/ai`, or parametric camera motion expressed as editable animation keyframes computed locally (no model needed for camera presets) so the user can tweak the curve afterward.
- Editability and non-destruction: every result is a new asset plus timeline references; the source asset is retained; mattes, cues, and keyframes are parametric and editable; provenance (model, params, seed) is recorded for reproducible regeneration.
- All mutations to the timeline go through the video editor's command API on the CRDT path, making AI media edits collaborative-safe, undoable, and captured in version history.

## 9. Edge Cases and Constraints

- Background removal on fine detail (hair, transparency, motion blur): edge feathering and a manual matte-refine brush (image effects / video editor) are available; low-confidence regions are flagged.
- Scene detection on slow dissolves or continuous shots: thresholds are adjustable; the user can add/remove markers manually.
- Transcription of noisy audio, overlapping speakers, or unsupported languages: confidence per cue is shown; low-confidence cues are highlighted for review; unsupported language falls back or warns via the AI platform's capability metadata.
- Music length mismatch: auto-fit trims/loops with crossfade; very short videos avoid awkward loops by preferring trim.
- TTS pronunciation errors: a phoneme/SSML-style override per cue is supported where the provider allows; otherwise spelling hints.
- Lip-sync with a poorly lit or multi-face source: detect and warn; require a single clear face or fall back to avatar.
- BYO model lacking a required capability (no TTS, no video): detected via the AI platform's capability metadata; the feature degrades with a clear message and a model-switch suggestion.
- Very long media: jobs chunk by segment to bound memory and allow partial results; cancellation preserves completed segments.
- Concurrent editing: artifacts apply through the CRDT; if a target clip was removed by a collaborator mid-job, the artifact is parked and the user is prompted, not hard-failed.
- Provider failure mid-job: partial artifacts retained (`status: partial`); fallback chain attempted before failing.

## 10. Performance and Security Considerations

- Jobs report staged progress and are cancellable; queue position is shown for long renders.
- Heavy compositing/encode runs in workers with WebCodecs/ffmpeg, off the request path; frame work is chunked and parallelized.
- Quotas and rate limits enforced through the AI platform; BYO keys send the user's calls directly to their provider under their own billing with no platform markup.
- No provider keys reach this feature's logs or DB; only model ids, params, and usage are stored (AI-platform redaction).
- Source and generated media are per-workspace isolated, access-controlled via signed URLs (uploads/media), and virus/size-scanned on upload.
- Generated voice/avatar/lip-sync media carries provenance metadata; voice cloning of a real person is deferred pending the enterprise consent/policy framework.
- Caption text and transcripts are treated as user content and redacted from logs per workspace policy.

## 11. Acceptance Criteria

- AC-1: Background removal produces an editable matte; replacing the background with an image and tuning feather yields an editable clip, with the original clip retained.
- AC-2: Scene detection emits reviewable markers; "split at all" produces independently editable sub-clips on the timeline (the video editor).
- AC-3: Auto-captions produce an editable, timed caption track; editing a cue's text and timing persists and re-syncs to the playhead.
- AC-4: Subtitles translate into a second language as a parallel track and export as valid SRT and VTT.
- AC-5: Music generation/matching returns selectable tracks; the chosen one lands as an editable audio clip that auto-fits the video length with fades.
- AC-6: TTS produces an editable voice clip in a selected language with an attached transcript; word timings (where available) can drive captions.
- AC-7: Avatar/lip-sync produces a talking clip on the timeline that regenerates after the driving audio is changed.
- AC-8: Image-to-video / motion produces a clip with editable keyframes (the animation model) that the user can tweak without re-running AI.
- AC-9: Every output is an editable native artifact on the timeline; none is a flattened non-editable render; source assets are retained.
- AC-10: All AI calls go through `@hc/ai`; with a BYO key, calls route to the user's provider and consume no platform quota; a missing capability degrades gracefully.
- AC-11: Media edits are collaborative-safe (a second client sees them live), undoable, and captured in version history.
- AC-12: Every artifact records provenance (model id, params, seed) enabling reproducible regeneration.

## 12. Test and Verification Plan

- Unit: caption cue alignment and SRT/VTT serialization; scene-marker detection thresholds; music auto-fit (trim/loop/crossfade) logic; camera-motion keyframe generation; matte compositing math; provenance recording.
- Integration: end-to-end media job through the worker and `@hc/ai` with mocked providers; asset round-trip to object storage; timeline artifact application via video-editor commands; fallback/quota/capability behavior (AI platform); caption translation via AI writing.
- E2E: background-remove and replace on a real clip; scene-detect and split; caption, edit a cue, translate, export SRT; generate music and auto-fit; TTS voiceover feeding captions; avatar/lip-sync regenerate; image-to-video with keyframe edit.
- Manual: subjective quality review of matte edges, caption accuracy, music fit, voice naturalness, and lip-sync alignment across a sample set; concurrent-edit-during-job behavior; degradation with capability-limited BYO models.

## 13. Better than Canva

- Editable output timelines everywhere: captions, music, voice, motion, and matte are all editable native artifacts, not baked renders, so refinement never means re-doing.
- Longer-form video generation and higher-fidelity, broader multilingual voices than Canva's bundled set.
- Re-tunable AI matte: background removal stores the matte so edges and replacement can be adjusted without re-running inference.
- Provenance and reproducibility: every artifact records model, params, and seed, so results can be regenerated or audited, which Canva does not expose.
- Model freedom: all media AI routes through the BYO layer (the AI platform), so users choose the transcription, music, voice, and video models per feature, self-hosted or commercial, with graceful fallback and no platform markup.

## 14. Open Questions and Risks

- Frame-by-frame matting cost and latency for long clips; need a temporally-aware model path and aggressive chunking to keep jobs affordable.
- Word-level timing availability varies by transcription/TTS provider; caption-sync and lip-sync quality depend on it and may need a fallback aligner.
- Lip-sync and avatar realism vary widely by model; expectation-setting and a curated default voice/avatar set are needed.
- Voice cloning of a user's own voice is deferred pending an enterprise consent and verification policy; demand may pull it forward.
- Royalty-free music catalog sourcing and licensing for the "match" path needs to be settled with the stock/asset library.
- Generative motion (image-to-video) coherence over longer durations is model-limited; camera-motion presets are the reliable fallback.
