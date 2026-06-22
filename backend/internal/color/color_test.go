package color

import "testing"

func TestDeltaE(t *testing.T) {
	// Identical colors -> 0.
	if d := DeltaE(1, 0, 0, 1, 0, 0); d > 0.0001 {
		t.Fatalf("identical deltaE should be 0, got %f", d)
	}
	// A tiny rounding drift on red stays under the JND threshold (~2).
	if d := DeltaE(1, 0, 0, 254.0/255, 0, 0); d > 2 {
		t.Fatalf("rounding drift should be below tolerance, got %f", d)
	}
	// Red vs blue is a large perceptual distance.
	if d := DeltaE(1, 0, 0, 0, 0, 1); d < 50 {
		t.Fatalf("red vs blue should be large, got %f", d)
	}
}
