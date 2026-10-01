package aistudio

// KitVocabularyRule is the outline prompt's kit clause, for the composer
// package's parity test against the bundle.
func KitVocabularyRule() string { return kitVocabularyRule }

// KitStyleKnown reports whether the composer has a style of this name.
func KitStyleKnown(name string) bool { return kitStyles[name] }
