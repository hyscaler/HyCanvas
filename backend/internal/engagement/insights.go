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
	}
}
