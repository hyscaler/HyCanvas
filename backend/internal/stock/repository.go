// SQL access for stock favorites + recents, against the Prisma-managed tables
// "StockFavorite" and "StockRecent" (quoted identifiers). stockId is a catalog
// id (text), not a UUID.
package stock

import (
	"context"

	"github.com/google/uuid"
)

func (s *Service) isFavorite(ctx context.Context, userID, stockID string) (bool, error) {
	var one int
	err := s.db.QueryRow(ctx, `SELECT 1 FROM "StockFavorite" WHERE "userId" = $1 AND "stockId" = $2`, userID, stockID).Scan(&one)
	if err != nil {
		return false, nil // ErrNoRows -> not favorited
	}
	return true, nil
}

func (s *Service) addFavorite(ctx context.Context, userID, stockID string) error {
	_, err := s.db.Exec(ctx,
		`INSERT INTO "StockFavorite" (id,"userId","stockId") VALUES ($1,$2,$3)
		 ON CONFLICT ("userId","stockId") DO NOTHING`,
		uuid.NewString(), userID, stockID)
	return err
}

func (s *Service) removeFavorite(ctx context.Context, userID, stockID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "StockFavorite" WHERE "userId" = $1 AND "stockId" = $2`, userID, stockID)
	return err
}

// favoriteIDs returns the user's favorited stock ids, newest first.
func (s *Service) favoriteIDs(ctx context.Context, userID string) ([]string, error) {
	return s.scanIDs(ctx, `SELECT "stockId" FROM "StockFavorite" WHERE "userId" = $1 ORDER BY "createdAt" DESC`, userID)
}

// recentIDs returns the user's recently-used stock ids, most recent first.
func (s *Service) recentIDs(ctx context.Context, userID string) ([]string, error) {
	return s.scanIDs(ctx, `SELECT "stockId" FROM "StockRecent" WHERE "userId" = $1 ORDER BY "usedAt" DESC`, userID)
}

// recordRecent upserts a recent (refreshing usedAt) and trims beyond the cap.
func (s *Service) recordRecent(ctx context.Context, userID, stockID string, cap int) error {
	if _, err := s.db.Exec(ctx,
		`INSERT INTO "StockRecent" (id,"userId","stockId","usedAt") VALUES ($1,$2,$3,now())
		 ON CONFLICT ("userId","stockId") DO UPDATE SET "usedAt" = now()`,
		uuid.NewString(), userID, stockID); err != nil {
		return err
	}
	// Keep only the newest `cap` recents for the user.
	_, err := s.db.Exec(ctx,
		`DELETE FROM "StockRecent" WHERE "userId" = $1 AND id NOT IN (
			SELECT id FROM "StockRecent" WHERE "userId" = $1 ORDER BY "usedAt" DESC LIMIT $2
		)`, userID, cap)
	return err
}

func (s *Service) scanIDs(ctx context.Context, q, userID string) ([]string, error) {
	rows, err := s.db.Query(ctx, q, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
