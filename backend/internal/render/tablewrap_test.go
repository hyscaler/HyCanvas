package render

import (
	"reflect"
	"testing"
)

// Ten units per rune: a plain measure that makes the breaks readable.
func tenPerRune(s string) float64 { return float64(len([]rune(s))) * 10 }

func TestWrapCellLinesMatchesTheBrowser(t *testing.T) {
	cases := []struct {
		text string
		maxW float64
		want []string
	}{
		{"Live GPS map, updated every 30 sec", 150, []string{"Live GPS map,", "updated every", "30 sec"}},
		{"12 min", 150, []string{"12 min"}},
		{"   ", 150, nil},
		{"a supercalifragilistic word", 100, []string{"a", "supercalifragilistic", "word"}},
	}
	for _, c := range cases {
		if got := wrapCellLines(c.text, c.maxW, tenPerRune); !reflect.DeepEqual(got, c.want) {
			t.Errorf("wrapCellLines(%q, %v) = %q; want %q", c.text, c.maxW, got, c.want)
		}
	}
}
