// The starter brand kit.
//
// HyCanvas ships its own brand kit the way it ships the template catalog:
// compiled into the binary and present in a workspace from the start. The
// spec (starter/hycanvas.json) names the palettes, faces, logos and voice; the
// artwork next to it is rasterized from the SVG masters in starter/src by
// scripts/build-brand-starter.mjs. A workspace that has no kit of its own
// receives the starter kit once, as its default: when it is created (signup,
// a first OIDC login, a team workspace) and, for the workspaces that predate
// the kit, on the first boot after the upgrade. The visit is recorded on the
// workspace, so a kit the owner deletes or replaces never comes back, and a
// workspace that already has a kit of its own (one with content, or one the
// owner named) is left alone; an empty untitled placeholder is not a brand.
//
// The default kit grounds every generation in the workspace (voice, palette,
// faces and the logo on every page), so an instance whose users bring their
// own brands can turn the seeding off with BRAND_STARTER_KIT="off".
package brand

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

//go:embed starter/hycanvas.json starter/*.png
var starterFS embed.FS

// StarterAssets stores a piece of the kit's artwork in a workspace's asset
// library on behalf of its owner and returns the asset id. The uploads service
// satisfies it at boot.
type StarterAssets interface {
	StoreStarterAsset(ctx context.Context, workspaceID, ownerID, filename string, data []byte) (string, error)
}

// WithStarterAssets wires the asset store the seeding uploads the logo
// artwork through. Without it a seeded kit carries no logos.
func (s *Service) WithStarterAssets(a StarterAssets) *Service {
	s.starterAssets = a
	return s
}

// StarterKitEnabled reports whether this instance seeds the starter kit:
// BRAND_STARTER_KIT unset or "hycanvas" seeds it; "off", "none", "false" or
// "0" leaves every workspace without a kit until someone makes one.
func StarterKitEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("BRAND_STARTER_KIT"))) {
	case "off", "none", "false", "0":
		return false
	}
	return true
}

// --- the spec ------------------------------------------------------------

type starterSpec struct {
	Name     string           `json:"name"`
	Palettes []starterPalette `json:"palettes"`
	Fonts    json.RawMessage  `json:"fonts"`
	Logos    []starterLogo    `json:"logos"`
	Voice    json.RawMessage  `json:"voice"`
}

type starterPalette struct {
	ID     string          `json:"id"`
	Name   string          `json:"name"`
	Colors []starterSwatch `json:"colors"`
}

// starterSwatch is authored in hex; the kit stores the canonical sRGB Color.
type starterSwatch struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	Name string `json:"name,omitempty"`
	Hex  string `json:"hex"`
}

// starterLogo names its artwork by file; the kit stores asset ids.
type starterLogo struct {
	ID              string  `json:"id"`
	Label           string  `json:"label"`
	File            string  `json:"file"`
	Dark            string  `json:"dark,omitempty"`
	MinSizePx       float64 `json:"minSizePx,omitempty"`
	ClearSpaceRatio float64 `json:"clearSpaceRatio,omitempty"`
}

func loadStarterSpec() (starterSpec, error) {
	raw, err := starterFS.ReadFile("starter/hycanvas.json")
	if err != nil {
		return starterSpec{}, err
	}
	var spec starterSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return starterSpec{}, fmt.Errorf("starter kit spec: %w", err)
	}
	if strings.TrimSpace(spec.Name) == "" {
		return starterSpec{}, errors.New("starter kit spec: no name")
	}
	return spec, nil
}

// StarterKit is the kit's content with every logo resolved to an asset id,
// in the JSON shapes the brand panel writes.
type StarterKit struct {
	Name     string
	Palettes json.RawMessage
	Fonts    json.RawMessage
	Logos    json.RawMessage
	Voice    json.RawMessage
}

// StarterFile is one piece of artwork the kit references.
type StarterFile struct {
	// Path is the file's name inside the embedded starter directory.
	Path string
	// Filename is the name the asset takes in the workspace's library.
	Filename string
}

// StarterFiles lists the artwork the kit references, each file once, in the
// order the logos name them.
func StarterFiles() ([]StarterFile, error) {
	spec, err := loadStarterSpec()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []StarterFile
	add := func(path, filename string) {
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		out = append(out, StarterFile{Path: path, Filename: filename})
	}
	for _, l := range spec.Logos {
		add(l.File, l.Label+".png")
		add(l.Dark, l.Label+" on dark.png")
	}
	return out, nil
}

// StarterArtwork returns the bytes of one embedded artwork file.
func StarterArtwork(path string) ([]byte, error) {
	return starterFS.ReadFile("starter/" + path)
}

// BuildStarterKit compiles the spec into kit content. assetID maps an artwork
// file to the id it was stored under; a file it maps to "" leaves that logo
// (or its dark version) out, so a kit still compiles with no asset store.
func BuildStarterKit(assetID func(file string) string) (StarterKit, error) {
	spec, err := loadStarterSpec()
	if err != nil {
		return StarterKit{}, err
	}
	type color struct {
		R, G, B, A float64
	}
	type swatch struct {
		ID    string `json:"id"`
		Role  string `json:"role"`
		Name  string `json:"name,omitempty"`
		Value struct {
			SRGB struct {
				R float64 `json:"r"`
				G float64 `json:"g"`
				B float64 `json:"b"`
				A float64 `json:"a"`
			} `json:"srgb"`
		} `json:"value"`
	}
	type palette struct {
		ID     string   `json:"id"`
		Name   string   `json:"name"`
		Colors []swatch `json:"colors"`
	}
	palettes := make([]palette, 0, len(spec.Palettes))
	for _, p := range spec.Palettes {
		out := palette{ID: p.ID, Name: p.Name, Colors: make([]swatch, 0, len(p.Colors))}
		for _, c := range p.Colors {
			r, g, b, err := parseHex(c.Hex)
			if err != nil {
				return StarterKit{}, fmt.Errorf("starter kit swatch %q: %w", c.ID, err)
			}
			sw := swatch{ID: c.ID, Role: c.Role, Name: c.Name}
			sw.Value.SRGB.R, sw.Value.SRGB.G, sw.Value.SRGB.B, sw.Value.SRGB.A = r, g, b, 1
			out.Colors = append(out.Colors, sw)
		}
		palettes = append(palettes, out)
	}
	type logo struct {
		ID              string            `json:"id"`
		Label           string            `json:"label"`
		AssetID         string            `json:"assetId"`
		Variants        map[string]string `json:"variants,omitempty"`
		ClearSpaceRatio float64           `json:"clearSpaceRatio,omitempty"`
		MinSizePx       float64           `json:"minSizePx,omitempty"`
	}
	logos := make([]logo, 0, len(spec.Logos))
	for _, l := range spec.Logos {
		id := assetID(l.File)
		if id == "" {
			continue
		}
		out := logo{ID: l.ID, Label: l.Label, AssetID: id, ClearSpaceRatio: l.ClearSpaceRatio, MinSizePx: l.MinSizePx}
		if l.Dark != "" {
			if dark := assetID(l.Dark); dark != "" {
				out.Variants = map[string]string{"dark": dark}
			}
		}
		logos = append(logos, out)
	}
	kit := StarterKit{Name: spec.Name, Fonts: spec.Fonts, Voice: spec.Voice}
	if kit.Palettes, err = json.Marshal(palettes); err != nil {
		return StarterKit{}, err
	}
	if kit.Logos, err = json.Marshal(logos); err != nil {
		return StarterKit{}, err
	}
	if len(kit.Fonts) == 0 {
		kit.Fonts = json.RawMessage("[]")
	}
	if len(kit.Voice) == 0 {
		kit.Voice = json.RawMessage("null")
	}
	return kit, nil
}

// parseHex reads #RRGGBB (or #RGB) into unit-range channels.
func parseHex(hex string) (r, g, b float64, err error) {
	h := strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(h) == 3 {
		h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
	}
	if len(h) != 6 {
		return 0, 0, 0, fmt.Errorf("bad hex colour %q", hex)
	}
	ch := func(s string) (float64, error) {
		v, err := strconv.ParseUint(s, 16, 8)
		return float64(v) / 255, err
	}
	if r, err = ch(h[0:2]); err != nil {
		return 0, 0, 0, fmt.Errorf("bad hex colour %q", hex)
	}
	if g, err = ch(h[2:4]); err != nil {
		return 0, 0, 0, fmt.Errorf("bad hex colour %q", hex)
	}
	if b, err = ch(h[4:6]); err != nil {
		return 0, 0, 0, fmt.Errorf("bad hex colour %q", hex)
	}
	return r, g, b, nil
}

// --- seeding -------------------------------------------------------------

// SeedStarterKit gives a workspace the starter kit as its default when it has
// no kit, and records the visit either way. Reports whether a kit was made.
// Not gated on the caller: it runs from workspace creation and the boot-time
// pass, never from a request. The version snapshot carries no author.
//
// The visit is claimed before anything is made, so the boot-time pass and the
// creation hook cannot both seed a workspace that is created mid-pass; a
// failed seeding gives the claim back so the next boot tries again.
func (s *Service) SeedStarterKit(ctx context.Context, workspaceID, ownerID string) (seeded bool, err error) {
	claimed, err := s.claimStarterVisit(ctx, workspaceID)
	if err != nil || !claimed {
		return false, err
	}
	defer func() {
		if err != nil {
			s.releaseStarterVisit(context.WithoutCancel(ctx), workspaceID)
		}
	}()
	existing, err := s.listForWorkspace(ctx, workspaceID)
	if err != nil {
		return false, err
	}
	for _, k := range existing {
		if kitIsOwn(k) {
			return false, nil
		}
	}
	ids := map[string]string{}
	if s.starterAssets != nil {
		files, err := StarterFiles()
		if err != nil {
			return false, err
		}
		for _, f := range files {
			data, err := StarterArtwork(f.Path)
			if err != nil {
				return false, err
			}
			id, err := s.starterAssets.StoreStarterAsset(ctx, workspaceID, ownerID, f.Filename, data)
			if err != nil {
				return false, fmt.Errorf("store %s: %w", f.Path, err)
			}
			ids[f.Path] = id
		}
	}
	kit, err := BuildStarterKit(func(file string) string { return ids[file] })
	if err != nil {
		return false, err
	}
	row, err := s.createWithContent(ctx, workspaceID, kit)
	if err != nil {
		return false, err
	}
	if err := s.clearDefault(ctx, workspaceID, row.ID); err != nil {
		return false, err
	}
	if err := s.recordVersion(ctx, row, ""); err != nil {
		return false, err
	}
	return true, nil
}

// SeedStarterKits visits every workspace the seeding has not seen, oldest
// first, until none is left: the one-time pass for the workspaces that
// predate the starter kit. Returns how many kits it made. A workspace whose
// seeding fails stays unvisited (and is logged by the caller through the
// returned error), so the next boot tries it again.
func (s *Service) SeedStarterKits(ctx context.Context) (int, error) {
	const batch = 200
	made := 0
	for {
		rows, err := s.db.Query(ctx,
			`SELECT id, "owner_id" FROM "workspaces" WHERE "brand_seeded_at" IS NULL ORDER BY "created_at", id LIMIT $1`, batch)
		if err != nil {
			return made, err
		}
		type ws struct{ id, owner string }
		var pending []ws
		for rows.Next() {
			var w ws
			if err := rows.Scan(&w.id, &w.owner); err != nil {
				rows.Close()
				return made, err
			}
			pending = append(pending, w)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return made, err
		}
		if len(pending) == 0 {
			return made, nil
		}
		var failed error
		for _, w := range pending {
			if ctx.Err() != nil {
				return made, ctx.Err()
			}
			ok, err := s.SeedStarterKit(ctx, w.id, w.owner)
			if err != nil {
				failed = fmt.Errorf("workspace %s: %w", w.id, err)
				continue
			}
			if ok {
				made++
			}
		}
		if failed != nil {
			// A failing workspace would be selected again by the next batch;
			// stop here and let the next boot retry rather than spin.
			return made, failed
		}
		if len(pending) < batch {
			return made, nil
		}
	}
}

// untitledKitName is the name CreateKit gives a kit made without one.
const untitledKitName = "Untitled brand kit"

// kitIsOwn reports whether a kit is the workspace's own brand, which the
// seeding must not displace: one with any content (a palette, a face, a
// logo, a collection or a voice), or one the owner named. An empty kit still
// carrying the default name is a placeholder from a click in the panel; the
// starter kit is seeded beside it and becomes the default in its stead.
func kitIsOwn(k BrandKitRow) bool {
	if strings.TrimSpace(k.Name) != untitledKitName {
		return true
	}
	for _, raw := range []json.RawMessage{k.Palettes, k.Fonts, k.Logos, k.Collections} {
		var items []json.RawMessage
		if len(raw) > 0 && json.Unmarshal(raw, &items) == nil && len(items) > 0 {
			return true
		}
	}
	var voice struct {
		Tone       []string `json:"tone"`
		DoSay      []string `json:"doSay"`
		DontSay    []string `json:"dontSay"`
		SampleCopy string   `json:"sampleCopy"`
	}
	if len(k.Voice) > 0 && json.Unmarshal(k.Voice, &voice) == nil {
		for _, list := range [][]string{voice.Tone, voice.DoSay, voice.DontSay, {voice.SampleCopy}} {
			for _, v := range list {
				if strings.TrimSpace(v) != "" {
					return true
				}
			}
		}
	}
	return false
}

// claimStarterVisit records the visit and reports whether this caller was
// the one to record it; a workspace already visited (or being visited by a
// concurrent caller) is not claimed.
func (s *Service) claimStarterVisit(ctx context.Context, workspaceID string) (bool, error) {
	tag, err := s.db.Exec(ctx, `UPDATE "workspaces" SET "brand_seeded_at" = $2 WHERE id = $1 AND "brand_seeded_at" IS NULL`, workspaceID, time.Now().UTC())
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// releaseStarterVisit gives a claim back after a failed seeding. Best effort:
// a claim that cannot be released leaves the workspace without the kit rather
// than looping on the failure.
func (s *Service) releaseStarterVisit(ctx context.Context, workspaceID string) {
	_, _ = s.db.Exec(ctx, `UPDATE "workspaces" SET "brand_seeded_at" = NULL WHERE id = $1`, workspaceID)
}

// createWithContent inserts a default kit with its content in one statement,
// at version 1, so a seeded kit is never observable half made.
func (s *Service) createWithContent(ctx context.Context, workspaceID string, kit StarterKit) (BrandKitRow, error) {
	const q = `INSERT INTO "brand_kits" (id,"workspace_id",name,"is_default",palettes,fonts,logos,voice,"updated_at")
		VALUES ($1,$2,$3,true,$4,$5,$6,$7,now()) RETURNING ` + kitCols
	return scanKit(s.db.QueryRow(ctx, q, uuid.NewString(), workspaceID, kit.Name, kit.Palettes, kit.Fonts, kit.Logos, nullableJSON(kit.Voice)))
}
