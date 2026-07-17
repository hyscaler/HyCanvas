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
}

type TimelineTitle struct {
	Text       string  `json:"text"`
	SizePct    float64 `json:"sizePct"`
	Color      string  `json:"color"`
	Background string  `json:"background"`
	Position   string  `json:"position"`
	Weight     string  `json:"weight"`
}

type TimelineClip struct {
	ID            string              `json:"id"`
	AssetID       string              `json:"assetId"`
	StartFrame    float64             `json:"startFrame"`
	InFrame       float64             `json:"inFrame"`
	OutFrame      float64             `json:"outFrame"`
	Speed         float64             `json:"speed"`
	TransitionIn  *TimelineTransition `json:"transitionIn"`
	TransitionOut *TimelineTransition `json:"transitionOut"`
	FadeInFrames  float64             `json:"fadeInFrames"`
	FadeOutFrames float64             `json:"fadeOutFrames"`
	AudioGainDb   float64             `json:"audioGainDb"`
	Title         *TimelineTitle      `json:"title"`
	SequenceID    string              `json:"sequenceId"`
}

type TimelineTrack struct {
	ID     string         `json:"id"`
	Kind   string         `json:"kind"`
	Muted  bool           `json:"muted"`
	Solo   bool           `json:"solo"`
	Hidden bool           `json:"hidden"`
	GainDb float64        `json:"gainDb"`
	Clips  []TimelineClip `json:"clips"`
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
	// Optional export range in timeline frames (0/0 = whole timeline),
	// applied with output seeking so all graph timings stay absolute.
	RangeStartFrame float64
	RangeEndFrame   float64
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
func BuildTimelineArgs(p *TimelineProject, assetFile func(assetID string) (StagedAsset, bool), opts TimelineOptions, outPath string) ([]string, error) {
	if opts.Scale <= 0 {
		opts.Scale = 1
	}
	if opts.CRF <= 0 || opts.CRF > 51 {
		opts.CRF = 20
	}
	if opts.Preset == "" {
		opts.Preset = "medium"
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
	addInput := func(assetID string) (int, StagedAsset, bool) {
		if idx, ok := inputIdx[assetID]; ok {
			return idx, staged[assetID], true
		}
		sa, ok := assetFile(assetID)
		if !ok {
			return 0, StagedAsset{}, false
		}
		idx := len(inputIdx)
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

	// Base canvas.
	base := "[base]"
	fc = append(fc, fmt.Sprintf("color=c=black:s=%dx%d:r=%g:d=%.4f%s", W, H, fps, durS, base))

	// --- video compositing, track order = stacking order ------------------
	current := base
	for _, t := range p.Tracks {
		if t.Kind != "video" && t.Kind != "overlay" || t.Hidden {
			continue
		}
		clips := append([]TimelineClip(nil), t.Clips...)
		sort.Slice(clips, func(i, j int) bool { return clips[i].StartFrame < clips[j].StartFrame })
		for _, c := range clips {
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
			chain = append(chain,
				fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=increase", W, H),
				fmt.Sprintf("crop=%d:%d", W, H),
				fmt.Sprintf("fps=%g", fps),
				"format=yuva420p",
			)
			// Transitions: fade family via alpha; dipToColor fades through the
			// color; wipe/slide approximate as fades (documented).
			addFade := func(tr *TimelineTransition, edge string) {
				if tr == nil || tr.DurationFrames < 1 {
					return
				}
				d := math.Min(tr.DurationFrames/fps, clipDurS)
				st := 0.0
				if edge == "out" {
					st = clipDurS - d
				}
				if tr.Type == "dipToColor" {
					col := cssColorToFF(tr.Color, "black")
					fc := fmt.Sprintf("fade=t=%s:st=%.4f:d=%.4f:c=%s", map[string]string{"in": "in", "out": "out"}[edge], st, d, col)
					chain = append(chain, fc)
				} else {
					chain = append(chain, fmt.Sprintf("fade=t=%s:st=%.4f:d=%.4f:alpha=1", map[string]string{"in": "in", "out": "out"}[edge], st, d))
				}
			}
			addFade(c.TransitionIn, "in")
			addFade(c.TransitionOut, "out")
			chain = append(chain, fmt.Sprintf("setpts=PTS+%.4f/TB", startS))
			v := next("v")
			fc = append(fc, strings.Join(chain, ",")+v)
			out := next("o")
			fc = append(fc, fmt.Sprintf("%s%soverlay=0:0:eof_action=pass%s", current, v, out))
			current = out
		}
	}

	// --- titles (text tracks) ---------------------------------------------
	drawtexts := []string{}
	textTracks := p.Tracks
	if !opts.DrawText {
		textTracks = nil
	}
	for _, t := range textTracks {
		if t.Kind != "text" || t.Hidden {
			continue
		}
		for _, c := range t.Clips {
			if c.Title == nil || strings.TrimSpace(c.Title.Text) == "" {
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
			for i := len(lines) - 1; i >= 0; i-- {
				y := lastBaseTop - (len(lines)-1-i)*lineH
				dt := fmt.Sprintf(
					"drawtext=font=Sans:text='%s':fontsize=%d:fontcolor=%s:x=(w-text_w)/2:y=%d:expansion=none:enable='between(t,%.4f,%.4f)'",
					escapeDrawtext(lines[i]), fontPx, color, y, startS, endS)
				if c.Title.Background != "" {
					dt += fmt.Sprintf(":box=1:boxcolor=%s:boxborderw=%d", cssColorToFF(c.Title.Background, "black@0.6"), fontPx/3)
				}
				drawtexts = append(drawtexts, dt)
			}
		}
	}

	// --- captions (burn-in honoring the style) ------------------------------
	if opts.DrawText && len(p.Captions) > 0 {
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
	vout := next("vout")
	fc = append(fc, current+"format=yuv420p"+vout)

	// --- audio: per-clip chains grouped per track, then duck + master mix ---
	type trackMix struct {
		id    string
		label string
	}
	var trackMixes []trackMix
	for _, t := range p.Tracks {
		if t.Kind != "audio" && t.Kind != "video" {
			continue
		}
		if !audible(t, p.Tracks) {
			continue
		}
		var clipLabels []string
		for _, c := range t.Clips {
			if c.AssetID == "" {
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
		trackMixes = append(trackMixes, trackMix{id: t.ID, label: mix})
	}

	var aout string
	if len(trackMixes) == 0 {
		aout = next("aout")
		fc = append(fc, fmt.Sprintf("anullsrc=r=44100:cl=stereo:d=%.4f%s", durS, aout))
	} else {
		// Sidechain ducking: compress the music track's mix keyed by the voice
		// track's mix, mirroring the preview's automation behavior.
		if d := p.Master.Ducking; d != nil {
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
		if math.Abs(p.Master.GainDb) > 0.01 {
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
	args = append(args,
		"-filter_complex", strings.Join(fc, ";"),
		"-map", vout,
		"-map", aout,
		"-ss", fmt.Sprintf("%.4f", outStart),
		"-t", fmt.Sprintf("%.4f", outEnd-outStart),
		"-r", fmt.Sprintf("%g", fps),
		"-c:v", "libx264",
		"-crf", fmt.Sprintf("%d", opts.CRF),
		"-preset", opts.Preset,
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
		"-b:a", "192k",
		"-movflags", "+faststart",
		"-y", outPath,
	)
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

// RenderTimeline runs ffmpeg on the generated graph and returns the MP4 bytes.
func RenderTimeline(ctx context.Context, p *TimelineProject, assetFile func(string) (StagedAsset, bool), opts TimelineOptions) ([]byte, error) {
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, ErrNoFFmpeg
	}
	if !opts.DrawText {
		opts.DrawText = ffmpegHasFilter(bin, "drawtext")
	}
	tmp, err := os.CreateTemp("", "oc-timeline-*.mp4")
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
