/**
 * Undo / redo history for the diagram doc.
 *
 * Rather than the source's per-keystroke JSON snapshot ring (which grew memory
 * unboundedly), we hold up to {@link HISTORY_CAP} JSON-stringified docs in a
 * ring. The next stage will replace this with a command/inverse-command pattern,
 * but the public API ({@link snapshot}/{@link undo}/{@link redo}) will stay
 * stable so call sites don't need to change.
 *
 * {@link createCoalescer} debounces rapid edits (drags, key entry) into a single
 * history entry by suppressing snapshot calls within `windowMs` of the previous
 * snapshot. The next "real" snapshot (after the window elapses) commits the
 * latest doc.
 */

import type { DiagramDoc } from "./types";

export const HISTORY_CAP = 80 as const;

export interface History {
  past: string[];
  future: string[];
}

export function emptyHistory(): History {
  return { past: [], future: [] };
}

/** Push a snapshot of {@link doc}; drop redo branch; cap at {@link HISTORY_CAP}. */
export function snapshot(history: History, doc: DiagramDoc): History {
  const entry = JSON.stringify(doc);
  if (history.past[history.past.length - 1] === entry) return history;
  const past = [...history.past, entry];
  if (past.length > HISTORY_CAP) past.shift();
  return { past, future: [] };
}

/** Pop the most recent snapshot; returns the restored doc and updated history. */
export function undo(history: History, current: DiagramDoc): {
  history: History;
  doc: DiagramDoc;
} | null {
  if (history.past.length === 0) return null;
  const next = history.past.slice(0, -1);
  const previous = history.past[history.past.length - 1];
  if (!previous) return null;
  const restored = JSON.parse(previous) as DiagramDoc;
  const future = [JSON.stringify(current), ...history.future];
  if (future.length > HISTORY_CAP) future.pop();
  return { history: { past: next, future }, doc: restored };
}

export function redo(history: History, current: DiagramDoc): {
  history: History;
  doc: DiagramDoc;
} | null {
  if (history.future.length === 0) return null;
  const [first, ...rest] = history.future;
  if (!first) return null;
  const restored = JSON.parse(first) as DiagramDoc;
  const past = [...history.past, JSON.stringify(current)];
  if (past.length > HISTORY_CAP) past.shift();
  return { history: { past, future: rest }, doc: restored };
}

/** Suppress further snapshots within `windowMs` after the most recent one. */
export interface Coalescer {
  shouldSnapshot(now: number): boolean;
  reset(now: number): void;
}

export function createCoalescer(windowMs: number = 500): Coalescer {
  let lastAt = Number.NEGATIVE_INFINITY;
  return {
    shouldSnapshot(now: number): boolean {
      return now - lastAt >= windowMs;
    },
    reset(now: number): void {
      lastAt = now;
    },
  };
}
