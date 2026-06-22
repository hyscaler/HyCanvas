// Command framework. Every state-changing editor
// action is a registered Command with a stable id, label, category, an optional
// `enabled` predicate, and a `run` that returns the forward SceneOps to apply.
// Commands never mutate scene state directly: they emit ops, which the history
// layer applies inside a transaction so undo/redo and (later) CRDT sync are
// uniform. This is the single funnel the text, shapes, image, and color features
// (and later ones) plug into.

import type { DesignFile } from "@hc/schema";
import type { SceneOp } from "./commands";
import { History, type Transaction } from "./history";

export interface CommandContext {
  designId?: string;
  pageId?: string;
  selection: string[]; // node ids
  viewport?: { x: number; y: number; zoom: number };
}

export interface Command<P = void> {
  id: string; // stable, e.g. "selection.duplicate"
  label: string;
  keywords?: string[];
  category: string;
  /** When false the command is greyed in menus and ignored from shortcuts. */
  enabled?(ctx: CommandContext, file: DesignFile): boolean;
  /** A short reason shown when the command is disabled (FR-11). */
  disabledReason?(ctx: CommandContext, file: DesignFile): string | undefined;
  /** Produce the forward ops to apply; an empty array is a no-op. */
  run(ctx: CommandContext, file: DesignFile, payload: P): SceneOp[];
}

/** A registry of all commands, keyed by id. Last registration wins for an id. */
export class CommandRegistry {
  private commands = new Map<string, Command<never>>();

  register<P>(cmd: Command<P>): void {
    this.commands.set(cmd.id, cmd as unknown as Command<never>);
  }

  unregister(id: string): void {
    this.commands.delete(id);
  }

  get(id: string): Command<never> | undefined {
    return this.commands.get(id);
  }

  all(): Command<never>[] {
    return [...this.commands.values()];
  }

  /** A command is runnable when present and (if it declares one) enabled. */
  isEnabled(id: string, ctx: CommandContext, file: DesignFile): boolean {
    const cmd = this.commands.get(id);
    if (!cmd) return false;
    return cmd.enabled ? cmd.enabled(ctx, file) : true;
  }
}

let txnCounter = 0;

/**
 * Run a registered command: check it is enabled, produce its forward ops, wrap
 * them in a single transaction, and commit it to history (one undoable step,
 * FR-7/AC-5). Returns the committed transaction, or null if the command is
 * absent, disabled, or produced no ops.
 */
export function runCommand<P>(
  registry: CommandRegistry,
  id: string,
  ctx: CommandContext,
  file: DesignFile,
  history: History,
  payload: P,
  authorId?: string,
): Transaction | null {
  const cmd = registry.get(id);
  if (!cmd) return null;
  if (cmd.enabled && !cmd.enabled(ctx, file)) return null;
  const ops = (cmd as unknown as Command<P>).run(ctx, file, payload);
  if (ops.length === 0) return null;
  const txn: Transaction = {
    id: `txn-${++txnCounter}`,
    label: cmd.label,
    ops,
    authorId,
    ts: 0,
  };
  history.commit(txn);
  return txn;
}
