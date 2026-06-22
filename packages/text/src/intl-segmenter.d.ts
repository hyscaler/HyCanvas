// Minimal ambient types for Intl.Segmenter (present at runtime in modern
// browsers and Node 18+, but not in the configured TS lib).
declare namespace Intl {
  type SegmenterGranularity = "grapheme" | "word" | "sentence";

  interface SegmentData {
    segment: string;
    index: number;
    input: string;
    isWordLike?: boolean;
  }

  interface Segments {
    [Symbol.iterator](): IterableIterator<SegmentData>;
    containing(index?: number): SegmentData;
  }

  class Segmenter {
    constructor(
      locales?: string | string[],
      options?: { granularity?: SegmenterGranularity },
    );
    segment(input: string): Segments;
  }
}
