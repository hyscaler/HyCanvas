// Local speech recognition for present mode (F28 completion C17/C20).
//
// One shared recognizer feeds both live captions and the speaker coach (the
// browser allows a single active session). Everything is LOCAL to the
// machine: nothing is uploaded, and where the platform offers no
// SpeechRecognition the callers feature-detect and explain. Chrome ends
// sessions after silence, so the manager restarts while enabled.

export interface SpeechChunk {
  /** The final recognized text of a completed utterance. */
  text: string;
  /** performance.now() when the result arrived. */
  atMs: number;
}

export interface SpeechListener {
  /** Interim (in-flight) text, replaced as recognition refines it. */
  onInterim?: (text: string) => void;
  /** A finalized utterance. */
  onFinal?: (chunk: SpeechChunk) => void;
}

type RecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
};

/** The platform's recognizer, or null where speech recognition is unsupported. */
export function speechRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Shared recognition session: listeners subscribe, the session runs while at
 *  least one is attached, and restarts after the browser's silence timeout. */
export class SpeechSession {
  private rec: InstanceType<RecognitionCtor> | null = null;
  private listeners = new Set<SpeechListener>();
  private running = false;
  private stopped = true;

  constructor(private lang: string) {}

  attach(l: SpeechListener): () => void {
    this.listeners.add(l);
    this.ensure();
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private ensure(): void {
    if (this.running) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) {
          const chunk: SpeechChunk = { text: text.trim(), atMs: performance.now() };
          if (chunk.text) for (const l of this.listeners) l.onFinal?.(chunk);
        } else {
          interim += text;
        }
      }
      for (const l of this.listeners) l.onInterim?.(interim.trim());
    };
    rec.onend = () => {
      this.running = false;
      // The browser ends sessions after silence; keep going while attached.
      if (!this.stopped && this.listeners.size > 0) this.ensure();
    };
    rec.onerror = () => {
      /* onend follows and restarts; a denied mic keeps failing quietly and
         the caller's UI explains the unsupported/denied state */
    };
    this.rec = rec;
    this.stopped = false;
    this.running = true;
    try {
      rec.start();
    } catch {
      this.running = false; // an already-started session throws; onend re-syncs
    }
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    try {
      this.rec?.stop();
    } catch {
      /* stopping a stopped session throws on some engines */
    }
    this.rec = null;
  }
}

// --- Speaker coach analysis (C20) -------------------------------------------

export interface CoachStats {
  totalWords: number;
  elapsedMs: number;
  /** Words per minute over the whole session. */
  wpm: number;
  /** Filler-word tally (case-folded whole-word matches). */
  fillers: Record<string, number>;
  fillerTotal: number;
  /** Pauses longer than the threshold between finalized utterances. */
  longPauses: number;
}

const fillerWords = ["um", "uh", "er", "like", "actually", "basically", "literally", "so"];
const longPauseMs = 2500;

/** Incremental coach: feed finalized chunks, read the stats any time. Pure
 *  accumulation - no timers, no globals - so it is unit-testable. */
export class CoachTracker {
  private words = 0;
  private fillers = new Map<string, number>();
  private pauses = 0;
  private startMs: number | null = null;
  private lastChunkMs: number | null = null;

  feed(chunk: SpeechChunk): void {
    if (this.startMs === null) this.startMs = chunk.atMs;
    if (this.lastChunkMs !== null && chunk.atMs - this.lastChunkMs > longPauseMs) this.pauses++;
    this.lastChunkMs = chunk.atMs;
    const tokens = chunk.text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
    this.words += tokens.length;
    for (const t of tokens) {
      if (fillerWords.includes(t)) this.fillers.set(t, (this.fillers.get(t) ?? 0) + 1);
    }
  }

  stats(nowMs: number): CoachStats {
    const elapsed = this.startMs === null ? 0 : Math.max(0, nowMs - this.startMs);
    const minutes = elapsed / 60000;
    const fillers = Object.fromEntries(this.fillers);
    return {
      totalWords: this.words,
      elapsedMs: elapsed,
      wpm: minutes > 0 ? Math.round(this.words / minutes) : 0,
      fillers,
      fillerTotal: [...this.fillers.values()].reduce((a, b) => a + b, 0),
      longPauses: this.pauses,
    };
  }
}
