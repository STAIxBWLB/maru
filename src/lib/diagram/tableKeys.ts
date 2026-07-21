/**
 * Pure keyboard mapping for table cell editing. `nextTableKeyAction` inspects
 * a keydown (already known to be outside text fields and IME composition) plus
 * the current state, and returns the intended action; the DiagramMode handler
 * applies it (store dispatch or opening the cell editor). Keeping this pure
 * makes the whole spreadsheet keyboard flow unit-testable without React.
 */

import { matchesShortcut } from "./shortcuts";
import {
  anchorIdsInRange,
  expandRangeToSpans,
  moveFocus,
  normalizeRange,
  parseTsv,
  serializeRangeToTsv,
} from "./tableEditing";
import { matrixForTableNode } from "./tableActions";
import type { DiagramStateRoot, TableCellAddress, TableSelection } from "./types";

export type TableKeyAction =
  | { kind: "select"; selection: TableSelection }
  | { kind: "clearRange"; datasetId: string; cellIds: string[] }
  | { kind: "edit"; addr: TableCellAddress; initial?: string }
  | { kind: "copy"; texts: string[][] }
  | { kind: "paste" };

interface TableKeyContext {
  selection: TableSelection;
  datasetId: string;
  matrix: NonNullable<ReturnType<typeof matrixForTableNode>>;
}

function tableContext(state: DiagramStateRoot): TableKeyContext | null {
  const ts = state.ephemeral.tableSelection;
  if (!ts) return null;
  const node = state.doc.nodes.find((n) => n.id === ts.nodeId);
  if (!node || node.locked) return null;
  const matrix = matrixForTableNode(node, state.doc.datasets);
  if (!matrix) return null;
  return { selection: ts, datasetId: matrix.id, matrix };
}

function expandedRangeIds(ctx: TableKeyContext): string[] | null {
  const range = normalizeRange(ctx.matrix, ctx.selection);
  if (!range) return null;
  return anchorIdsInRange(ctx.matrix, expandRangeToSpans(ctx.matrix, range));
}

/**
 * Returns the table action for a keydown, or null when the key isn't a table
 * shortcut (caller falls through to node-level shortcuts). Callers must
 * guard `isInEditable` and IME composition before calling.
 */
export function nextTableKeyAction(
  event: KeyboardEvent,
  state: DiagramStateRoot,
): TableKeyAction | null {
  const ctx = tableContext(state);
  if (!ctx) return null;
  const { selection, matrix } = ctx;

  // Clipboard shortcuts.
  if (matchesShortcut(event, { key: "c", mod: true })) {
    const range = normalizeRange(matrix, selection);
    if (!range) return null;
    // Round-trip through TSV so the clipboard grid matches what paste expects.
    return { kind: "copy", texts: parseTsv(serializeRangeToTsv(matrix, range)) };
  }
  if (matchesShortcut(event, { key: "v", mod: true })) {
    if (state.ephemeral.clipboard?.kind !== "cells") return null;
    return { kind: "paste" };
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return null;

  // Navigation / editing.
  if (event.key === "F2") {
    return { kind: "edit", addr: selection.focus };
  }
  if (event.key === "Tab") {
    return {
      kind: "select",
      selection: moveFocus(matrix, selection, 0, event.shiftKey ? -1 : 1, false),
    };
  }
  if (event.key === "Enter") {
    return {
      kind: "select",
      selection: moveFocus(matrix, selection, event.shiftKey ? -1 : 1, 0, false),
    };
  }
  const arrows: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };
  const delta = arrows[event.key];
  if (delta) {
    return {
      kind: "select",
      selection: moveFocus(matrix, selection, delta[0], delta[1], event.shiftKey),
    };
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    const ids = expandedRangeIds(ctx);
    if (!ids || ids.length === 0) return null;
    return { kind: "clearRange", datasetId: ctx.datasetId, cellIds: ids };
  }
  if (event.key === "Escape") {
    return null; // caller clears the table selection itself
  }
  // Printable character opens the editor seeded with that character
  // (standard spreadsheet quick-entry).
  if (event.key.length === 1) {
    return { kind: "edit", addr: selection.focus, initial: event.key };
  }
  return null;
}
