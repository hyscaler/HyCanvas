// Package migrations carries the SQL schema migrations, embedded into the
// binary so the service is self-contained (no external migration tool). The SQL
// files under sql/<timestamp>_<name>/migration.sql are the schema source of
// truth, applied in lexical order by db.Migrate. They were authored as Prisma
// migrations; the directory names match Prisma's migration_name so an existing
// Prisma-managed database baselines cleanly (see db.Migrate).
package migrations

import "embed"

//go:embed sql
var FS embed.FS
