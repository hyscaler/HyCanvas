// Timeline video render: turns a video document's timeline (doc.meta.video,
// the @hc/timeline VideoProject serialization) into one ffmpeg invocation via
// a generated filter graph, so the server produces a true multi-track MP4:
// source trims, speed (including reverse), cover-scaled overlay compositing
// in track order, per-clip fade/dissolve/dip transitions, title cards and
// burned captions via drawtext, and the audio mix (per-clip gain/fades/delay,
// track gain with mute/solo, sidechain ducking, master gain).
//
// Fidelity notes (kept in sync with the in-browser exporter):
//   - wipe/slide transitions render as fades server-side (documented).
//   - keyframe poses and chroma key are browser-only for now; the client
//     labels the server option accordingly.
package render

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// model (mirrors @hc/timeline's VideoProject JSON)
// ---------------------------------------------------------------------------

type TimelineTransition struct {
	Type           string  `json:"type"`
	DurationFrames float64 `json:"durationFrames"`
	Color          string  `json:"color"`
	// Direction for slide/wipe (P4.7): "left" | "right" | "up" | "down". Empty =
	// the legacy horizontal behavior. Mirrors @hc/timeline ClipTransition.
	Direction string `json:"direction"`
}

type TimelineTitle struct {
	Text       string  `json:"text"`
	SizePct    float64 `json:"sizePct"`
	Color      string  `json:"color"`
	Background string  `json:"background"`
	Position   string  `json:"position"`
	OffsetX    float64 `json:"offsetX"`
	OffsetY    float64 `json:"offsetY"`
	Weight     string  `json:"weight"`
}

// TimelineColor mirrors the clip's optional color adjustments. Brightness,
// contrast, and saturation are pointers because absent means neutral (1)
// while an explicit 0 saturation (grayscale) is meaningful.
type TimelineColor struct {
	Brightness  *float64 `json:"brightness"`
	Contrast    *float64 `json:"contrast"`
	Saturation  *float64 `json:"saturation"`
	Temperature float64  `json:"temperature"`
}

type TimelineRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type TimelineClip struct {
	ID            string              `json:"id"`
	AssetID       string              `json:"assetId"`
	Disabled      bool                `json:"disabled"`
	Crop          *TimelineRect       `json:"crop"`
	StartFrame    float64             `json:"startFrame"`
	InFrame       float64             `json:"inFrame"`
	OutFrame      float64             `json:"outFrame"`
	Speed         float64             `json:"speed"`
	Fit           string              `json:"fit"`
	Opacity       *float64            `json:"opacity"`
	RotationDeg   float64             `json:"rotationDeg"`
	Color         *TimelineColor      `json:"color"`
	TransitionIn  *TimelineTransition `json:"transitionIn"`
	TransitionOut *TimelineTransition `json:"transitionOut"`
	FadeInFrames  float64             `json:"fadeInFrames"`
	FadeOutFrames float64             `json:"fadeOutFrames"`
	AudioGainDb   float64             `json:"audioGainDb"`
	Title         *TimelineTitle      `json:"title"`
	SequenceID    string              `json:"sequenceId"`
	// Element is an embedded footage-free design node (image/shape/text/group)
	// this clip renders onto the stage, authored in stage coordinates. It is
	// rasterized to a PNG (staged by the caller into opts.ElementFiles) and
	// composited like a looped image overlay, matching the browser preview.
	Element map[string]any `json:"element"`
}

type TimelineTrack struct {
	ID     string  `json:"id"`
	Kind   string  `json:"kind"`
	Muted  bool    `json:"muted"`
	Solo   bool    `json:"solo"`
	Hidden bool    `json:"hidden"`
	GainDb float64 `json:"gainDb"`
	// -1 (left) .. 1 (right); 0 = center.
	Pan   float64        `json:"pan"`
	Clips []TimelineClip `json:"clips"`
}

type TimelineCue struct {
	StartFrame float64 `json:"startFrame"`
	EndFrame   float64 `json:"endFrame"`
	Text       string  `json:"text"`
}

type TimelineCaptions struct {
	Style map[string]any `json:"style"`
	Cues  []TimelineCue  `json:"cues"`
}

type TimelineDucking struct {
	MusicTrackID string  `json:"musicTrackId"`
	VoiceTrackID string  `json:"voiceTrackId"`
	AmountDb     float64 `json:"amountDb"`
	AttackMs     float64 `json:"attackMs"`
	ReleaseMs    float64 `json:"releaseMs"`
}

type TimelineMaster struct {
	GainDb  float64          `json:"gainDb"`
	Ducking *TimelineDucking `json:"ducking"`
}

type TimelineProject struct {
	Stage struct {
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"stage"`
	Background     string             `json:"background"`
	Fps            float64            `json:"fps"`
	DurationFrames float64            `json:"durationFrames"`
	Tracks         []TimelineTrack    `json:"tracks"`
	Master         TimelineMaster     `json:"master"`
	Captions       []TimelineCaptions `json:"captions"`
}

// ParseSequences extracts the nested-sequence map (meta.videoSequences).
func ParseSequences(meta map[string]any) map[string]*TimelineProject {
	out := map[string]*TimelineProject{}
	raw, ok := meta["videoSequences"]
	if !ok {
		return out
	}
	buf, err := json.Marshal(raw)
	if err != nil {
		return out
	}
	var m map[string]*TimelineProject
	if err := json.Unmarshal(buf, &m); err != nil {
		return out
	}
	for id, p := range m {
		if p != nil && p.Fps > 0 {
			out[id] = p
		}
	}
	return out
}

// FlattenSequences projects every nested-sequence clip's child timeline into
// the parent's coordinates so the single-graph renderer needs no recursion:
// child tracks become synthesized parent tracks inserted right after the
// track holding the sequence clip (matching the preview's stacking), child
// clips are trimmed to the parent clip's source window, speeds compose, and
// the parent clip's gain plus the child track/master gains fold into each
// clip's gain. Reverse-speed sequence clips are skipped (unsupported).
func FlattenSequences(p *TimelineProject, sequences map[string]*TimelineProject, depth int) *TimelineProject {
	if depth > 16 || len(sequences) == 0 {
		return p
	}
	out := *p
	out.Tracks = nil
	for _, t := range p.Tracks {
		kept := t
		kept.Clips = nil
		var synthesized []TimelineTrack
		for _, c := range t.Clips {
			if c.SequenceID == "" {
				kept.Clips = append(kept.Clips, c)
				continue
			}
			child := sequences[c.SequenceID]
			if child == nil || c.Speed < 0 {
				continue // unknown or reverse sequence: renders nothing
			}
			flat := FlattenSequences(child, sequences, depth+1)
			pSpeed := c.speedMag()
			fpsRatio := p.Fps / flat.Fps // child frames -> parent frames
			for _, ct := range flat.Tracks {
				if !audible(ct, flat.Tracks) && ct.Kind == "audio" {
					continue
				}
				synth := TimelineTrack{
					ID:     t.ID + "/" + c.ID + "/" + ct.ID,
					Kind:   ct.Kind,
					Hidden: t.Hidden || ct.Hidden,
					GainDb: 0, // folded into clip gains below
				}
				for _, cc := range ct.Clips {
					if cc.SequenceID != "" {
						continue // grandchildren were already flattened into flat
					}
					ccStart := cc.StartFrame
					ccEnd := cc.endFrame()
					visStart := math.Max(ccStart, c.InFrame)
					visEnd := math.Min(ccEnd, c.OutFrame)
					if visEnd-visStart < 0.5 {
						continue
					}
					ccMag := cc.speedMag()
					nc := cc
					// Trim the child clip's source window to the visible span.
					nc.InFrame = cc.InFrame + (visStart-ccStart)*ccMag
					nc.OutFrame = nc.InFrame + (visEnd-visStart)*ccMag
					// Project onto the parent timeline (speed + fps composition).
					nc.StartFrame = c.StartFrame + ((visStart-c.InFrame)/pSpeed)*fpsRatio
					sign := 1.0
					if cc.Speed < 0 {
						sign = -1
					}
					nc.Speed = sign * ccMag * pSpeed / fpsRatio
					// Fold the gain chain (dB adds): child track + child master +
					// the parent sequence clip's own gain.
					nc.AudioGainDb += ct.GainDb + flat.Master.GainDb + c.AudioGainDb
					synth.Clips = append(synth.Clips, nc)
				}
				if len(synth.Clips) > 0 {
					synthesized = append(synthesized, synth)
				}
			}
		}
		out.Tracks = append(out.Tracks, kept)
		out.Tracks = append(out.Tracks, synthesized...)
	}
	return &out
}

// ParseTimeline extracts the VideoProject from a design's meta map.
func ParseTimeline(meta map[string]any) (*TimelineProject, error) {
	raw, ok := meta["video"]
	if !ok {
		return nil, errors.New("design has no video timeline")
	}
	buf, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var p TimelineProject
	if err := json.Unmarshal(buf, &p); err != nil {
		return nil, err
	}
	if p.Fps <= 0 {
		p.Fps = 30
	}
	if p.Stage.Width <= 0 || p.Stage.Height <= 0 {
		return nil, errors.New("timeline has no stage size")
	}
	return &p, nil
}

// ---------------------------------------------------------------------------
// filter graph
// ---------------------------------------------------------------------------

// TimelineOptions are the export knobs (mirroring the legacy static export).
type TimelineOptions struct {
	Scale  float64 // stage multiplier (default 1)
	CRF    int     // default 20
	Preset string  // default "medium"
	// DrawText enables title/caption burn-in; RenderTimeline probes the ffmpeg
	// build for the drawtext filter (absent on builds without libfreetype) and
	// omits text overlays rather than failing the whole export.
	DrawText bool
	// ColorTemp enables the colortemperature filter for clip temperature
	// adjustments; probed like DrawText and simply omitted when absent.
	ColorTemp bool
	// Optional export range in timeline frames (0/0 = whole timeline),
	// applied with output seeking so all graph timings stay absolute.
	RangeStartFrame float64
	RangeEndFrame   float64
	// Format selects the container/codec: "mp4" (default), "webm"
	// (VP9/Opus), "gif" (palette two-stage, capped at 15fps, no audio), or
	// "mp3" (audio only; the video graph is skipped entirely).
	Format string
	// OutFps overrides the OUTPUT frame rate only (duplicating/dropping
	// frames); 0 keeps the project fps. Timeline timing math always uses the
	// project fps.
	OutFps float64
	// SkipCaptions leaves caption burn-in out even when DrawText is available.
	SkipCaptions bool
	// StemTrackID renders ONLY this track's audio (pre-master, no ducking):
	// per-track stems for the mp3 format.
	StemTrackID string
	// ElementFiles maps a clip id to a staged PNG path for its embedded design
	// element (Clip.element), rasterized by the caller. Element clips whose id
	// is absent here are skipped (no I/O happens inside the arg builder).
	ElementFiles map[string]string
	// ElementSeqs maps a clip id to a staged PNG SEQUENCE for an ANIMATED element
	// (each frame posed at its clip-local time by the caller), overlaid so the
	// server MP4 animates the element exactly like the browser preview. Takes
	// precedence over ElementFiles for the same clip id.
	ElementSeqs map[string]ElementSeq
}

// ElementSeq is a staged, posed PNG sequence for one animated element clip.
type ElementSeq struct {
	// Pattern is an ffmpeg image2 input pattern, e.g. ".../f_%05d.png".
	Pattern string
	// Frames is the number of frames written (0..Frames-1).
	Frames int
	// Fps is the rate the frames were posed at (the sequence's native rate).
	Fps float64
}

func (c *TimelineClip) speedMag() float64 {
	s := math.Abs(c.Speed)
	if s < 0.01 {
		return 1
	}
	return s
}

// timeline duration of the clip in frames (source span / |speed|).
func (c *TimelineClip) durFrames() float64 {
	return (c.OutFrame - c.InFrame) / c.speedMag()
}

func (c *TimelineClip) endFrame() float64 { return c.StartFrame + c.durFrames() }

func dbToLinear(db float64) float64 { return math.Pow(10, db/20) }

// soloActive reports whether any audio-bearing track is soloed.
func soloActive(tracks []TimelineTrack) bool {
	for _, t := range tracks {
		if t.Solo {
			return true
		}
	}
	return false
}

func audible(t TimelineTrack, tracks []TimelineTrack) bool {
	if t.Muted {
		return false
	}
	if soloActive(tracks) {
		return t.Solo
	}
	return true
}

// atempoChain composes atempo stages (each limited to [0.5, 2]) for a speed.
func atempoChain(speed float64) []string {
	var out []string
	s := speed
	for s > 2 {
		out = append(out, "atempo=2.0")
		s /= 2
	}
	for s < 0.5 {
		out = append(out, "atempo=0.5")
		s /= 0.5
	}
	if math.Abs(s-1) > 0.001 {
		out = append(out, fmt.Sprintf("atempo=%.4f", s))
	}
	return out
}

// escapeDrawtext escapes a single line for a drawtext text='...' value inside
// a filter graph (expansion is disabled at the call site).
func escapeDrawtext(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `'`, `'\''`)
	s = strings.ReplaceAll(s, `:`, `\:`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	return s
}

// fadeFilters builds the ffmpeg fade filter(s) for one transition edge on a clip
// of length clipDurS seconds: the fade family fades alpha; dipToColor fades
// through a color; SLIDE is position-only (handled by the overlay x-expression,
// see slideOverlayX) so it adds no alpha fade here; WIPE still approximates as a
// fade (a faithful per-pixel reveal is a follow-up). Empty when the transition is
// absent. Shared by media clips and element clips.
func fadeFilters(tr *TimelineTransition, edge string, clipDurS, fps float64) []string {
	if tr == nil || tr.DurationFrames < 1 {
		return nil
	}
	if tr.Type == "slide" {
		return nil // rendered by moving the overlay, not by fading alpha
	}
	d := math.Min(tr.DurationFrames/fps, clipDurS)
	st := 0.0
	if edge == "out" {
		st = clipDurS - d
	}
	t := "in"
	if edge == "out" {
		t = "out"
	}
	if tr.Type == "dipToColor" {
		return []string{fmt.Sprintf("fade=t=%s:st=%.4f:d=%.4f:c=%s", t, st, d, cssColorToFF(tr.Color, "black"))}
	}
	return []string{fmt.Sprintf("fade=t=%s:st=%.4f:d=%.4f:alpha=1", t, st, d)}
}

// slideOverlayXY returns the ffmpeg overlay x/y expressions (functions of the
// absolute output time t) for a clip's slide transitions, matching the browser
// compositor. Legacy (no direction): in enters from the left (x: -W -> 0), out
// exits to the right (x: 0 -> +W). Directional: the clip enters from `direction`
// and exits back to it, along x (left/right) or y (up/down). Returns ("0","0")
// when neither edge slides. Commas inside the if() are escaped for the filtergraph.
func slideOverlayXY(c TimelineClip, W, H, startS, clipDurS, fps float64) (string, string) {
	x, y := "0", "0"
	endS := startS + clipDurS
	apply := func(edge string, tr *TimelineTransition) {
		if tr == nil || tr.Type != "slide" || tr.DurationFrames < 1 {
			return
		}
		d := math.Min(tr.DurationFrames/fps, clipDurS)
		// "presence" f in [0,1] (1 = settled) and the window guard condition.
		var f, cond string
		if edge == "in" {
			f = fmt.Sprintf("((t-%.4f)/%.4f)", startS, d)
			cond = fmt.Sprintf("lt(t\\,%.4f)", startS+d)
		} else {
			f = fmt.Sprintf("((%.4f-t)/%.4f)", endS, d)
			cond = fmt.Sprintf("gt(t\\,%.4f)", endS-d)
		}
		wrap := func(prev, amount string) string { return fmt.Sprintf("if(%s\\,%s\\,%s)", cond, amount, prev) }
		switch tr.Direction {
		case "": // legacy horizontal: in slideX=f-1, out slideX=1-f
			if edge == "in" {
				x = wrap(x, fmt.Sprintf("%.2f*(%s-1)", W, f))
			} else {
				x = wrap(x, fmt.Sprintf("%.2f*(1-%s)", W, f))
			}
		case "left":
			x = wrap(x, fmt.Sprintf("%.2f*(%s-1)", W, f))
		case "right":
			x = wrap(x, fmt.Sprintf("%.2f*(1-%s)", W, f))
		case "up":
			y = wrap(y, fmt.Sprintf("%.2f*(%s-1)", H, f))
		case "down":
			y = wrap(y, fmt.Sprintf("%.2f*(1-%s)", H, f))
		}
	}
	// Apply out first so the in-window guard wraps outermost (checked first).
	apply("out", c.TransitionOut)
	apply("in", c.TransitionIn)
	return x, y
}

// cssColorToFF maps the subset of CSS colors the editor writes (hex and
// rgba()) to ffmpeg color syntax; anything unparseable falls back to black.
func cssColorToFF(css string, fallback string) string {
	css = strings.TrimSpace(css)
	if css == "" {
		return fallback
	}
	if strings.HasPrefix(css, "#") {
		return "0x" + strings.TrimPrefix(css, "#")
	}
	if strings.HasPrefix(css, "rgba(") || strings.HasPrefix(css, "rgb(") {
		inner := css[strings.Index(css, "(")+1 : strings.LastIndex(css, ")")]
		parts := strings.Split(inner, ",")
		if len(parts) >= 3 {
			var r, g, b int
			var a float64 = 1
			fmt.Sscanf(strings.TrimSpace(parts[0]), "%d", &r)
			fmt.Sscanf(strings.TrimSpace(parts[1]), "%d", &g)
			fmt.Sscanf(strings.TrimSpace(parts[2]), "%d", &b)
			if len(parts) >= 4 {
				fmt.Sscanf(strings.TrimSpace(parts[3]), "%f", &a)
			}
			return fmt.Sprintf("0x%02X%02X%02X@%.2f", r, g, b, a)
		}
	}
	return fallback
}

// StagedAsset is one media file staged for the render, with its probed
// stream availability so the graph never references a missing stream.
type StagedAsset struct {
	Path     string
	HasVideo bool
	HasAudio bool
}

// BuildTimelineArgs constructs the full ffmpeg argument list. assetFile maps
// an assetId to a staged local file; clips whose asset is missing are skipped
// (the render is best-effort per clip, never fails the whole export because
// one asset vanished).
// applyXfadeTails mirrors the browser compositor's overlap trick for authored
// cross-dissolve pairs at an exact cut: the LEFT clip's source window extends
// past the cut at full alpha (its out-fade dropped) while the RIGHT clip keeps
// its fade-in on top, so the composite is a true crossfade instead of a dip
// through the background.
func applyXfadeTails(p *TimelineProject) *TimelineProject {
	out := *p
	out.Tracks = make([]TimelineTrack, len(p.Tracks))
	for ti, t := range p.Tracks {
		nt := t
		nt.Clips = append([]TimelineClip(nil), t.Clips...)
		for i := range nt.Clips {
			left := &nt.Clips[i]
			if left.TransitionOut == nil || left.TransitionOut.Type != "crossDissolve" || left.Speed < 0 {
				continue
			}
			leftEnd := left.endFrame()
			for j := range nt.Clips {
				if i == j {
					continue
				}
				right := &nt.Clips[j]
				if right.TransitionIn == nil || right.TransitionIn.Type != "crossDissolve" {
					continue
				}
				if math.Abs(right.StartFrame-leftEnd) > 0.5 {
					continue
				}
				window := math.Min(left.TransitionOut.DurationFrames, right.TransitionIn.DurationFrames)
				if window < 1 {
					continue
				}
				// Extend the left clip's source past the cut by the window
				// (ffmpeg simply ends early if the media runs out) and drop
				// its own fade so it holds at full alpha under the fade-in.
				left.OutFrame += window * left.speedMag()
				left.TransitionOut = nil
				break
			}
		}
		out.Tracks[ti] = nt
	}
	return &out
}

func BuildTimelineArgs(p *TimelineProject, assetFile func(assetID string) (StagedAsset, bool), opts TimelineOptions, outPath string) ([]string, error) {
	p = applyXfadeTails(p)
	if opts.Scale <= 0 {
		opts.Scale = 1
	}
	if opts.CRF <= 0 || opts.CRF > 51 {
		opts.CRF = 20
	}
	if opts.Preset == "" {
		opts.Preset = "medium"
	}
	format := opts.Format
	if format == "" {
		format = "mp4"
	}
	if format == "webm" && opts.CRF == 0 {
		opts.CRF = 32 // VP9's CRF scale runs higher than x264's
	}
	fps := p.Fps
	// Even dimensions for yuv420p.
	W := int(math.Round(p.Stage.Width*opts.Scale/2)) * 2
	H := int(math.Round(p.Stage.Height*opts.Scale/2)) * 2
	if W < 2 || H < 2 {
		return nil, errors.New("stage too small")
	}

	// Total duration: the max clip end across tracks (>= 1 frame).
	durF := p.DurationFrames
	for _, t := range p.Tracks {
		for _, c := range t.Clips {
			if e := c.endFrame(); e > durF {
				durF = e
			}
		}
	}
	if durF < 1 {
		durF = fps
	}
	durS := durF / fps

	// Stage inputs: one -i per unique asset actually referenced.
	inputIdx := map[string]int{}
	staged := map[string]StagedAsset{}
	var args []string
	// Shared ffmpeg input index: media (-i) and element images (-loop 1 -i) draw
	// from the same counter so overlay stream refs stay correct.
	nInputs := 0
	addInput := func(assetID string) (int, StagedAsset, bool) {
		if idx, ok := inputIdx[assetID]; ok {
			return idx, staged[assetID], true
		}
		sa, ok := assetFile(assetID)
		if !ok {
			return 0, StagedAsset{}, false
		}
		idx := nInputs
		nInputs++
		inputIdx[assetID] = idx
		staged[assetID] = sa
		args = append(args, "-i", sa.Path)
		return idx, sa, true
	}

	var fc []string
	label := 0
	next := func(prefix string) string {
		label++
		return fmt.Sprintf("[%s%d]", prefix, label)
	}

	// Base canvas (the project's stage background; black by default). An
	// audio-only export skips the whole video graph: nothing composites,
	// nothing decodes needlessly.
	base := "[base]"
	if format != "mp3" {
		fc = append(fc, fmt.Sprintf("color=c=%s:s=%dx%d:r=%g:d=%.4f%s", cssColorToFF(p.Background, "black"), W, H, fps, durS, base))
	}

	// --- video compositing, track order = stacking order ------------------
	current := base
	videoTracks := p.Tracks
	if format == "mp3" {
		videoTracks = nil
	}
	for _, t := range videoTracks {
		if t.Kind != "video" && t.Kind != "overlay" || t.Hidden {
			continue
		}
		clips := append([]TimelineClip(nil), t.Clips...)
		sort.Slice(clips, func(i, j int) bool { return clips[i].StartFrame < clips[j].StartFrame })
		for _, c := range clips {
			if c.Disabled {
				continue
			}
			// Footage-free design element. An ANIMATED element is a posed PNG
			// sequence (each frame baked at its clip-local time), so its motion
			// lives in the pixels; a static element is a single looped PNG. Both
			// composite like a video overlay (matching the browser preview path).
			if c.Element != nil {
				seq, hasSeq := opts.ElementSeqs[c.ID]
				path, hasPath := opts.ElementFiles[c.ID]
				if (!hasSeq || seq.Frames <= 0) && (!hasPath || path == "") {
					continue
				}
				idx := nInputs
				nInputs++
				if hasSeq && seq.Frames > 0 {
					seqFps := seq.Fps
					if seqFps <= 0 {
						seqFps = fps
					}
					args = append(args, "-framerate", fmt.Sprintf("%g", seqFps), "-start_number", "0", "-i", seq.Pattern)
				} else {
					args = append(args, "-loop", "1", "-i", path)
				}
				startS := c.StartFrame / fps
				clipDurS := c.durFrames() / fps
				chain := []string{
					fmt.Sprintf("[%d:v]scale=%d:%d", idx, W, H),
					fmt.Sprintf("fps=%g", fps),
					fmt.Sprintf("trim=start=0:end=%.4f", clipDurS),
					"setpts=PTS-STARTPTS",
					"format=yuva420p",
				}
				if c.Opacity != nil && *c.Opacity < 1 {
					chain = append(chain, fmt.Sprintf("format=rgba,colorchannelmixer=aa=%.4f,format=yuva420p", math.Max(0, *c.Opacity)))
				}
				chain = append(chain, fadeFilters(c.TransitionIn, "in", clipDurS, fps)...)
				chain = append(chain, fadeFilters(c.TransitionOut, "out", clipDurS, fps)...)
				chain = append(chain, fmt.Sprintf("setpts=PTS+%.4f/TB", startS))
				v := next("v")
				fc = append(fc, strings.Join(chain, ",")+v)
				out := next("o")
				xExpr, yExpr := slideOverlayXY(c, float64(W), float64(H), startS, clipDurS, fps)
				fc = append(fc, fmt.Sprintf("%s%soverlay=x=%s:y=%s:eof_action=pass%s", current, v, xExpr, yExpr, out))
				current = out
				continue
			}
			if c.AssetID == "" {
				continue
			}
			idx, sa, ok := addInput(c.AssetID)
			if !ok || !sa.HasVideo {
				continue
			}
			inS := c.InFrame / fps
			outS := c.OutFrame / fps
			startS := c.StartFrame / fps
			clipDurS := c.durFrames() / fps
			chain := []string{fmt.Sprintf("[%d:v]trim=start=%.4f:end=%.4f", idx, inS, outS)}
			if c.Speed < 0 {
				chain = append(chain, "reverse")
			}
			chain = append(chain, fmt.Sprintf("setpts=(PTS-STARTPTS)/%.4f", c.speedMag()))
			// Source crop (media pixels) before any scaling, matching the
			// browser compositor's source-rect draw.
			if c.Crop != nil && c.Crop.Width >= 8 && c.Crop.Height >= 8 {
				chain = append(chain, fmt.Sprintf("crop=%d:%d:%d:%d",
					int(c.Crop.Width), int(c.Crop.Height), int(math.Max(0, c.Crop.X)), int(math.Max(0, c.Crop.Y))))
			}
			contain := c.Fit == "contain"
			if contain {
				chain = append(chain, fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease", W, H))
			} else {
				chain = append(chain,
					fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=increase", W, H),
					fmt.Sprintf("crop=%d:%d", W, H),
				)
			}
			chain = append(chain, fmt.Sprintf("fps=%g", fps))
			// Color adjustments. eq mirrors the browser compositor approximately:
			// CSS-style multiplicative brightness maps onto eq's additive
			// brightness so the two match at mid-gray; contrast and saturation
			// share the same pivot-based definition on both sides.
			if c.Color != nil {
				b, ct, s := 1.0, 1.0, 1.0
				if c.Color.Brightness != nil {
					b = *c.Color.Brightness
				}
				if c.Color.Contrast != nil {
					ct = *c.Color.Contrast
				}
				if c.Color.Saturation != nil {
					s = *c.Color.Saturation
				}
				if b != 1 || ct != 1 || s != 1 {
					chain = append(chain, fmt.Sprintf("eq=brightness=%.4f:contrast=%.4f:saturation=%.4f",
						math.Max(-1, math.Min(1, (b-1)*0.5)), math.Max(0, math.Min(3, ct)), math.Max(0, math.Min(3, s))))
				}
				if c.Color.Temperature != 0 && opts.ColorTemp {
					chain = append(chain, fmt.Sprintf("colortemperature=temperature=%.0f", 6500-c.Color.Temperature*2500))
				}
			}
			chain = append(chain, "format=yuva420p")
			// Contain letterboxes with TRANSPARENT bars so lower tracks (and the
			// stage background) show through, matching the browser compositor.
			if contain {
				chain = append(chain, fmt.Sprintf("pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black@0", W, H))
			}
			if c.RotationDeg != 0 {
				chain = append(chain, fmt.Sprintf("rotate=%.6f:c=black@0", c.RotationDeg*math.Pi/180))
			}
			if c.Opacity != nil && *c.Opacity < 1 {
				chain = append(chain, fmt.Sprintf("format=rgba,colorchannelmixer=aa=%.4f,format=yuva420p", math.Max(0, *c.Opacity)))
			}
			// Transitions: fade family via alpha; dipToColor fades through the
			// color; wipe/slide approximate as fades (documented).
			chain = append(chain, fadeFilters(c.TransitionIn, "in", clipDurS, fps)...)
			chain = append(chain, fadeFilters(c.TransitionOut, "out", clipDurS, fps)...)
			chain = append(chain, fmt.Sprintf("setpts=PTS+%.4f/TB", startS))
			v := next("v")
			fc = append(fc, strings.Join(chain, ",")+v)
			out := next("o")
			xExpr, yExpr := slideOverlayXY(c, float64(W), float64(H), startS, clipDurS, fps)
			fc = append(fc, fmt.Sprintf("%s%soverlay=x=%s:y=%s:eof_action=pass%s", current, v, xExpr, yExpr, out))
			current = out
		}
	}

	// --- titles (text tracks) ---------------------------------------------
	drawtexts := []string{}
	textTracks := p.Tracks
	if !opts.DrawText || format == "mp3" {
		textTracks = nil
	}
	for _, t := range textTracks {
		if t.Kind != "text" || t.Hidden {
			continue
		}
		for _, c := range t.Clips {
			if c.Disabled || c.Title == nil || strings.TrimSpace(c.Title.Text) == "" {
				continue
			}
			sizePct := c.Title.SizePct
			if sizePct <= 0 {
				sizePct = 0.07
			}
			fontPx := int(math.Max(10, math.Round(float64(H)*sizePct)))
			lineH := int(math.Round(float64(fontPx) * 1.25))
			lines := strings.Split(c.Title.Text, "\n")
			pos := c.Title.Position
			var lastBaseTop int // top of the LAST line's box
			blockH := lineH * (len(lines) - 1)
			switch pos {
			case "top":
				lastBaseTop = int(float64(H)*0.1) + blockH
			case "lower-third":
				lastBaseTop = int(float64(H)*0.8) - fontPx
			default:
				lastBaseTop = (H-fontPx)/2 + blockH/2
			}
			startS := c.StartFrame / fps
			endS := c.endFrame() / fps
			color := cssColorToFF(c.Title.Color, "white")
			offX := int(c.Title.OffsetX * float64(W))
			offY := int(c.Title.OffsetY * float64(H))
			for i := len(lines) - 1; i >= 0; i-- {
				y := lastBaseTop - (len(lines)-1-i)*lineH + offY
				dt := fmt.Sprintf(
					"drawtext=font=Sans:text='%s':fontsize=%d:fontcolor=%s:x=(w-text_w)/2+%d:y=%d:expansion=none:enable='between(t,%.4f,%.4f)'",
					escapeDrawtext(lines[i]), fontPx, color, offX, y, startS, endS)
				if c.Title.Background != "" {
					dt += fmt.Sprintf(":box=1:boxcolor=%s:boxborderw=%d", cssColorToFF(c.Title.Background, "black@0.6"), fontPx/3)
				}
				drawtexts = append(drawtexts, dt)
			}
		}
	}

	// --- captions (burn-in honoring the style) ------------------------------
	if opts.DrawText && !opts.SkipCaptions && format != "mp3" && len(p.Captions) > 0 {
		cap := p.Captions[0]
		burnIn := true
		sizePct := 0.045
		color := "white"
		bg := "black@0.65"
		if cap.Style != nil {
			if v, ok := cap.Style["burnIn"].(bool); ok {
				burnIn = v
			}
			if v, ok := cap.Style["sizePct"].(float64); ok && v > 0 {
				sizePct = v
			}
			if v, ok := cap.Style["color"].(string); ok && v != "" {
				color = cssColorToFF(v, "white")
			}
			if v, ok := cap.Style["background"].(string); ok && v != "" {
				bg = cssColorToFF(v, "black@0.65")
			}
		}
		if burnIn {
			fontPx := int(math.Max(12, math.Round(float64(H)*sizePct)))
			y := H - int(float64(H)*0.06) - fontPx
			for _, cue := range cap.Cues {
				if strings.TrimSpace(cue.Text) == "" {
					continue
				}
				for i, line := range strings.Split(cue.Text, "\n") {
					dt := fmt.Sprintf(
						"drawtext=font=Sans:text='%s':fontsize=%d:fontcolor=%s:x=(w-text_w)/2:y=%d:box=1:boxcolor=%s:boxborderw=%d:expansion=none:enable='between(t,%.4f,%.4f)'",
						escapeDrawtext(line), fontPx, color, y+i*int(float64(fontPx)*1.25), bg, fontPx/3,
						cue.StartFrame/fps, cue.EndFrame/fps)
					drawtexts = append(drawtexts, dt)
				}
			}
		}
	}
	if len(drawtexts) > 0 {
		out := next("t")
		fc = append(fc, current+strings.Join(drawtexts, ",")+out)
		current = out
	}
	vout := ""
	if format == "gif" {
		// Palette two-stage for real GIF quality, capped at 15fps for size.
		vout = next("vout")
		fc = append(fc, current+fmt.Sprintf(
			"fps=%g,split[gs0][gs1];[gs0]palettegen=stats_mode=diff[gp];[gs1][gp]paletteuse=dither=bayer:bayer_scale=4",
			math.Min(fps, 15))+vout)
	} else if format != "mp3" {
		vout = next("vout")
		fc = append(fc, current+"format=yuv420p"+vout)
	}

	// --- audio: per-clip chains grouped per track, then duck + master mix ---
	type trackMix struct {
		id    string
		label string
	}
	var trackMixes []trackMix
	audioTracks := p.Tracks
	if format == "gif" {
		audioTracks = nil // a GIF carries no sound; skip the whole mix graph
	}
	if opts.StemTrackID != "" {
		var only []TimelineTrack
		for _, t := range audioTracks {
			if t.ID == opts.StemTrackID {
				only = append(only, t)
			}
		}
		audioTracks = only
	}
	for _, t := range audioTracks {
		if t.Kind != "audio" && t.Kind != "video" && t.Kind != "overlay" {
			continue
		}
		if !audible(t, p.Tracks) {
			continue
		}
		var clipLabels []string
		for _, c := range t.Clips {
			if c.AssetID == "" || c.Disabled {
				continue
			}
			idx, sa, ok := addInput(c.AssetID)
			if !ok || !sa.HasAudio {
				continue
			}
			gain := dbToLinear(c.AudioGainDb) * dbToLinear(t.GainDb)
			if gain <= 0.0001 || c.Speed < 0 {
				continue // silent or reverse (reverse audio muted, like preview)
			}
			inS := c.InFrame / fps
			outS := c.OutFrame / fps
			clipDurS := c.durFrames() / fps
			chain := []string{fmt.Sprintf("[%d:a]atrim=start=%.4f:end=%.4f", idx, inS, outS), "asetpts=PTS-STARTPTS"}
			chain = append(chain, atempoChain(c.speedMag())...)
			if c.FadeInFrames >= 1 {
				chain = append(chain, fmt.Sprintf("afade=t=in:st=0:d=%.4f", c.FadeInFrames/fps))
			}
			if c.FadeOutFrames >= 1 {
				d := c.FadeOutFrames / fps
				chain = append(chain, fmt.Sprintf("afade=t=out:st=%.4f:d=%.4f", clipDurS-d, d))
			}
			chain = append(chain, fmt.Sprintf("volume=%.4f", gain))
			chain = append(chain, "aresample=44100", fmt.Sprintf("adelay=%d:all=1", int(c.StartFrame/fps*1000)))
			a := next("a")
			fc = append(fc, strings.Join(chain, ",")+a)
			clipLabels = append(clipLabels, a)
		}
		if len(clipLabels) == 0 {
			continue
		}
		mix := next("tm")
		if len(clipLabels) == 1 {
			fc = append(fc, clipLabels[0]+"anull"+mix)
		} else {
			fc = append(fc, strings.Join(clipLabels, "")+fmt.Sprintf("amix=inputs=%d:duration=longest:normalize=0", len(clipLabels))+mix)
		}
		// Track pan: equal-power stereo balance, matching the preview's
		// StereoPanner. pan filter gains: L*=cos(a), R*=sin(a), a=(p+1)*pi/4.
		if t.Pan != 0 {
			pv := math.Max(-1, math.Min(1, t.Pan))
			a := (pv + 1) * math.Pi / 4
			panned := next("pn")
			fc = append(fc, mix+fmt.Sprintf("pan=stereo|c0=%.4f*c0|c1=%.4f*c1", math.Sqrt2*math.Cos(a), math.Sqrt2*math.Sin(a))+panned)
			mix = panned
		}
		trackMixes = append(trackMixes, trackMix{id: t.ID, label: mix})
	}

	var aout string
	if format == "gif" {
		// no audio stream at all
	} else if len(trackMixes) == 0 {
		if format == "mp3" {
			return nil, errors.New("the timeline has no audible audio to export")
		}
		aout = next("aout")
		fc = append(fc, fmt.Sprintf("anullsrc=r=44100:cl=stereo:d=%.4f%s", durS, aout))
	} else {
		// Sidechain ducking: compress the music track's mix keyed by the voice
		// track's mix, mirroring the preview's automation behavior. Stems are
		// pre-master: no ducking, no master gain.
		if d := p.Master.Ducking; d != nil && opts.StemTrackID == "" {
			var musicIdx, voiceIdx = -1, -1
			for i, tm := range trackMixes {
				if tm.id == d.MusicTrackID {
					musicIdx = i
				}
				if tm.id == d.VoiceTrackID {
					voiceIdx = i
				}
			}
			if musicIdx >= 0 && voiceIdx >= 0 {
				split1 := next("sc")
				split2 := next("sc")
				fc = append(fc, trackMixes[voiceIdx].label+fmt.Sprintf("asplit=2%s%s", split1, split2))
				ducked := next("dk")
				ratio := math.Min(20, math.Max(1, -d.AmountDb))
				fc = append(fc, fmt.Sprintf("%s%ssidechaincompress=threshold=0.02:ratio=%.1f:attack=%.0f:release=%.0f%s",
					trackMixes[musicIdx].label, split1, ratio, math.Max(1, d.AttackMs), math.Max(1, d.ReleaseMs), ducked))
				trackMixes[musicIdx].label = ducked
				trackMixes[voiceIdx].label = split2
			}
		}
		if len(trackMixes) == 1 {
			aout = trackMixes[0].label
		} else {
			var labels []string
			for _, tm := range trackMixes {
				labels = append(labels, tm.label)
			}
			aout = next("am")
			fc = append(fc, strings.Join(labels, "")+fmt.Sprintf("amix=inputs=%d:duration=longest:normalize=0", len(labels))+aout)
		}
		if math.Abs(p.Master.GainDb) > 0.01 && opts.StemTrackID == "" {
			m := next("mg")
			fc = append(fc, aout+fmt.Sprintf("volume=%.4f", dbToLinear(p.Master.GainDb))+m)
			aout = m
		}
	}

	// Range: output-side seek keeps every enable/adelay expression absolute.
	outStart := 0.0
	outEnd := durS
	if opts.RangeEndFrame > opts.RangeStartFrame && opts.RangeStartFrame >= 0 {
		outStart = opts.RangeStartFrame / fps
		outEnd = math.Min(durS, opts.RangeEndFrame/fps)
	}
	outFps := fps
	if opts.OutFps > 0 {
		outFps = opts.OutFps
	}
	args = append(args, "-filter_complex", strings.Join(fc, ";"))
	switch format {
	case "webm":
		args = append(args,
			"-map", vout,
			"-map", aout,
			"-ss", fmt.Sprintf("%.4f", outStart),
			"-t", fmt.Sprintf("%.4f", outEnd-outStart),
			"-r", fmt.Sprintf("%g", outFps),
			"-c:v", "libvpx-vp9",
			"-crf", fmt.Sprintf("%d", opts.CRF),
			"-b:v", "0",
			"-row-mt", "1",
			"-deadline", "good",
			"-cpu-used", "4", // realtime-ish encode; default 0 is minutes-per-second slow
			"-c:a", "libopus",
			"-b:a", "128k",
			"-f", "webm",
			"-y", outPath,
		)
	case "gif":
		args = append(args,
			"-map", vout,
			"-ss", fmt.Sprintf("%.4f", outStart),
			"-t", fmt.Sprintf("%.4f", outEnd-outStart),
			"-f", "gif",
			"-y", outPath,
		)
	case "mp3":
		args = append(args,
			"-map", aout,
			"-ss", fmt.Sprintf("%.4f", outStart),
			"-t", fmt.Sprintf("%.4f", outEnd-outStart),
			"-vn",
			"-c:a", "libmp3lame",
			"-b:a", "192k",
			"-f", "mp3",
			"-y", outPath,
		)
	default:
		args = append(args,
			"-map", vout,
			"-map", aout,
			"-ss", fmt.Sprintf("%.4f", outStart),
			"-t", fmt.Sprintf("%.4f", outEnd-outStart),
			"-r", fmt.Sprintf("%g", outFps),
			"-c:v", "libx264",
			"-crf", fmt.Sprintf("%d", opts.CRF),
			"-preset", opts.Preset,
			"-pix_fmt", "yuv420p",
			"-c:a", "aac",
			"-b:a", "192k",
			"-movflags", "+faststart",
			"-y", outPath,
		)
	}
	return args, nil
}

// ffmpegHasFilter reports whether the ffmpeg build ships a filter (drawtext
// is missing on builds compiled without libfreetype).
func ffmpegHasFilter(bin, name string) bool {
	out, err := exec.Command(bin, "-hide_banner", "-filters").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), " "+name+" ")
}

// ProbeStreams reports whether a media file carries video/audio streams
// (ffprobe when available; both true otherwise, matching old behavior).
func ProbeStreams(path string) (hasVideo, hasAudio bool) {
	bin, err := exec.LookPath("ffprobe")
	if err != nil {
		return true, true
	}
	out, err := exec.Command(bin, "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path).Output()
	if err != nil {
		return true, true
	}
	s := string(out)
	return strings.Contains(s, "video"), strings.Contains(s, "audio")
}

// RenderTimeline runs ffmpeg on the generated graph and returns the encoded
// bytes (MP4 by default; GIF/MP3 via opts.Format).
func RenderTimeline(ctx context.Context, p *TimelineProject, assetFile func(string) (StagedAsset, bool), opts TimelineOptions) ([]byte, error) {
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, ErrNoFFmpeg
	}
	if !opts.DrawText {
		opts.DrawText = ffmpegHasFilter(bin, "drawtext")
	}
	if !opts.ColorTemp {
		opts.ColorTemp = ffmpegHasFilter(bin, "colortemperature")
	}
	ext := opts.Format
	if ext == "" {
		ext = "mp4"
	}
	tmp, err := os.CreateTemp("", "oc-timeline-*."+ext)
	if err != nil {
		return nil, err
	}
	outPath := tmp.Name()
	_ = tmp.Close()
	defer func() { _ = os.Remove(outPath) }()

	args, err := BuildTimelineArgs(p, assetFile, opts, outPath)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, errors.New("ffmpeg failed: " + tail(stderr.String(), 500))
	}
	return os.ReadFile(outPath)
}
