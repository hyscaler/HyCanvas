package httpapi

import (
	"encoding/base64"

	"hycanvas/backend/internal/render"
)

// assetContent fetches an asset's bytes and content type by id (backed by the
// uploads service in production; a stub in tests).
type assetContent func(assetID string) (data []byte, contentType string, err error)

// embedNodeAssets returns a deep copy of a node tree with every image element's
// pixels and every image/pattern fill's pixels inlined as data URLs (the raster
// exporter draws from node["src"] / fill["src"]), recursing into children so
// nested images render too. Shared by the video element-clip staging and design
// raster (PNG/JPEG) export, whose rasterizer resolves images from embedded bytes
// rather than from a workspace asset id. Never mutates the input; a nil fetch
// copies the tree without embedding.
func embedNodeAssets(fetch assetContent, node map[string]any) map[string]any {
	// Capacity hint is exactly the source size: n2 is a copy of node plus at
	// most a couple of added keys, and len(node) bounds the hint by an
	// already-allocated map, so it cannot overflow. Growth for the extra keys is
	// negligible and handled by the runtime.
	n2 := make(map[string]any, len(node))
	for k, v := range node {
		n2[k] = v
	}
	dataURL := func(aid string) (string, bool) {
		if aid == "" || fetch == nil {
			return "", false
		}
		data, ct, err := fetch(aid)
		if err != nil || len(data) == 0 {
			return "", false
		}
		mime := ct
		if mime == "" {
			mime = "image/png"
		}
		return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), true
	}
	if typ, _ := node["type"].(string); typ == "image" {
		if src, _ := node["source"].(map[string]any); src != nil {
			if aid, _ := src["assetId"].(string); aid != "" {
				// An alpha mask (v20) is flattened into the inlined bytes here,
				// so every backend downstream of this draws the cutout the
				// editor shows. Without it an export silently reinstates the
				// background the user removed.
				if mid := render.AlphaMaskAssetID(node); mid != "" {
					if imgData, _, err := fetch(aid); err == nil && len(imgData) > 0 {
						if maskData, _, mErr := fetch(mid); mErr == nil && len(maskData) > 0 {
							if merged, ok := render.CompositeAlphaMask(imgData, maskData); ok {
								n2["src"] = "data:image/png;base64," + base64.StdEncoding.EncodeToString(merged)
								return n2
							}
						}
					}
					// Fall through unmasked: a mask that will not decode must
					// not cost the user the whole image.
				}
				if url, ok := dataURL(aid); ok {
					n2["src"] = url
				}
			}
		}
	}
	// QR center logo: inline the logo asset's bytes so rasterQR can draw it.
	if typ, _ := node["type"].(string); typ == "qr" {
		if aid, _ := node["logoAssetId"].(string); aid != "" {
			if url, ok := dataURL(aid); ok {
				n2["logoSrc"] = url
			}
		}
	}
	if fills, ok := node["fills"].([]any); ok {
		nf := make([]any, len(fills))
		for i, fv := range fills {
			fo, ok := fv.(map[string]any)
			if !ok {
				nf[i] = fv
				continue
			}
			var aid string
			switch ft, _ := fo["type"].(string); ft {
			case "image":
				if src, _ := fo["source"].(map[string]any); src != nil {
					aid, _ = src["assetId"].(string)
				}
			case "pattern":
				aid, _ = fo["assetId"].(string)
			}
			if aid == "" {
				nf[i] = fv
				continue
			}
			f2 := make(map[string]any, len(fo))
			for k, v := range fo {
				f2[k] = v
			}
			if _, has := f2["src"]; !has {
				if url, ok := dataURL(aid); ok {
					f2["src"] = url
				}
			}
			nf[i] = f2
		}
		n2["fills"] = nf
	}
	if kids, ok := node["children"].([]any); ok {
		nk := make([]any, len(kids))
		for i, c := range kids {
			if cm, ok := c.(map[string]any); ok {
				nk[i] = embedNodeAssets(fetch, cm)
			} else {
				nk[i] = c
			}
		}
		n2["children"] = nk
	}
	return n2
}

// embedDesignFileAssets returns a deep copy of an opaque design file with image
// node + image/pattern fill bytes inlined across every page, so the raster
// exporter renders images the file references only by asset id. Never mutates
// the input; returns it unchanged when fetch is nil.
func embedDesignFileAssets(fetch assetContent, file map[string]any) map[string]any {
	if fetch == nil {
		return file
	}
	f2 := make(map[string]any, len(file))
	for k, v := range file {
		f2[k] = v
	}
	pages, ok := file["pages"].([]any)
	if !ok {
		return f2
	}
	np := make([]any, len(pages))
	for i, pv := range pages {
		pg, ok := pv.(map[string]any)
		if !ok {
			np[i] = pv
			continue
		}
		p2 := make(map[string]any, len(pg))
		for k, v := range pg {
			p2[k] = v
		}
		if kids, ok := pg["children"].([]any); ok {
			nk := make([]any, len(kids))
			for j, c := range kids {
				if cm, ok := c.(map[string]any); ok {
					nk[j] = embedNodeAssets(fetch, cm)
				} else {
					nk[j] = c
				}
			}
			p2["children"] = nk
		}
		np[i] = p2
	}
	f2["pages"] = np
	return f2
}
