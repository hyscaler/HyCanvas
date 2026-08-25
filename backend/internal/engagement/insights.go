// Pure aggregation for engagement insights (doc 17 FR-14). Given the raw view
// sessions for a design, computes unique viewers (named vs anonymous, counted
// distinctly), total views, views-over-time by UTC day, average time-on-design,
// and per-page engagement. No I/O.
package engagement

import "sort"

// DesignInsights is the aggregated engagement for a design (FR-14).
type DesignInsights struct {
	UniqueViewers     int              `json:"uniqueViewers"`
	UniqueAnonViewers int              `json:"uniqueAnonViewers"`
	TotalViews        int              `json:"totalViews"`
	Views             []DayCount       `json:"views"`
	AvgTimeMs         int64            `json:"avgTimeMs"`
	PerPage           []PageEngagement `json:"perPage"`
	// Per-link attribution (C36): sessions grouped by the share link they
	// arrived through. Sessions with no link (members, legacy rows) are absent.
	Links []LinkEngagement `json:"links,omitempty"`
}

// LinkEngagement is one share link's aggregated engagement (C36).
type LinkEngagement struct {
	LinkID  string `json:"linkId"`
	Label   string `json:"label,omitempty"`
	Views   int    `json:"views"`
	Viewers int    `json:"viewers"`
	TotalMs int64  `json:"totalMs"`
}

type DayCount struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}

type PageEngagement struct {
	PageID       string `json:"pageId"`
	EngagementMs int64  `json:"engagementMs"`
}

// aggregateInsights folds raw view sessions into DesignInsights (FR-14).
func aggregateInsights(sessions []DesignViewRow) DesignInsights {
	named := map[string]bool{}
	anon := map[string]bool{}
	byDay := map[string]int{}
	perPage := map[string]int64{}
	type linkAgg struct {
		label   string
		views   int
		viewers map[string]bool
		totalMs int64
	}
	byLink := map[string]*linkAgg{}
	var totalDuration int64

	for _, s := range sessions {
		if s.ViewerID != nil {
			named[*s.ViewerID] = true
		} else if s.AnonID != nil {
			anon[*s.AnonID] = true
		}
		day := s.OpenedAt.UTC().Format("2006-01-02")
		byDay[day]++
		if s.DurationMs > 0 {
			totalDuration += int64(s.DurationMs)
		}
		for pageID, ms := range s.PerPage {
			if ms > 0 {
				perPage[pageID] += int64(ms)
			}
		}
		if s.LinkID != nil {
			agg := byLink[*s.LinkID]
			if agg == nil {
				agg = &linkAgg{viewers: map[string]bool{}}
				byLink[*s.LinkID] = agg
			}
			if s.LinkLabel != nil {
				agg.label = *s.LinkLabel
			}
			agg.views++
			if s.ViewerID != nil {
				agg.viewers["u:"+*s.ViewerID] = true
			} else if s.AnonID != nil {
				agg.viewers["a:"+*s.AnonID] = true
			}
			if s.DurationMs > 0 {
				agg.totalMs += int64(s.DurationMs)
			}
		}
	}

	views := make([]DayCount, 0, len(byDay))
	for d, c := range byDay {
		views = append(views, DayCount{Date: d, Count: c})
	}
	sort.Slice(views, func(i, j int) bool { return views[i].Date < views[j].Date })

	perPageOut := make([]PageEngagement, 0, len(perPage))
	for pageID, ms := range perPage {
		perPageOut = append(perPageOut, PageEngagement{PageID: pageID, EngagementMs: ms})
	}
	sort.Slice(perPageOut, func(i, j int) bool { return perPageOut[i].EngagementMs > perPageOut[j].EngagementMs })

	linksOut := make([]LinkEngagement, 0, len(byLink))
	for id, agg := range byLink {
		linksOut = append(linksOut, LinkEngagement{LinkID: id, Label: agg.label, Views: agg.views, Viewers: len(agg.viewers), TotalMs: agg.totalMs})
	}
	// Most-viewed first; the link id ties deterministically.
	sort.Slice(linksOut, func(i, j int) bool {
		if linksOut[i].Views != linksOut[j].Views {
			return linksOut[i].Views > linksOut[j].Views
		}
		return linksOut[i].LinkID < linksOut[j].LinkID
	})

	total := len(sessions)
	var avg int64
	if total > 0 {
		avg = totalDuration / int64(total)
	}
	return DesignInsights{
		UniqueViewers:     len(named),
		UniqueAnonViewers: len(anon),
		TotalViews:        total,
		Views:             views,
		AvgTimeMs:         avg,
		PerPage:           perPageOut,
		Links:             linksOut,
	}
}
