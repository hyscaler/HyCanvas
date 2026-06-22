package jobs

import "testing"

func TestRegistry(t *testing.T) {
	r := NewRegistry()

	j := r.Start("user-1", "export.video")
	if j.Status != StatusActive || j.OwnerID != "user-1" {
		t.Fatalf("start: %+v", j)
	}

	// Owner can read it; a non-owner cannot (existence not leaked).
	if _, ok := r.Get("user-1", j.ID); !ok {
		t.Fatal("owner should see job")
	}
	if _, ok := r.Get("user-2", j.ID); ok {
		t.Fatal("non-owner must not see job")
	}
	if _, ok := r.Get("user-1", "nope"); ok {
		t.Fatal("missing id must not be found")
	}

	// Complete carries a result + blob.
	r.Complete(j.ID, map[string]any{"designId": "d1"}, &Blob{Key: "k", ContentType: "video/mp4", Filename: "v.mp4"})
	got, _ := r.Get("user-1", j.ID)
	if got.Status != StatusCompleted || got.Blob == nil || got.Blob.Filename != "v.mp4" {
		t.Fatalf("complete: %+v", got)
	}
	v := got.View()
	if v.Status != StatusCompleted || v.CreatedAt == "" || v.MaxAttempts != 1 {
		t.Fatalf("view: %+v", v)
	}

	// Fail records the message.
	j2 := r.Start("user-1", "export.doc")
	r.Fail(j2.ID, "boom")
	got2, _ := r.Get("user-1", j2.ID)
	if got2.Status != StatusFailed || got2.Error != "boom" {
		t.Fatalf("fail: %+v", got2)
	}
}
