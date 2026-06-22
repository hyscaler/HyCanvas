// Package home ports the dashboard module (doc 15 FR-7): recent/favorites
// sections, search, and favorite toggling, built on persistence + workspace
// authorization. Ranking/filtering mirrors @hc/authz searchHome.
package home

import (
	"context"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hycanvas/backend/internal/persistence"
)

// DBTX is the data surface home needs for the Favorite table.
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Access is the membership check (satisfied by *accounts.Service).
type Access interface {
	AssertMember(ctx context.Context, userID, workspaceID, minRole string) error
}

// HomeItem matches the @hc/authz HomeItem JSON shape.
type HomeItem struct {
	Kind         string  `json:"kind"`
	DocKind      *string `json:"docKind"`
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	ThumbnailURL *string `json:"thumbnailUrl,omitempty"`
	WorkspaceID  string  `json:"workspaceId"`
	UpdatedAt    string  `json:"updatedAt"`
	Starred      bool    `json:"starred"`
	SharedWithMe bool    `json:"sharedWithMe"`
}

type Service struct {
	db      DBTX
	persist *persistence.Service
	access  Access
}

func NewService(db DBTX, persist *persistence.Service, access Access) *Service {
	return &Service{db: db, persist: persist, access: access}
}

func designToItem(d persistence.DesignRecord, starred bool) HomeItem {
	return HomeItem{
		Kind:        "design",
		DocKind:     d.DocKind,
		ID:          d.ID,
		Title:       d.Title,
		WorkspaceID: d.WorkspaceID,
		UpdatedAt:   d.UpdatedAt,
		Starred:     starred,
	}
}

func (s *Service) favoriteIDs(ctx context.Context, userID string) (map[string]bool, error) {
	rows, err := s.db.Query(ctx, `SELECT "designId" FROM "Favorite" WHERE "userId" = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	set := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		set[id] = true
	}
	return set, rows.Err()
}

// Section returns a dashboard section ("recent" | "favorites"; "shared" is
// deferred and returns empty, matching the NestJS behavior).
func (s *Service) Section(ctx context.Context, userID, workspaceID, section string) ([]HomeItem, error) {
	if err := s.access.AssertMember(ctx, userID, workspaceID, "viewer"); err != nil {
		return nil, err
	}
	if section == "shared" {
		return []HomeItem{}, nil
	}
	designs, err := s.persist.ListByWorkspace(ctx, workspaceID, 200)
	if err != nil {
		return nil, err
	}
	starred, err := s.favoriteIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	items := make([]HomeItem, 0, len(designs))
	for _, d := range designs {
		if section == "favorites" && !starred[d.ID] {
			continue
		}
		items = append(items, designToItem(d, starred[d.ID]))
	}
	return items, nil
}

// Search filters/ranks the workspace's designs (mirrors searchHome).
func (s *Service) Search(ctx context.Context, userID, workspaceID, q string, types []string) ([]HomeItem, error) {
	if err := s.access.AssertMember(ctx, userID, workspaceID, "viewer"); err != nil {
		return nil, err
	}
	designs, err := s.persist.ListByWorkspace(ctx, workspaceID, 200)
	if err != nil {
		return nil, err
	}
	starred, err := s.favoriteIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	items := make([]HomeItem, 0, len(designs))
	for _, d := range designs {
		items = append(items, designToItem(d, starred[d.ID]))
	}
	return searchHome(items, q, types), nil
}

// SetFavorite deterministically stars (on=true) or unstars (on=false) a design
// for the user and returns the resulting state. POST /favorite calls it with
// true, DELETE /favorite with false, matching the SDK's toggleFavorite(on).
func (s *Service) SetFavorite(ctx context.Context, userID, designID string, on bool) (bool, error) {
	ws, err := s.persist.GetWorkspaceID(ctx, designID)
	if err != nil {
		return false, err
	}
	if err := s.access.AssertMember(ctx, userID, ws, "viewer"); err != nil {
		return false, err
	}
	if !on {
		if _, err := s.db.Exec(ctx, `DELETE FROM "Favorite" WHERE "userId"=$1 AND "designId"=$2`, userID, designID); err != nil {
			return false, err
		}
		return false, nil
	}
	if _, err := s.db.Exec(ctx,
		`INSERT INTO "Favorite" (id, "userId", "designId") VALUES ($1,$2,$3) ON CONFLICT ("userId","designId") DO NOTHING`,
		uuid.NewString(), userID, designID); err != nil {
		return false, err
	}
	return true, nil
}

// relevance mirrors @hc/authz: exact 100, prefix 60, substring 30, else 0.
func relevance(title, q string) int {
	t := strings.ToLower(title)
	n := strings.ToLower(q)
	switch {
	case t == n:
		return 100
	case strings.HasPrefix(t, n):
		return 60
	case strings.Contains(t, n):
		return 30
	default:
		return 0
	}
}

func searchHome(items []HomeItem, q string, types []string) []HomeItem {
	pool := items
	if len(types) > 0 {
		typeSet := map[string]bool{}
		for _, t := range types {
			typeSet[t] = true
		}
		pool = pool[:0:0]
		for _, i := range items {
			if typeSet[i.Kind] {
				pool = append(pool, i)
			}
		}
	}
	if q != "" {
		scored := make([]HomeItem, 0, len(pool))
		score := map[string]int{}
		for _, i := range pool {
			if r := relevance(i.Title, q); r > 0 {
				score[i.ID] = r
				scored = append(scored, i)
			}
		}
		sort.SliceStable(scored, func(a, b int) bool {
			if score[scored[a].ID] != score[scored[b].ID] {
				return score[scored[a].ID] > score[scored[b].ID]
			}
			if scored[a].Starred != scored[b].Starred {
				return scored[a].Starred
			}
			return scored[a].UpdatedAt > scored[b].UpdatedAt
		})
		return scored
	}
	out := append([]HomeItem(nil), pool...)
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].Starred != out[b].Starred {
			return out[a].Starred
		}
		return out[a].UpdatedAt > out[b].UpdatedAt
	})
	return out
}
