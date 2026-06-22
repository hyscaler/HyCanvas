package persistence

// SnapshotKind values (lowercase at the API; stored UPPERCASE in the
// SnapshotKind enum column).
type SnapshotKind string

const (
	KindAuto       SnapshotKind = "auto"
	KindCheckpoint SnapshotKind = "checkpoint"
	KindNamed      SnapshotKind = "named"
	KindRestore    SnapshotKind = "restore"
	KindBranch     SnapshotKind = "branch"
)

// SnapshotRecord matches the NestJS SnapshotRecord JSON.
type SnapshotRecord struct {
	ID            string       `json:"id"`
	DesignID      string       `json:"designId"`
	BlobURL       string       `json:"blobUrl"`
	Checksum      string       `json:"checksum"`
	SchemaVersion int          `json:"schemaVersion"`
	SizeBytes     int64        `json:"sizeBytes"`
	AuthorID      *string      `json:"authorId"`
	CreatedAt     string       `json:"createdAt"`
	Kind          SnapshotKind `json:"kind"`
}

// DiffSummary is the lightweight structural diff (doc 04 FR-6).
type DiffSummary struct {
	PagesAdded   int `json:"pagesAdded"`
	PagesRemoved int `json:"pagesRemoved"`
	NodesAdded   int `json:"nodesAdded"`
	NodesRemoved int `json:"nodesRemoved"`
	NodesChanged int `json:"nodesChanged"`
}

// VersionAuthor is the resolved author of a version (doc 04 FR-9).
type VersionAuthor struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// VersionEntry matches the NestJS VersionEntry JSON.
type VersionEntry struct {
	ID          string         `json:"id"`
	DesignID    string         `json:"designId"`
	SnapshotID  string         `json:"snapshotId"`
	Label       *string        `json:"label"`
	AuthorID    *string        `json:"authorId"`
	Author      *VersionAuthor `json:"author"`
	Kind        SnapshotKind   `json:"kind,omitempty"`
	CreatedAt   string         `json:"createdAt"`
	DiffSummary *DiffSummary   `json:"diffSummary"`
}

// BranchEntry matches the NestJS BranchEntry JSON.
type BranchEntry struct {
	ID              string  `json:"id"`
	Title           string  `json:"title"`
	SourceDesignID  *string `json:"sourceDesignId"`
	SourceVersionID *string `json:"sourceVersionId"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

// LoadResult is the full load: the record, the file, and whether an older valid
// snapshot was recovered (doc 04 FR-13).
type LoadResult struct {
	Record    DesignRecord `json:"record"`
	File      DesignFile   `json:"file"`
	Recovered bool         `json:"recovered"`
}
