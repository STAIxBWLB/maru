import { memo, type MouseEvent, type PointerEvent, type ReactElement } from "react";

import type { MatrixCell, MatrixDataset } from "../../../lib/diagram/reportTypes";
import {
  TABLE_GRID_BORDER,
  TABLE_ROLE_FILLS,
  TABLE_TEXT_COLOR,
  cellRect,
  computeTableLayout,
  matrixGrid,
  normalizeRange,
  parseBorderShorthand,
  type CellRect,
} from "../../../lib/diagram/tableEditing";
import type {
  DiagramNode,
  TableCellAddress,
  TableSelection,
} from "../../../lib/diagram/types";

export interface TableViewProps {
  node: DiagramNode;
  matrix: MatrixDataset;
  /** Cell selection for this node (null when the table isn't cell-focused). */
  selection: TableSelection | null;
  /** Node itself is selected → cells are interactive and resize handles show. */
  nodeSelected: boolean;
  onCellPointerDown?: (event: PointerEvent<SVGRectElement>, addr: TableCellAddress) => void;
  onCellDoubleClick?: (event: MouseEvent<SVGRectElement>, addr: TableCellAddress) => void;
  onResizeHandlePointerDown?: (
    event: PointerEvent<SVGRectElement>,
    axis: "col" | "row",
    index: number,
  ) => void;
}

const CELL_FONT_SIZE = 11;
const HANDLE_SIZE = 6;

function borderLine(
  key: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  raw: string | undefined,
): ReactElement | null {
  const parsed = parseBorderShorthand(raw) ?? {
    width: 1,
    color: TABLE_GRID_BORDER,
    dash: false,
  };
  if (parsed.width <= 0) return null;
  return (
    <line
      key={key}
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={parsed.color}
      strokeWidth={parsed.width}
      strokeDasharray={parsed.dash ? "4 3" : undefined}
      pointerEvents="none"
    />
  );
}

function CellText({ cell, rect }: { cell: MatrixCell; rect: CellRect }) {
  const hasBullets = (cell.bullets?.length ?? 0) > 0;
  if (!cell.text && !hasBullets) return null;
  const align = cell.style?.align ?? "left";
  return (
    <foreignObject
      x={rect.x}
      y={rect.y}
      width={Math.max(0, rect.w)}
      height={Math.max(0, rect.h)}
      pointerEvents="none"
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems:
            align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start",
          justifyContent: "center",
          padding: "1px 6px",
          boxSizing: "border-box",
          overflow: "hidden",
          fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif",
          fontSize: CELL_FONT_SIZE,
          lineHeight: 1.3,
          fontWeight: cell.style?.bold ? 700 : 400,
          color: cell.style?.color ?? TABLE_TEXT_COLOR,
          textAlign: align,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {cell.text ? <div>{cell.text}</div> : null}
        {hasBullets ? (
          <ul style={{ margin: 0, paddingLeft: "1.1em", alignSelf: "stretch", textAlign: "left" }}>
            {(cell.bullets ?? []).map((bullet, idx) => (
              <li key={idx}>{bullet}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </foreignObject>
  );
}

/**
 * SVG renderer for a matrix dataset inside a table node's bounds. Draws the
 * background, span-aware cells (role shading + per-cell style), multiline
 * text/bullets, the cell-selection chrome (`data-export-ignore`), and row /
 * column resize handles when the node is selected. Renders in node-local
 * coordinates — the parent `<g transform>` places it on the canvas.
 */
function TableViewBase({
  node,
  matrix,
  selection,
  nodeSelected,
  onCellPointerDown,
  onCellDoubleClick,
  onResizeHandlePointerDown,
}: TableViewProps) {
  const layout = computeTableLayout(matrix, node.w, node.h);
  const grid = matrixGrid(matrix);

  const cells: ReactElement[] = [];
  for (let r = 0; r < matrix.rows.length; r += 1) {
    for (let c = 0; c < matrix.columns.length; c += 1) {
      const cell = grid[r]?.[c];
      if (!cell) continue;
      // Render each anchor once, at its own top-left position.
      if (cell.rowId !== matrix.rows[r]?.id || cell.colId !== matrix.columns[c]?.id) continue;
      const rect = cellRect(matrix, layout, cell, r, c);
      const role = matrix.rows[r]?.role ?? "data";
      const addr: TableCellAddress = { rowId: cell.rowId, colId: cell.colId };
      cells.push(
        <g key={cell.id}>
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill={cell.style?.bg ?? TABLE_ROLE_FILLS[role]}
            data-cell-id={cell.id}
            data-row-id={cell.rowId}
            data-col-id={cell.colId}
            style={nodeSelected ? { cursor: "cell" } : undefined}
            onPointerDown={
              onCellPointerDown ? (event) => onCellPointerDown(event, addr) : undefined
            }
            onDoubleClick={
              onCellDoubleClick ? (event) => onCellDoubleClick(event, addr) : undefined
            }
          />
          {borderLine("t", rect.x, rect.y, rect.x + rect.w, rect.y, cell.style?.borders?.top)}
          {borderLine("b", rect.x, rect.y + rect.h, rect.x + rect.w, rect.y + rect.h, cell.style?.borders?.bottom)}
          {borderLine("l", rect.x, rect.y, rect.x, rect.y + rect.h, cell.style?.borders?.left)}
          {borderLine("r", rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + rect.h, cell.style?.borders?.right)}
          <CellText cell={cell} rect={rect} />
        </g>,
      );
    }
  }

  // Selection chrome: range fill + active-cell outline (never exported).
  let chrome: ReactElement | null = null;
  if (selection) {
    const range = normalizeRange(matrix, selection);
    if (range) {
      let rangeW = 0;
      for (let c = range.c1; c <= range.c2; c += 1) rangeW += layout.colW[c] ?? 0;
      let rangeH = 0;
      for (let r = range.r1; r <= range.r2; r += 1) rangeH += layout.rowH[r] ?? 0;
      const focusCell = (() => {
        for (const cell of Object.values(matrix.cells)) {
          if (cell.rowId === selection.focus.rowId && cell.colId === selection.focus.colId) {
            return cell;
          }
        }
        return null;
      })();
      const focusIndex = {
        r: matrix.rows.findIndex((row) => row.id === selection.focus.rowId),
        c: matrix.columns.findIndex((col) => col.id === selection.focus.colId),
      };
      const focusRect =
        focusCell && focusIndex.r >= 0 && focusIndex.c >= 0
          ? cellRect(matrix, layout, focusCell, focusIndex.r, focusIndex.c)
          : null;
      chrome = (
        <g data-export-ignore pointerEvents="none">
          <rect
            data-table-range
            x={layout.colX[range.c1] ?? 0}
            y={layout.rowY[range.r1] ?? 0}
            width={rangeW}
            height={rangeH}
            fill="rgba(37, 99, 235, 0.10)"
            stroke="#2563eb"
            strokeWidth={1}
          />
          {focusRect ? (
            <rect
              data-table-active-cell
              x={focusRect.x}
              y={focusRect.y}
              width={focusRect.w}
              height={focusRect.h}
              fill="none"
              stroke="#2563eb"
              strokeWidth={2}
            />
          ) : null}
        </g>
      );
    }
  }

  // Resize handles: right edge of each column, bottom edge of each row.
  let handles: ReactElement | null = null;
  if (nodeSelected && onResizeHandlePointerDown) {
    const parts: ReactElement[] = [];
    for (let i = 0; i < matrix.columns.length; i += 1) {
      const right = (layout.colX[i] ?? 0) + (layout.colW[i] ?? 0);
      parts.push(
        <rect
          key={`col-${i}`}
          data-export-ignore
          data-resize-handle="col"
          data-index={i}
          x={right - HANDLE_SIZE / 2}
          y={0}
          width={HANDLE_SIZE}
          height={Math.min(12, node.h)}
          fill="rgba(37, 99, 235, 0.35)"
          style={{ cursor: "col-resize" }}
          onPointerDown={(event) => onResizeHandlePointerDown(event, "col", i)}
        />,
      );
    }
    for (let i = 0; i < matrix.rows.length; i += 1) {
      const bottom = (layout.rowY[i] ?? 0) + (layout.rowH[i] ?? 0);
      parts.push(
        <rect
          key={`row-${i}`}
          data-export-ignore
          data-resize-handle="row"
          data-index={i}
          x={0}
          y={bottom - HANDLE_SIZE / 2}
          width={Math.min(12, node.w)}
          height={HANDLE_SIZE}
          fill="rgba(37, 99, 235, 0.35)"
          style={{ cursor: "row-resize" }}
          onPointerDown={(event) => onResizeHandlePointerDown(event, "row", i)}
        />,
      );
    }
    handles = <g>{parts}</g>;
  }

  return (
    <g data-table-view={node.id}>
      <rect
        width={node.w}
        height={node.h}
        rx={node.style?.br ?? 4}
        ry={node.style?.br ?? 4}
        fill={node.style?.bg ?? "#ffffff"}
        stroke={node.style?.border ?? "#1f2937"}
        strokeWidth={node.style?.bw ?? 1.5}
        pointerEvents="none"
      />
      {cells}
      {chrome}
      {handles}
    </g>
  );
}

export const TableView = memo(TableViewBase);
