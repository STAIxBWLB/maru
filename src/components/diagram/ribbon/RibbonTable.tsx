import { useState } from "react";

import { defaultCoalescer, updateNode, withSnapshot } from "../../../lib/diagram/actions";
import {
  KNOWN_SEMANTIC_TAGS,
  MATRIX_MAX_COLS,
  MATRIX_MAX_ROWS,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  mergeCells,
  splitCell,
  type MatrixCellStyle,
  type MatrixDataset,
  type MatrixRowRole,
  type SemanticTag,
} from "../../../lib/diagram/reportTypes";
import {
  matrixForTableNode,
  setCellsStyle,
  setCellsText,
  setColumnTag,
  setRowRole,
  updateMatrix,
} from "../../../lib/diagram/tableActions";
import {
  anchorIdsInRange,
  canInsertColumn,
  canInsertRow,
  cellAtAddr,
  expandRangeToSpans,
  nonEmptyCellCount,
  normalizeRange,
} from "../../../lib/diagram/tableEditing";
import type { DiagramNode } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";
import { RibbonButton, RibbonGroup, RibbonSeparator } from "./ribbonPrimitives";

/**
 * Table ribbon — operates on the matrix dataset of the selected view-linked
 * table node. Structural ops pre-compute the next matrix with the pure
 * `reportTypes` helpers so thrown errors (span anchors, non-rectangular
 * merges) become localized notices instead of broken state; the computed
 * result is then dispatched through `withSnapshot` as one undo entry.
 */
export function RibbonTable() {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const selection = useDiagram((s) => s.ephemeral.selection);
  const tableSelection = useDiagram((s) => s.ephemeral.tableSelection);
  const nodes = useDiagram((s) => s.doc.nodes);
  const datasets = useDiagram((s) => s.doc.datasets);

  const table = nodes.find((node) => selection.nodes.has(node.id) && node.kind === "table");
  const matrix = table ? matrixForTableNode(table, datasets) : null;
  const sel = table && tableSelection && tableSelection.nodeId === table.id ? tableSelection : null;

  const [notice, setNotice] = useState<string | null>(null);
  const [fillText, setFillText] = useState("");
  const [styleClipboard, setStyleClipboard] = useState<MatrixCellStyle | null>(null);

  const range = matrix && sel ? normalizeRange(matrix, sel) : null;
  const expanded = matrix && range ? expandRangeToSpans(matrix, range) : null;
  const rangeIds = matrix && expanded ? anchorIdsInRange(matrix, expanded) : [];
  const focusCell = matrix && sel ? cellAtAddr(matrix, sel.focus) : null;
  const focusRowId = focusCell?.rowId ?? null;
  const focusColId = focusCell?.colId ?? null;
  const focusRow = matrix?.rows.find((row) => row.id === focusRowId) ?? null;
  const focusCol = matrix?.columns.find((col) => col.id === focusColId) ?? null;

  const disabled = !table || !matrix;
  const cellOpsDisabled = disabled || !sel || !expanded;

  /** Pre-compute with the pure op (catching errors), then dispatch once. */
  const applyMatrixOp = (next: MatrixDataset) => {
    if (!matrix) return;
    store.setState(withSnapshot(updateMatrix(matrix.id, () => next), defaultCoalescer()));
  };

  const fail = (err: unknown, fallbackKey: string) => {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("multi-row span")) setNotice(t("diagram.table.error.spanRow"));
    else if (message.includes("multi-column span")) setNotice(t("diagram.table.error.spanCol"));
    else if (message.includes("rectangle")) setNotice(t("diagram.table.error.mergeRectangle"));
    else setNotice(t(fallbackKey));
  };

  const onInsertRow = () => {
    if (!matrix) return;
    if (!canInsertRow(matrix)) {
      setNotice(t("diagram.table.error.limit", { max: String(MATRIX_MAX_ROWS) }));
      return;
    }
    setNotice(null);
    applyMatrixOp(insertRow(matrix, expanded ? expanded.r2 + 1 : matrix.rows.length));
  };

  const onDeleteRow = () => {
    if (!matrix || !focusRowId) return;
    if (matrix.rows.length <= 1) return;
    const rowCells = Object.values(matrix.cells).filter((cell) => cell.rowId === focusRowId);
    if (rowCells.some((cell) => cell.text.trim()) && !window.confirm(t("diagram.table.confirm.deleteRow"))) {
      return;
    }
    setNotice(null);
    try {
      applyMatrixOp(deleteRow(matrix, focusRowId));
    } catch (err) {
      fail(err, "diagram.table.error.spanRow");
    }
  };

  const onInsertColumn = () => {
    if (!matrix) return;
    if (!canInsertColumn(matrix)) {
      setNotice(t("diagram.table.error.limit", { max: String(MATRIX_MAX_COLS) }));
      return;
    }
    setNotice(null);
    applyMatrixOp(insertColumn(matrix, expanded ? expanded.c2 + 1 : matrix.columns.length));
  };

  const onDeleteColumn = () => {
    if (!matrix || !focusColId) return;
    if (matrix.columns.length <= 1) return;
    const colCells = Object.values(matrix.cells).filter((cell) => cell.colId === focusColId);
    if (colCells.some((cell) => cell.text.trim()) && !window.confirm(t("diagram.table.confirm.deleteCol"))) {
      return;
    }
    setNotice(null);
    try {
      applyMatrixOp(deleteColumn(matrix, focusColId));
    } catch (err) {
      fail(err, "diagram.table.error.spanCol");
    }
  };

  const onMerge = () => {
    if (!matrix || rangeIds.length < 2) return;
    const nonEmpty = nonEmptyCellCount(matrix, rangeIds);
    if (nonEmpty > 1 && !window.confirm(t("diagram.table.confirm.merge", { count: String(nonEmpty) }))) {
      return;
    }
    setNotice(null);
    try {
      applyMatrixOp(mergeCells(matrix, rangeIds));
    } catch (err) {
      fail(err, "diagram.table.error.mergeRectangle");
    }
  };

  const onSplit = () => {
    if (!matrix || !focusCell) return;
    setNotice(null);
    try {
      applyMatrixOp(splitCell(matrix, focusCell.id));
    } catch (err) {
      fail(err, "diagram.table.error.mergeRectangle");
    }
  };

  const applyStyle = (patch: MatrixCellStyle) => {
    if (!matrix || rangeIds.length === 0) return;
    setNotice(null);
    store.setState(withSnapshot(setCellsStyle(matrix.id, rangeIds, patch), defaultCoalescer()));
  };

  const applyFill = () => {
    if (!matrix || rangeIds.length === 0) return;
    setNotice(null);
    store.setState(withSnapshot(setCellsText(matrix.id, rangeIds, fillText), defaultCoalescer()));
  };

  const applyRole = (role: MatrixRowRole) => {
    if (!matrix || !focusRowId) return;
    setNotice(null);
    store.setState(withSnapshot(setRowRole(matrix.id, focusRowId, role), defaultCoalescer()));
  };

  const applyTag = (tag: SemanticTag | null) => {
    if (!matrix || !focusColId) return;
    setNotice(null);
    store.setState(withSnapshot(setColumnTag(matrix.id, focusColId, tag), defaultCoalescer()));
  };

  const borderAll: MatrixCellStyle = {
    borders: {
      top: "1px solid #94a3b8",
      right: "1px solid #94a3b8",
      bottom: "1px solid #94a3b8",
      left: "1px solid #94a3b8",
    },
  };
  const borderNone: MatrixCellStyle = {
    borders: { top: "none", right: "none", bottom: "none", left: "none" },
  };

  const focusSpanning = focusCell && ((focusCell.rowSpan ?? 1) > 1 || (focusCell.colSpan ?? 1) > 1);

  // Legacy unlinked tables (pre-migration bodies that skipped the upgrade):
  // keep the old meta.rows/cols patcher so they remain editable.
  const patchLegacy = (node: DiagramNode, patch: Record<string, unknown>) => {
    store.setState(
      withSnapshot(
        updateNode(node.id, { meta: { ...(node.meta ?? {}), ...patch } }),
        defaultCoalescer(),
      ),
    );
  };

  if (table && !matrix) {
    const rows = Math.max(1, Number(table.meta?.rows) || 3);
    const cols = Math.max(1, Number(table.meta?.cols) || 3);
    return (
      <>
        <RibbonGroup labelKey="diagram.ribbon.group.tableSize">
          <RibbonButton
            labelKey="diagram.table.rowAdd"
            disabled={rows >= 20}
            onClick={() => patchLegacy(table, { rows: rows + 1 })}
          />
          <RibbonButton
            labelKey="diagram.table.rowRemove"
            disabled={rows <= 1}
            onClick={() => patchLegacy(table, { rows: rows - 1 })}
          />
          <RibbonButton
            labelKey="diagram.table.colAdd"
            disabled={cols >= 20}
            onClick={() => patchLegacy(table, { cols: cols + 1 })}
          />
          <RibbonButton
            labelKey="diagram.table.colRemove"
            disabled={cols <= 1}
            onClick={() => patchLegacy(table, { cols: cols - 1 })}
          />
        </RibbonGroup>
        <RibbonSeparator />
        <RibbonGroup labelKey="diagram.ribbon.group.tableMeta">
          <span className="maru-diagram-ribbon-hint">
            {t("diagram.table.count", { rows: String(rows), cols: String(cols) })}
          </span>
        </RibbonGroup>
      </>
    );
  }

  return (
    <>
      <RibbonGroup labelKey="diagram.ribbon.group.tableSize">
        <RibbonButton
          labelKey="diagram.table.rowAdd"
          disabled={disabled || !matrix || matrix.rows.length >= MATRIX_MAX_ROWS}
          onClick={onInsertRow}
        />
        <RibbonButton
          labelKey="diagram.table.rowRemove"
          disabled={disabled || !sel || !matrix || matrix.rows.length <= 1}
          onClick={onDeleteRow}
        />
        <RibbonButton
          labelKey="diagram.table.colAdd"
          disabled={disabled || !matrix || matrix.columns.length >= MATRIX_MAX_COLS}
          onClick={onInsertColumn}
        />
        <RibbonButton
          labelKey="diagram.table.colRemove"
          disabled={disabled || !sel || !matrix || matrix.columns.length <= 1}
          onClick={onDeleteColumn}
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.tableCells">
        <RibbonButton
          labelKey="diagram.table.merge"
          disabled={cellOpsDisabled || rangeIds.length < 2}
          onClick={onMerge}
        />
        <RibbonButton
          labelKey="diagram.table.split"
          disabled={cellOpsDisabled || !focusSpanning}
          onClick={onSplit}
        />
        <label className="maru-diagram-snap-input" title={t("diagram.table.fill.apply")}>
          <input
            type="text"
            value={fillText}
            placeholder={t("diagram.table.fill.placeholder")}
            aria-label={t("diagram.table.fill.placeholder")}
            onChange={(event) => setFillText(event.target.value)}
          />
        </label>
        <RibbonButton
          labelKey="diagram.table.fill.apply"
          disabled={cellOpsDisabled || rangeIds.length === 0}
          onClick={applyFill}
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.tableRole">
        <RibbonButton
          labelKey="diagram.table.role.header"
          disabled={cellOpsDisabled}
          active={focusRow?.role === "header"}
          onClick={() => applyRole(focusRow?.role === "header" ? "data" : "header")}
        />
        <RibbonButton
          labelKey="diagram.table.role.group"
          disabled={cellOpsDisabled}
          active={focusRow?.role === "group"}
          onClick={() => applyRole("group")}
        />
        <RibbonButton
          labelKey="diagram.table.role.subtotal"
          disabled={cellOpsDisabled}
          active={focusRow?.role === "subtotal"}
          onClick={() => applyRole("subtotal")}
        />
        <RibbonButton
          labelKey="diagram.table.role.data"
          disabled={cellOpsDisabled}
          active={focusRow?.role === "data"}
          onClick={() => applyRole("data")}
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.tableStyle">
        <RibbonButton
          labelKey="diagram.table.align.left"
          disabled={cellOpsDisabled}
          active={focusCell?.style?.align === "left"}
          onClick={() => applyStyle({ align: "left" })}
        />
        <RibbonButton
          labelKey="diagram.table.align.center"
          disabled={cellOpsDisabled}
          active={focusCell?.style?.align === "center"}
          onClick={() => applyStyle({ align: "center" })}
        />
        <RibbonButton
          labelKey="diagram.table.align.right"
          disabled={cellOpsDisabled}
          active={focusCell?.style?.align === "right"}
          onClick={() => applyStyle({ align: "right" })}
        />
        <RibbonButton
          labelKey="diagram.table.bold"
          disabled={cellOpsDisabled}
          active={focusCell?.style?.bold === true}
          onClick={() => applyStyle({ bold: !focusCell?.style?.bold })}
        />
        <RibbonButton
          labelKey="diagram.table.borders.all"
          disabled={cellOpsDisabled}
          onClick={() => applyStyle(borderAll)}
        />
        <RibbonButton
          labelKey="diagram.table.borders.none"
          disabled={cellOpsDisabled}
          onClick={() => applyStyle(borderNone)}
        />
        <label className="maru-diagram-snap-input" title={t("diagram.table.bg")}>
          <span>{t("diagram.table.bg")}</span>
          <input
            type="color"
            value={focusCell?.style?.bg ?? "#ffffff"}
            aria-label={t("diagram.table.bg")}
            disabled={cellOpsDisabled}
            onChange={(event) => applyStyle({ bg: event.target.value })}
          />
        </label>
        <label className="maru-diagram-snap-input" title={t("diagram.table.color")}>
          <span>{t("diagram.table.color")}</span>
          <input
            type="color"
            value={focusCell?.style?.color ?? "#111827"}
            aria-label={t("diagram.table.color")}
            disabled={cellOpsDisabled}
            onChange={(event) => applyStyle({ color: event.target.value })}
          />
        </label>
        <RibbonButton
          labelKey="diagram.table.style.copy"
          disabled={cellOpsDisabled || !focusCell}
          onClick={() => setStyleClipboard(focusCell?.style ? { ...focusCell.style } : null)}
        />
        <RibbonButton
          labelKey="diagram.table.style.paste"
          disabled={cellOpsDisabled || !styleClipboard || rangeIds.length === 0}
          onClick={() => styleClipboard && applyStyle(styleClipboard)}
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.tableTag">
        <label className="maru-diagram-snap-input" title={t("diagram.table.tag.column")}>
          <span>{t("diagram.table.tag.column")}</span>
          <select
            value={focusCol?.tag ?? ""}
            aria-label={t("diagram.table.tag.column")}
            disabled={cellOpsDisabled}
            onChange={(event) => applyTag(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">{t("diagram.table.tag.none")}</option>
            {KNOWN_SEMANTIC_TAGS.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </label>
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.tableMeta">
        <span className="maru-diagram-ribbon-hint">
          {notice ??
            (disabled || !matrix
              ? t("diagram.table.selectHint")
              : t("diagram.table.count", {
                  rows: String(matrix.rows.length),
                  cols: String(matrix.columns.length),
                }))}
        </span>
      </RibbonGroup>
    </>
  );
}
