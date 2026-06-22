// In-session undo/redo history. A transaction groups one or
// more SceneOps into a single atomic, reversible step. The history applies each
// op forward in order and, on undo, applies each op's inverse in reverse order.
//
// This is the LOCAL, ephemeral stack and is never serialized into the design
// file (durable history is persistence snapshots). Under collaboration this
// stack is replaced/wrapped by the Yjs origin-scoped UndoManager so undo affects
// only the local user's changes (FR-8); that integration lands with realtime
// collaboration.

import type { DesignFile } from "@hc/schema";
import { applyCommand, invertCommand, type SceneOp } from "./commands";

export interface Transaction {
  id: string;
  label: string;
  ops: SceneOp[];
  authorId?: string;
  ts?: number;
}

/** Apply every op of a transaction forward, in order. Mutates the file. */
export function applyTransaction(file: DesignFile, txn: Transaction): void {
  for (const op of txn.ops) applyCommand(file, op);
}

/** Reverse a transaction: apply each op's inverse, in reverse order. */
export function revertTransaction(file: DesignFile, txn: Transaction): void {
  for (let i = txn.ops.length - 1; i >= 0; i--) {
    applyCommand(file, invertCommand(txn.ops[i]));
  }
}

/**
 * A bounded local undo/redo stack over an editable DesignFile. Committing a new
 * transaction clears the redo stack (standard linear-history semantics).
 */
export class History {
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];

  constructor(
    private readonly file: DesignFile,
    private readonly limit = 200,
  ) {}

  /** Apply a transaction and push it onto the undo stack. */
  commit(txn: Transaction): void {
    applyTransaction(this.file, txn);
    this.undoStack.push(txn);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Record an already-applied transaction without re-applying it. */
  record(txn: Transaction): void {
    this.undoStack.push(txn);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Apply a transaction and coalesce it into the previous step when they share
   * `key` and fall within `windowMs` of each other (by `ts`); otherwise push a
   * new step. This collapses rapid same-target edits - a slider drag, repeated
   * nudges - into a single undo step (coalescing, FR-7). Pass a stable
   * `key` per continuous gesture and a monotonic `txn.ts`.
   */
  commitCoalescing(txn: Transaction, key: string, windowMs = 400): void {
    applyTransaction(this.file, txn);
    const top = this.undoStack[this.undoStack.length - 1];
    const within = top?.ts != null && txn.ts != null && txn.ts - top.ts <= windowMs;
    if (top && top.id === key && within) {
      top.ops.push(...txn.ops);
      top.ts = txn.ts;
      this.redoStack = [];
      return;
    }
    this.record({ ...txn, id: key });
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Revert the most recent transaction; returns it (for history UI) or null. */
  undo(): Transaction | null {
    const txn = this.undoStack.pop();
    if (!txn) return null;
    revertTransaction(this.file, txn);
    this.redoStack.push(txn);
    return txn;
  }

  /** Re-apply the most recently undone transaction; returns it or null. */
  redo(): Transaction | null {
    const txn = this.redoStack.pop();
    if (!txn) return null;
    applyTransaction(this.file, txn);
    this.undoStack.push(txn);
    return txn;
  }

  /** Labels of the undo stack, oldest first (for an in-session history panel). */
  labels(): string[] {
    return this.undoStack.map((t) => t.label);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
