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
	// IPv6 forms that carry an IPv4 address inside them. These read as global
	// unicast to every stdlib predicate, but a stack with NAT64 or 6to4 turns
	// them into a connection to the embedded address, so the guard has to judge
	// what they actually reach.
	embedded := []string{
		"64:ff9b::7f00:1",   // NAT64 well-known prefix -> 127.0.0.1
		"64:ff9b::a00:1",    // NAT64 -> 10.0.0.1
		"64:ff9b:1::7f00:1", // NAT64 local-use range (RFC 8215)
		"2002:7f00:1::",     // 6to4 -> 127.0.0.1
		"2002:a00:1::",      // 6to4 -> 10.0.0.1
		"::7f00:1",          // deprecated IPv4-compatible -> 127.0.0.1
		"64:FF9B::7F00:1",   // uppercase must not slip past
		"::ffff:7f00:1",     // v4-mapped in hex, not dotted -> 127.0.0.1
		"::ffff:0a00:1",     // v4-mapped in hex -> 10.0.0.1
		"0:0:0:0:0:0:0:1",   // loopback written out in full
	}
	for _, ip := range embedded {
		if !IsPrivateIP(ip) {
			t.Errorf("IsPrivateIP(%q) should be true (embeds a private IPv4)", ip)
		}
	}
	// A 6to4 address wrapping a PUBLIC IPv4 is still fetchable; the guard must
	// refuse by what is embedded, not by the prefix.
	if IsPrivateIP("2002:808:808::") { // 6to4 -> 8.8.8.8
		t.Error(`IsPrivateIP("2002:808:808::") should be false (embeds a public IPv4)`)
	}
	if IsPrivateIP("2606:4700:4700::1111") { // ordinary public IPv6
		t.Error("a public IPv6 address should not be refused")
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
