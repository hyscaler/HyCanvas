package bulkcreate

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/storage"
	"hycanvas/backend/internal/templates"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

func textNodeFile() persistence.DesignFile {
	return persistence.DesignFile{
		"pages": []any{
			map[string]any{"id": "pg", "children": []any{
				map[string]any{"id": "title", "type": "text", "content": []any{
					map[string]any{"runs": []any{map[string]any{"text": "Default", "style": map[string]any{}}}},
				}},
			}},
		},
	}
}

func TestBulkCreate_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchema(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, ws, _, err := acct.Signup(ctx, "bulk+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	persist := persistence.NewService(tx).WithStorage(store)
	tmpl := templates.NewService(tx, acct, nil) // design-source path won't touch it
	svc := NewService(persist, acct, tmpl)

	// A base design with a fillable text field.
	base, err := persist.Create(ctx, ws.ID, "Base", textNodeFile(), &owner.ID)
	if err != nil {
		t.Fatalf("Create base: %v", err)
	}
	if _, err := persist.SetEditableFields(ctx, base.ID, ws.ID,
		[]persistence.BrandEditableField{{NodeID: "title", Kind: "text", Label: "Title"}}, &owner.ID); err != nil {
		t.Fatalf("SetEditableFields: %v", err)
	}

	// DesignFields surfaces it.
	fields, err := svc.DesignFields(ctx, owner.ID, base.ID)
	if err != nil || len(fields) != 1 || fields[0].NodeID != "title" {
		t.Fatalf("DesignFields: %+v err=%v", fields, err)
	}

	// Bulk create two designs, one per row, named by pattern.
	res, err := svc.BulkCreate(ctx, owner.ID, Input{
		WorkspaceID:    ws.ID,
		SourceDesignID: base.ID,
		Rows:           []map[string]string{{"title": "Alpha"}, {"title": "Beta"}},
		TitlePattern:   "{Title} card",
	})
	if err != nil {
		t.Fatalf("BulkCreate: %v", err)
	}
	if len(res.Created) != 2 || res.Truncated || res.RequestedRows != 2 || len(res.Skipped) != 0 {
		t.Fatalf("bulk result: %+v", res)
	}
	if res.Created[0].Title != "Alpha card" || res.Created[1].Title != "Beta card" {
		t.Fatalf("titles: %+v", res.Created)
	}
	// The first created design has fresh ids and the filled text.
	loaded, err := persist.LoadFile(ctx, res.Created[0].ID, ws.ID)
	if err != nil {
		t.Fatalf("load created: %v", err)
	}
	run := firstRunText(loaded.File)
	if run != "Alpha" {
		t.Fatalf("created design text = %q, want Alpha", run)
	}

	// Autofill the base design in place.
	if err := svc.Autofill(ctx, owner.ID, base.ID, FillValues{"title": {Text: "Filled"}}); err != nil {
		t.Fatalf("Autofill: %v", err)
	}
	reloaded, _ := persist.LoadFile(ctx, base.ID, ws.ID)
	if firstRunText(reloaded.File) != "Filled" {
		t.Fatalf("autofill did not persist: %q", firstRunText(reloaded.File))
	}

	// A non-member is rejected.
	outsider, _, _, _ := acct.Signup(ctx, "out+"+uuid.NewString()+"@example.com", "a-strong-password", "Out")
	if _, err := svc.DesignFields(ctx, outsider.ID, base.ID); err == nil {
		t.Fatal("non-member should be forbidden")
	}
}

func firstRunText(file map[string]any) string {
	pages := asArr(file["pages"])
	if len(pages) == 0 {
		return ""
	}
	children := asArr(asObj(pages[0])["children"])
	if len(children) == 0 {
		return ""
	}
	content := asArr(asObj(children[0])["content"])
	if len(content) == 0 {
		return ""
	}
	runs := asArr(asObj(content[0])["runs"])
	if len(runs) == 0 {
		return ""
	}
	s, _ := asObj(runs[0])["text"].(string)
	return s
}
