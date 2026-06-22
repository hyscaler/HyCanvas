package render

import "errors"

// ErrPageRange is returned when a requested page index is out of range.
var ErrPageRange = errors.New("page index out of range")
