package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"hycanvas/backend/internal/aistudio"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/render"
)

// The render-and-review pass on the API door. Once the deck is saved, each
// page is rendered by the Go raster (as an export would draw it) and a
// provider that can read images names the visible defects; the findings
// ride the job's quality result so a consumer can judge the deck without
// opening it. Bounded: at most reviewedPagesMax pages, three in flight, and
// its own clock, so a slow reviewer can delay the result but never the
// save. A provider that cannot read images ends the pass on its first
// answer, and any other failure skips that page.

const (
	reviewedPagesMax = 12
	reviewInFlight   = 3
	reviewTimeout    = 90 * time.Second
	reviewScale      = 0.4
)

// pageReview is one reviewed page in the quality result.
type pageReview struct {
	Page     int                    `json:"page"`
	Findings []aistudio.PageFinding `json:"findings"`
}

// reviewSavedDeck looks at the saved deck's pages. It returns whether a look
// happened at all (false when no provider can read images or nothing could
// be rendered) and the pages that had findings.
func reviewSavedDeck(ctx context.Context, svc *aistudio.Service, workspaceID string, file persistence.DesignFile, titles []string) (bool, []pageReview) {
	raw, err := json.Marshal(file)
	if err != nil {
		return false, nil
	}
	var d render.Design
	if err := json.Unmarshal(raw, &d); err != nil {
		return false, nil
	}
	pages, _ := d["pages"].([]any)
	n := len(pages)
	if n > reviewedPagesMax {
		n = reviewedPagesMax
	}
	if n == 0 {
		return false, nil
	}
	rctx, cancel := context.WithTimeout(ctx, reviewTimeout)
	defer cancel()

	// The first page settles whether the provider can look at all, so the
	// rest do not each learn the same refusal.
	first, err := reviewOnePage(rctx, svc, workspaceID, d, 0, titles)
	if errors.Is(err, aistudio.ErrReviewUnsupported) {
		return false, nil
	}
	results := make([][]aistudio.PageFinding, n)
	errs := make([]error, n)
	results[0], errs[0] = first, err

	var wg sync.WaitGroup
	sem := make(chan struct{}, reviewInFlight)
	for i := 1; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[i], errs[i] = reviewOnePage(rctx, svc, workspaceID, d, i, titles)
		}(i)
	}
	wg.Wait()

	looked := false
	var out []pageReview
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			continue
		}
		looked = true
		if len(results[i]) > 0 {
			out = append(out, pageReview{Page: i + 1, Findings: results[i]})
		}
	}
	return looked, out
}

func reviewOnePage(ctx context.Context, svc *aistudio.Service, workspaceID string, d render.Design, i int, titles []string) ([]aistudio.PageFinding, error) {
	png, err := render.ToPNG(d, i, reviewScale)
	if err != nil {
		return nil, err
	}
	title := ""
	if i < len(titles) {
		title = titles[i]
	}
	return svc.ReviewPage(ctx, workspaceID, base64.StdEncoding.EncodeToString(png), title)
}
