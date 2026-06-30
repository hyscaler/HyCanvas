// SQL access for stock favorites + recents, against the tables
// "stock_favorites" and "stock_recents" (quoted identifiers). stockId is a catalog
// id (text), not a UUID.
package stock

import (
	"context"

	"github.com/google/uuid"
)

func (s *Service) isFavorite(ctx context.Context, userID, stockID string) (bool, error) {
	var one int
	err := s.db.QueryRow(ctx, `SELECT 1 FROM "stock_favorites" WHERE "user_id" = $1 AND "stock_id" = $2`, userID, stockID).Scan(&one)
	if err != nil {
		return false, nil // ErrNoRows -> not favorited
	}
	return true, nil
}

func (s *Service) addFavorite(ctx context.Context, userID, stockID string) error {
	_, err := s.db.Exec(ctx,
		`INSERT INTO "stock_favorites" (id,"user_id","stock_id") VALUES ($1,$2,$3)
		 ON CONFLICT ("user_id","stock_id") DO NOTHING`,
		uuid.NewString(), userID, stockID)
	return err
}

func (s *Service) removeFavorite(ctx context.Context, userID, stockID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "stock_favorites" WHERE "user_id" = $1 AND "stock_id" = $2`, userID, stockID)
	return err
}

// favoriteIDs returns the user's favorited stock ids, newest first.
func (s *Service) favoriteIDs(ctx context.Context, userID string) ([]string, error) {
	return s.scanIDs(ctx, `SELECT "stock_id" FROM "stock_favorites" WHERE "user_id" = $1 ORDER BY "created_at" DESC`, userID)
}

// recentIDs returns the user's recently-used stock ids, most recent first.
func (s *Service) recentIDs(ctx context.Context, userID string) ([]string, error) {
	return s.scanIDs(ctx, `SELECT "stock_id" FROM "stock_recents" WHERE "user_id" = $1 ORDER BY "used_at" DESC`, userID)
}

// recordRecent upserts a recent (refreshing usedAt) and trims beyond the cap.
func (s *Service) recordRecent(ctx context.Context, userID, stockID string, cap int) error {
	if _, err := s.db.Exec(ctx,
		`INSERT INTO "stock_recents" (id,"user_id","stock_id","used_at") VALUES ($1,$2,$3,now())
		 ON CONFLICT ("user_id","stock_id") DO UPDATE SET "used_at" = now()`,
		uuid.NewString(), userID, stockID); err != nil {
		return err
	}
	// Keep only the newest `cap` recents for the user.
	_, err := s.db.Exec(ctx,
		`DELETE FROM "stock_recents" WHERE "user_id" = $1 AND id NOT IN (
			SELECT id FROM "stock_recents" WHERE "user_id" = $1 ORDER BY "used_at" DESC LIMIT $2
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
