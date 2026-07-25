package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/docexport"
	"hycanvas/backend/internal/jobs"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/render"
	"hycanvas/backend/internal/storage"
	"hycanvas/backend/internal/uploads"
)

// mountExport attaches the async export surface (doc 29 video, doc 31 doc). The
// work runs inline: the POST renders + stores the artifact, records a completed
// job (the client polls GET /jobs/:id), and the matching download route streams
// the stored bytes after re-checking ownership and the design-scoped key.
func mountExport(api chi.Router, p *persistence.Service, store storage.Driver, reg *jobs.Registry, acct *accounts.Service, up *uploads.Service) {
	api.With(requireAuth(acct)).Post("/designs/{id}/export/video", videoExportHandler(p, store, reg, acct, up))
	api.With(requireAuth(acct)).Get("/designs/{id}/export/video/{jobId}/download", exportDownloadHandler(p, store, reg, acct, "video-export"))
	api.With(requireAuth(acct)).Post("/designs/{id}/export/doc", docExportHandler(p, store, reg, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/export/doc/{jobId}/download", exportDownloadHandler(p, store, reg, acct, "doc-export"))
}

func videoExportHandler(p *persistence.Service, store storage.Driver, reg *jobs.Registry, acct *accounts.Service, up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Scale        float64 `json:"scale"`
			CRF          int     `json:"crf"`
			StartFrame   float64 `json:"startFrame"`
			EndFrame     float64 `json:"endFrame"`
			Format       string  `json:"format"`
			Fps          float64 `json:"fps"`
			SkipCaptions bool    `json:"skipCaptions"`
			StemTrackId  string  `json:"stemTrackId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body) // optional knobs
		format, ctype := "mp4", "video/mp4"
		switch body.Format {
		case "", "mp4":
		case "webm":
			format, ctype = "webm", "video/webm"
		case "gif":
			format, ctype = "gif", "image/gif"
		case "mp3":
			format, ctype = "mp3", "audio/mpeg"
		default:
			Problem(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "format must be mp4, webm, gif, or mp3")
			return
		}
		if body.Fps != 0 && (body.Fps < 1 || body.Fps > 120) {
			Problem(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "fps must be between 1 and 120")
			return
		}
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		job := reg.Start(u.ID, "video-export")
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			reg.Fail(job.ID, "load failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}

		// A video document renders its TIMELINE (multi-track ffmpeg graph) as a
		// real background job; every other design keeps the legacy static path.
		meta, _ := loaded.File["meta"].(map[string]any)
		if project, terr := render.ParseTimeline(meta); terr == nil && up != nil {
			// Nested sequences flatten into plain tracks before the graph builds.
			project = render.FlattenSequences(project, render.ParseSequences(meta), 0)
			storeKey := "designs/" + id + "/exports/video-" + job.ID + "." + format
			go func() {
				ctx := context.Background()
				dir, derr := os.MkdirTemp("", "oc-timeline-assets-*")
				if derr != nil {
					reg.Fail(job.ID, "staging failed")
					return
				}
				defer func() { _ = os.RemoveAll(dir) }()
				stagedFiles := map[string]render.StagedAsset{}
				assetFile := func(assetID string) (render.StagedAsset, bool) {
					if sa, ok := stagedFiles[assetID]; ok {
						return sa, true
					}
					data, _, cerr := up.ContentInWorkspace(ctx, ws, assetID)
					if cerr != nil || len(data) == 0 {
						return render.StagedAsset{}, false
					}
					f := filepath.Join(dir, assetID)
					if werr := os.WriteFile(f, data, 0o644); werr != nil {
						return render.StagedAsset{}, false
					}
					hasV, hasA := render.ProbeStreams(f)
					sa := render.StagedAsset{Path: f, HasVideo: hasV, HasAudio: hasA}
					stagedFiles[assetID] = sa
					return sa, true
				}
				// Rasterize footage-free design elements (Clip.element) to staged
				// PNGs the timeline graph composites, so the server MP4 matches the
				// browser preview. A STATIC element is one looped PNG; an ANIMATED
				// element (entrance/exit/emphasis/Ken Burns) is a posed PNG SEQUENCE
				// (each frame baked at its clip-local time via the shared pose math).
				elementFiles := map[string]string{}
				elementSeqs := map[string]render.ElementSeq{}
				seqFps := project.Fps
				if seqFps <= 0 {
					seqFps = 30
				}
				fpsFull := seqFps
				if seqFps > 30 {
					seqFps = 30 // cap the posing rate to bound per-element rasterization
				}
				// embedSrc inlines image node + image/pattern fill bytes for the staged
				// element (deep copy) so the rasterizer renders them; see embedNodeAssets.
				fetch := func(aid string) ([]byte, string, error) { return up.ContentInWorkspace(ctx, ws, aid) }
				embedSrc := func(node map[string]any) map[string]any { return embedNodeAssets(fetch, node) }
				pageWrap := func(node map[string]any) render.Design {
					return render.Design{"pages": []any{map[string]any{
						"width":    project.Stage.Width,
						"height":   project.Stage.Height,
						"children": []any{node},
					}}}
				}
				for _, t := range project.Tracks {
					if t.Kind != "video" && t.Kind != "overlay" {
						continue
					}
					for _, c := range t.Clips {
						if c.Element == nil || c.Disabled {
							continue
						}
						staged := embedSrc(c.Element)
						// Static: a single PNG looped over the clip span.
						if !render.NodeIsAnimated(staged) {
							png, perr := render.ToElementPNG(pageWrap(staged), 0, 1)
							if perr != nil || len(png) == 0 {
								continue
							}
							f := filepath.Join(dir, "element-"+c.ID+".png")
							if os.WriteFile(f, png, 0o644) == nil {
								elementFiles[c.ID] = f
							}
							continue
						}
						// Animated: a posed PNG sequence at seqFps over the clip span.
						durF := c.OutFrame - c.InFrame
						if s := math.Abs(c.Speed); s > 0.01 {
							durF /= s
						}
						if durF < 1 {
							durF = 1
						}
						clipMs := durF / fpsFull * 1000
						frames := int(math.Ceil(durF / fpsFull * seqFps))
						if frames < 1 {
							frames = 1
						}
						if frames > 1800 {
							frames = 1800 // ~60s @ 30fps ceiling
						}
						// Keep the (possibly large) inlined pixels out of the per-frame
						// deep-copy; reattach after posing transform/opacity.
						var srcData any
						poseIn := staged
						if sv, ok := staged["src"]; ok {
							srcData = sv
							lite := make(map[string]any, len(staged))
							for k, v := range staged {
								if k != "src" {
									lite[k] = v
								}
							}
							poseIn = lite
						}
						seqDir := filepath.Join(dir, "elseq-"+c.ID)
						if os.MkdirAll(seqDir, 0o755) != nil {
							continue
						}
						wrote := 0
						for i := 0; i < frames; i++ {
							tMs := float64(i) / seqFps * 1000
							posed := render.PoseElementNode(poseIn, tMs, clipMs)
							if srcData != nil {
								posed["src"] = srcData
							}
							png, perr := render.ToElementPNG(pageWrap(posed), 0, 1)
							if perr != nil || len(png) == 0 {
								break
							}
							if os.WriteFile(filepath.Join(seqDir, fmt.Sprintf("f_%05d.png", i)), png, 0o644) != nil {
								break
							}
							wrote++
						}
						if wrote == frames {
							elementSeqs[c.ID] = render.ElementSeq{Pattern: filepath.Join(seqDir, "f_%05d.png"), Frames: frames, Fps: seqFps}
						} else if png, perr := render.ToElementPNG(pageWrap(staged), 0, 1); perr == nil && len(png) > 0 {
							// Sequence staging failed partway: fall back to a static PNG
							// so the element still renders (without its motion).
							f := filepath.Join(dir, "element-"+c.ID+".png")
							if os.WriteFile(f, png, 0o644) == nil {
								elementFiles[c.ID] = f
							}
						}
					}
				}
				encoded, rerr := render.RenderTimeline(ctx, project, assetFile, render.TimelineOptions{
					Scale: body.Scale, CRF: body.CRF,
					RangeStartFrame: body.StartFrame, RangeEndFrame: body.EndFrame,
					Format: format, OutFps: body.Fps,
					SkipCaptions: body.SkipCaptions, StemTrackID: body.StemTrackId,
					ElementFiles: elementFiles,
					ElementSeqs:  elementSeqs,
				})
				if rerr != nil {
					reg.Fail(job.ID, "encode failed: "+rerr.Error())
					return
				}
				if _, serr := store.Put(storeKey, encoded); serr != nil {
					reg.Fail(job.ID, "store failed")
					return
				}
				reg.Complete(job.ID, map[string]any{"key": storeKey, "format": format},
					&jobs.Blob{Key: storeKey, ContentType: ctype, Filename: "export-" + id + "." + format})
			}()
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}

		mp4, err := render.ToVideo(r.Context(), render.Design(loaded.File), 0,
			render.VideoOptions{FPS: 30, DurationMs: 3000, Scale: 1})
		if err != nil {
			reg.Fail(job.ID, "encode failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		key := "designs/" + id + "/exports/video-" + job.ID + ".mp4"
		if _, err := store.Put(key, mp4); err != nil {
			reg.Fail(job.ID, "store failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		reg.Complete(job.ID, map[string]any{"key": key, "format": "mp4"},
			&jobs.Blob{Key: key, ContentType: "video/mp4", Filename: "export-" + id + ".mp4"})
		writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
	}
}

func docExportHandler(p *persistence.Service, store storage.Driver, reg *jobs.Registry, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Format string `json:"format"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Format != "docx" && body.Format != "pdf" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", `format must be "docx" or "pdf"`)
			return
		}
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		job := reg.Start(u.ID, "doc-export")
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			reg.Fail(job.ID, "load failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		blocks := docexport.ResolveBlocks(loaded.File)
		title, _ := loaded.File["title"].(string)
		if title == "" {
			title = "Document"
		}
		var bytesOut []byte
		var ctype, ext string
		if body.Format == "docx" {
			bytesOut, err = docexport.BuildDOCX(blocks, title)
			ctype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			ext = "docx"
		} else {
			bytesOut, err = docexport.BuildPDF(blocks, title)
			ctype = "application/pdf"
			ext = "pdf"
		}
		if err != nil {
			reg.Fail(job.ID, "render failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		key := "designs/" + id + "/exports/doc-" + job.ID + "." + ext
		if _, err := store.Put(key, bytesOut); err != nil {
			reg.Fail(job.ID, "store failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		reg.Complete(job.ID, map[string]any{"key": key, "format": body.Format},
			&jobs.Blob{Key: key, ContentType: ctype, Filename: "document-" + id + "." + ext})
		writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
	}
}

// exportDownloadHandler streams a completed export's stored bytes. It re-checks
// design access, that the job is the caller's, completed, of the expected kind,
// and that its stored key is scoped to this design (no cross-design read).
func exportDownloadHandler(p *persistence.Service, store storage.Driver, reg *jobs.Registry, acct *accounts.Service, jobName string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := authorizeDesign(r, p, acct, id, "viewer"); err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		job, ok := reg.Get(u.ID, chi.URLParam(r, "jobId"))
		if !ok || job.Name != jobName || job.Status != jobs.StatusCompleted || job.Blob == nil {
			Problem(w, r, http.StatusNotFound, "Not Found", "export not found")
			return
		}
		if !strings.HasPrefix(job.Blob.Key, "designs/"+id+"/") {
			Problem(w, r, http.StatusNotFound, "Not Found", "export not found")
			return
		}
		data, err := store.Get(job.Blob.Key)
		if err != nil || data == nil {
			Problem(w, r, http.StatusNotFound, "Not Found", "export not found")
			return
		}
		w.Header().Set("Content-Type", job.Blob.ContentType)
		w.Header().Set("Content-Disposition", `attachment; filename="`+job.Blob.Filename+`"`)
		w.Header().Set("Cache-Control", "private, max-age=3600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}
