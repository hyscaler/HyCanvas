package media

import "testing"

func TestSniffType(t *testing.T) {
	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0}
	if r := SniffType(png); r == nil || r.Mime != "image/png" || r.Kind != KindImage {
		t.Fatalf("png sniff = %+v", r)
	}
	jpeg := []byte{0xff, 0xd8, 0xff, 0xe0}
	if r := SniffType(jpeg); r == nil || r.Mime != "image/jpeg" {
		t.Fatalf("jpeg sniff = %+v", r)
	}
	if r := SniffType([]byte("%PDF-1.7")); r == nil || r.Kind != KindDocument {
		t.Fatalf("pdf sniff = %+v", r)
	}
	if r := SniffType([]byte(`<svg xmlns="...">`)); r == nil || r.Kind != KindVector {
		t.Fatalf("svg sniff = %+v", r)
	}
	if r := SniffType([]byte("not a known type")); r != nil {
		t.Fatalf("unknown should sniff nil, got %+v", r)
	}
	if got := AcceptUpload([]byte("garbage")); got.OK {
		t.Fatalf("garbage should be rejected")
	}
}

func TestCanUpload(t *testing.T) {
	if !CanUpload(0, 0, 1<<30) {
		t.Fatal("quota<=0 should be unlimited")
	}
	if !CanUpload(100, 1000, 900) {
		t.Fatal("exactly at quota should fit")
	}
	if CanUpload(100, 1000, 901) {
		t.Fatal("over quota should not fit")
	}
}

func TestSSRF(t *testing.T) {
	priv := []string{"10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "::1", "fc00::1"}
	for _, ip := range priv {
		if !IsPrivateIP(ip) {
			t.Errorf("IsPrivateIP(%q) should be true", ip)
		}
	}
	pub := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34"}
	for _, ip := range pub {
		if IsPrivateIP(ip) {
			t.Errorf("IsPrivateIP(%q) should be false", ip)
		}
	}
	if v := ValidateImportURL("https://example.com/a.png"); !v.OK {
		t.Fatalf("public https should pass: %+v", v)
	}
	if v := ValidateImportURL("http://10.0.0.1/x"); v.OK {
		t.Fatal("private IP should be rejected")
	}
	if v := ValidateImportURL("ftp://example.com/x"); v.OK {
		t.Fatal("non-http scheme should be rejected")
	}
	if v := ValidateImportURL("http://localhost/x"); v.OK {
		t.Fatal("localhost should be rejected")
	}
}

func TestFolderDeleteCascade(t *testing.T) {
	p := func(s string) *string { return &s }
	folders := []FolderLite{
		{ID: "a", ParentID: nil},
		{ID: "b", ParentID: p("a")},
		{ID: "c", ParentID: p("b")},
		{ID: "d", ParentID: nil},
	}
	assets := []AssetLite{
		{ID: "a1", FolderID: p("a")},
		{ID: "a2", FolderID: p("c")},
		{ID: "a3", FolderID: p("d")},
		{ID: "a4", FolderID: nil},
	}
	cascade := FolderDeleteCascade(folders, "a", assets)
	if len(cascade.FolderIDs) != 3 { // a, b, c
		t.Fatalf("expected 3 folders in subtree, got %v", cascade.FolderIDs)
	}
	// a1 (in a) and a2 (in c) are affected; a3 (d) and a4 (root) are not.
	if len(cascade.AssetIDs) != 2 {
		t.Fatalf("expected 2 affected assets, got %v", cascade.AssetIDs)
	}
}
