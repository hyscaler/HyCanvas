// Stock template fonts, built into the binary (#85).
//
// The editor draws every design in its own fonts, loaded by the browser from
// Google Fonts. The server had only the embedded fallback (Liberation Sans)
// unless an operator filled FONTS_DIR, so a stock template exported from the
// server (video, PNG/JPEG through the API) came out in a plain sans. The fonts
// the stock templates use are vendored here instead, gzipped, each with its
// license (SIL OFL, Apache 2.0 or the Ubuntu Font License, all of which allow
// redistribution). scripts/fetch-stock-fonts.mjs refreshes them from the
// template seed.
//
// A family is decompressed and registered the first time a render asks for
// it, so the server's memory only grows by the fonts designs actually use.
// Faces an operator registers (FONTS_DIR) win over these.
package render

import (
	"bytes"
	"compress/gzip"
	"embed"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

//go:embed stockfonts/*.ttf.gz
var stockFS embed.FS

var (
	stockOnce  sync.Once
	stockIndex map[string][]stockFace // normFamily -> faces
	stockMu    sync.Mutex
	stockDone  = map[string]bool{} // families already loaded (or tried)
)

type stockFace struct {
	family string
	weight int
	file   string
}

// buildStockIndex lists the embedded faces by family from their file names,
// "Family-Weight.ttf.gz" (the family with its spaces removed, which is how
// normFamily compares names anyway).
func buildStockIndex() {
	stockIndex = map[string][]stockFace{}
	entries, err := stockFS.ReadDir("stockfonts")
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		base := strings.TrimSuffix(name, ".ttf.gz")
		if base == name {
			continue
		}
		i := strings.LastIndex(base, "-")
		if i <= 0 {
			continue
		}
		w, err := strconv.Atoi(base[i+1:])
		if err != nil {
			continue
		}
		fam := normFamily(base[:i])
		stockIndex[fam] = append(stockIndex[fam], stockFace{family: base[:i], weight: w, file: "stockfonts/" + name})
	}
}

// loadStockFamily registers the embedded faces of family, once. Reports
// whether the family has any embedded face. A face an operator registered for
// the same family and weight is left in place.
func loadStockFamily(family string) bool {
	stockOnce.Do(buildStockIndex)
	fam := normFamily(family)
	faces := stockIndex[fam]
	if len(faces) == 0 {
		return false
	}
	stockMu.Lock()
	defer stockMu.Unlock()
	if stockDone[fam] {
		return true
	}
	stockDone[fam] = true
	for _, f := range faces {
		fontMu.RLock()
		_, have := fontReg[fontKey{fam, f.weight}]
		fontMu.RUnlock()
		if have {
			continue
		}
		data, err := readGzip(f.file)
		if err != nil {
			continue
		}
		_ = RegisterFont(f.family, f.weight, data)
	}
	return true
}

// TextFontFamily is the face the video editor draws title cards and captions
// in, and that timeline exports burn them in with.
const TextFontFamily = "Inter"

// StageTextFonts writes the built-in TextFontFamily faces used for title and
// caption burn-in (regular, semibold, bold) into dir, for ffmpeg's drawtext,
// which reads fonts from files. It returns weight -> path for the faces it
// wrote; an empty map leaves drawtext on its generic default.
func StageTextFonts(dir string) map[int]string {
	stockOnce.Do(buildStockIndex)
	out := map[int]string{}
	for _, f := range stockIndex[normFamily(TextFontFamily)] {
		if f.weight != 400 && f.weight != 600 && f.weight != 700 {
			continue
		}
		data, err := readGzip(f.file)
		if err != nil {
			continue
		}
		path := filepath.Join(dir, f.family+"-"+strconv.Itoa(f.weight)+".ttf")
		if os.WriteFile(path, data, 0o600) != nil {
			continue
		}
		out[f.weight] = path
	}
	return out
}

func readGzip(name string) ([]byte, error) {
	raw, err := stockFS.ReadFile(name)
	if err != nil {
		return nil, err
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}

// StockFontFamilies counts the families built into the binary, for the
// startup log.
func StockFontFamilies() int {
	stockOnce.Do(buildStockIndex)
	return len(stockIndex)
}
