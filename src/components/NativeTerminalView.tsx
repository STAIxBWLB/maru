import type React from "react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type {
  TerminalCell,
  TerminalColor,
  TerminalFrame,
  TerminalInputCommand,
  TerminalMouseFlags,
} from "../lib/api";

export interface NativeTerminalViewHandle {
  focus: () => void;
}

interface NativeTerminalViewProps {
  sessionId: string;
  frame: TerminalFrame | null;
  active: boolean;
  focused: boolean;
  resizeReady: boolean;
  inputLabel: string;
  onInput: (command: TerminalInputCommand) => void;
  onResize: (cols: number, rows: number) => void;
  onScroll: (delta: number) => void;
}

interface CellPoint {
  row: number;
  col: number;
}

interface CellSelection {
  anchor: CellPoint;
  focus: CellPoint;
}

interface CellRange {
  start: CellPoint;
  end: CellPoint;
}

interface TerminalInputEventLike {
  data: string | null;
  inputType: string;
  isComposing?: boolean;
}

interface CompositionSession {
  text: string;
  at: number;
}

interface EnterDuringComposition {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

interface TerminalMetrics {
  charWidth: number;
  lineHeight: number;
  fontSize: number;
  fontFamily: string;
  fontCss: string;
  padLeft: number;
  padTop: number;
}

interface PointerState {
  mode: "select" | "mouse";
  button: number;
}

/** macOS WKWebView can emit a trailing `insertText` carrying the same text a
 *  hair after `compositionend`. We drop it only inside this tight window; a
 *  fresh composition of the same syllable starts a new session and is kept. */
const COMPOSITION_TRAILING_MS = 100;
const DEFAULT_FG = "#d4d4d4";
const DEFAULT_BG = "#111111";
const SELECTION_FILL = "rgba(56, 99, 161, 0.40)";
const CURSOR_COLOR = "#d4d4d4";

const ANSI_COLORS: Record<string, string> = {
  Black: "#111111",
  Red: "#f87171",
  Green: "#8bc891",
  Yellow: "#e5c07b",
  Blue: "#7aa2f7",
  Magenta: "#c792ea",
  Cyan: "#70c0ba",
  White: "#d4d4d4",
  BrightBlack: "#5f5f5f",
  BrightRed: "#ff8f8f",
  BrightGreen: "#a8d8ae",
  BrightYellow: "#f0d38c",
  BrightBlue: "#9bbcff",
  BrightMagenta: "#d7a4f3",
  BrightCyan: "#89d8d1",
  BrightWhite: "#ffffff",
  Foreground: "#d4d4d4",
  Background: "#111111",
};

const INDEXED_COLORS = [
  "#111111",
  "#f87171",
  "#8bc891",
  "#e5c07b",
  "#7aa2f7",
  "#c792ea",
  "#70c0ba",
  "#d4d4d4",
  "#5f5f5f",
  "#ff8f8f",
  "#a8d8ae",
  "#f0d38c",
  "#9bbcff",
  "#d7a4f3",
  "#89d8d1",
  "#ffffff",
];

export function terminalColorToCss(color: TerminalColor, fallback: string): string {
  if (color.kind === "rgb") return `rgb(${color.r}, ${color.g}, ${color.b})`;
  if (color.kind === "indexed") return INDEXED_COLORS[color.index] ?? fallback;
  return ANSI_COLORS[color.name] ?? fallback;
}

export function frameLineToText(line: TerminalCell[]): string {
  return line
    .filter((cell) => cell.width !== 0)
    .map((cell) => cell.ch || " ")
    .join("")
    .replace(/\s+$/u, "");
}

export function frameToText(frame: TerminalFrame | null): string {
  if (!frame) return "";
  return frame.lines.map(frameLineToText).join("\n");
}

export function cellDisplayWidth(cell: TerminalCell): string {
  if (cell.width <= 0) return "0";
  return `${cell.width}ch`;
}

export function cellDisplayText(cell: TerminalCell): string {
  if (cell.width <= 0) return "";
  return cell.ch || " ";
}

function comparePoint(a: CellPoint, b: CellPoint): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

export function normalizeSelection(selection: CellSelection): CellRange {
  return comparePoint(selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

/** Selected column span within `row`, or null if the row is outside the
 *  selection. End column clamps to the last column of the row. */
export function selectionSpanForRow(
  range: CellRange,
  row: number,
  cols: number,
): { start: number; end: number } | null {
  if (row < range.start.row || row > range.end.row) return null;
  const start = row === range.start.row ? range.start.col : 0;
  const end = row === range.end.row ? range.end.col : cols - 1;
  if (end < start) return null;
  return { start, end };
}

export function selectedTerminalText(
  lines: TerminalCell[][] | null,
  selection: CellSelection | null,
): string {
  if (!lines || !selection) return "";
  const { start, end } = normalizeSelection(selection);
  const chunks: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const line = lines[row] ?? [];
    const startCol = row === start.row ? start.col : 0;
    const endCol = row === end.row ? end.col : line.length - 1;
    const text = line
      .slice(startCol, endCol + 1)
      .filter((cell) => cell.width !== 0)
      .map((cell) => cell.ch || " ")
      .join("")
      .replace(/\s+$/u, "");
    chunks.push(text);
  }
  return chunks.join("\n");
}

export function terminalKeyEventToInput(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing"
  >,
): TerminalInputCommand | null {
  if (event.isComposing) return null;
  if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
    return null;
  }
  if (event.key === "Meta" || event.key === "Control" || event.key === "Alt" || event.key === "Shift") {
    return null;
  }
  return {
    type: "key",
    key: event.key,
    code: event.code,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
  };
}

export function normalizeTerminalInputText(text: string): string {
  return text.normalize("NFC");
}

export function terminalBeforeInputToText(
  event: TerminalInputEventLike,
  composing: boolean,
): string | null {
  if (composing || event.isComposing || event.inputType === "insertCompositionText") {
    return null;
  }
  if (event.inputType !== "insertText") return null;
  const text = normalizeTerminalInputText(event.data ?? "");
  return text ? text : null;
}

export function terminalInputEventToText(
  event: TerminalInputEventLike,
  textareaValue: string,
  composing: boolean,
): string | null {
  if (composing || event.isComposing || event.inputType === "insertCompositionText") {
    return null;
  }
  if (event.inputType && event.inputType !== "insertText") return null;
  const text = normalizeTerminalInputText(event.data ?? textareaValue);
  return text ? text : null;
}

/** True when an `insertText` is the WKWebView trailing echo of the text we
 *  just committed at `compositionend` (same text, within the guard window). */
export function isTrailingCompositionDuplicate(
  text: string,
  session: CompositionSession | null,
  now: number,
  windowMs = COMPOSITION_TRAILING_MS,
): boolean {
  return Boolean(session && session.text === text && now - session.at <= windowMs);
}

export function finalCompositionText(eventData: string, textareaValue: string): string {
  return normalizeTerminalInputText(eventData || textareaValue);
}

/** Map a DOM `MouseEvent.button` to a terminal mouse button code
 *  (0=left, 1=middle, 2=right). Anything else falls back to left. */
export function domButtonToTerminal(button: number): number {
  if (button === 1) return 1;
  if (button === 2) return 2;
  return 0;
}

function mouseModeActive(mouse: TerminalMouseFlags | null | undefined): boolean {
  return Boolean(mouse && (mouse.click || mouse.motion || mouse.drag));
}

export const NativeTerminalView = memo(
  forwardRef<NativeTerminalViewHandle, NativeTerminalViewProps>(function NativeTerminalView(
    { sessionId, frame, active, focused, resizeReady, inputLabel, onInput, onResize, onScroll },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    // IME composition state.
    const composingRef = useRef(false);
    const compositionSessionRef = useRef<CompositionSession | null>(null);
    const enterDuringCompositionRef = useRef<EnterDuringComposition | null>(null);

    // Retained terminal grid + metrics (mutated outside React for paint speed).
    const gridRef = useRef<TerminalCell[][]>([]);
    const dimsRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
    const cursorRef = useRef<{ row: number; col: number; visible: boolean }>({
      row: 0,
      col: 0,
      visible: false,
    });
    const metricsRef = useRef<TerminalMetrics | null>(null);
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const rectRef = useRef<DOMRect | null>(null);
    const focusedRef = useRef(focused);
    const mouseRef = useRef<TerminalMouseFlags | null>(null);

    // Pointer / selection state.
    const pointerStateRef = useRef<PointerState | null>(null);
    const lastMotionAtRef = useRef(0);
    const lastMotionCellRef = useRef<CellPoint | null>(null);
    const wheelAccumRef = useRef(0);
    const [selection, setSelection] = useState<CellSelection | null>(null);
    const selectionRangeRef = useRef<CellRange | null>(null);
    const prevSelectionRangeRef = useRef<CellRange | null>(null);

    // Paint scheduling.
    const pendingPaintRef = useRef<"all" | Set<number> | null>(null);
    const rafRef = useRef<number | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
      }),
      [],
    );

    useEffect(() => {
      if (focused && active) textareaRef.current?.focus();
    }, [active, focused]);

    const paint = useCallback((which: "all" | number[]) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      const m = metricsRef.current;
      const grid = gridRef.current;
      if (!canvas || !ctx || !m) return;
      const { cols, rows } = dimsRef.current;
      if (cols === 0 || rows === 0) return;

      const rowList = which === "all" ? rangeRows(0, rows - 1) : which;
      const cursor = cursorRef.current;
      const sel = selectionRangeRef.current;
      const showCursor = cursor.visible && !composingRef.current;
      const baselineY = (rowTop: number) =>
        rowTop + Math.max(0, (m.lineHeight - m.fontSize) / 2);

      ctx.textBaseline = "top";

      for (const r of rowList) {
        if (r < 0 || r >= rows) continue;
        const cells = grid[r];
        const y = m.padTop + r * m.lineHeight;
        const rowWidth = cols * m.charWidth;
        ctx.clearRect(m.padLeft, y, rowWidth, m.lineHeight);
        if (!cells) continue;

        // Background runs.
        let c = 0;
        while (c < cols) {
          const cell = cells[c];
          if (!cell) {
            c += 1;
            continue;
          }
          const bg = cellBg(cell);
          let end = c;
          while (end + 1 < cols) {
            const next = cells[end + 1];
            if (!next || cellBg(next) !== bg) break;
            end += 1;
          }
          if (bg !== DEFAULT_BG) {
            ctx.fillStyle = bg;
            ctx.fillRect(m.padLeft + c * m.charWidth, y, (end - c + 1) * m.charWidth, m.lineHeight);
          }
          c = end + 1;
        }

        // Glyphs + underline.
        const ty = baselineY(y);
        for (let col = 0; col < cols; col += 1) {
          const cell = cells[col];
          if (!cell || cell.width === 0) continue;
          const x = m.padLeft + col * m.charWidth;
          const fg = cellFg(cell);
          if (cell.ch && cell.ch !== " ") {
            ctx.font = cellFont(cell, m);
            ctx.fillStyle = fg;
            ctx.fillText(cell.ch, x, ty);
          }
          if (cell.underline) {
            const uy = Math.round(y + m.lineHeight - 1) + 0.5;
            ctx.strokeStyle = fg;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, uy);
            ctx.lineTo(x + (cell.width || 1) * m.charWidth, uy);
            ctx.stroke();
          }
        }

        // Cursor.
        if (showCursor && cursor.row === r) {
          const cell = cells[cursor.col];
          const cx = m.padLeft + cursor.col * m.charWidth;
          const cw = (cell?.width === 2 ? 2 : 1) * m.charWidth;
          if (focusedRef.current) {
            ctx.fillStyle = CURSOR_COLOR;
            ctx.fillRect(cx, y, cw, m.lineHeight);
            if (cell?.ch && cell.ch !== " ") {
              ctx.font = cellFont(cell, m);
              ctx.fillStyle = DEFAULT_BG;
              ctx.fillText(cell.ch, cx, ty);
            }
          } else {
            ctx.strokeStyle = CURSOR_COLOR;
            ctx.lineWidth = 1;
            ctx.strokeRect(cx + 0.5, y + 0.5, cw - 1, m.lineHeight - 1);
          }
        }

        // Selection overlay.
        if (sel) {
          const span = selectionSpanForRow(sel, r, cols);
          if (span) {
            ctx.fillStyle = SELECTION_FILL;
            ctx.fillRect(
              m.padLeft + span.start * m.charWidth,
              y,
              (span.end - span.start + 1) * m.charWidth,
              m.lineHeight,
            );
          }
        }
      }

      ctx.font = m.fontCss;
    }, []);

    const requestPaint = useCallback(
      (which: "all" | number[]) => {
        const pending = pendingPaintRef.current;
        if (which === "all") {
          pendingPaintRef.current = "all";
        } else if (pending === "all") {
          // already full
        } else {
          const set = pending ?? new Set<number>();
          which.forEach((r) => set.add(r));
          pendingPaintRef.current = set;
        }
        if (rafRef.current == null) {
          rafRef.current = window.requestAnimationFrame(() => {
            rafRef.current = null;
            const work = pendingPaintRef.current;
            pendingPaintRef.current = null;
            if (work === "all") paint("all");
            else if (work) paint([...work]);
          });
        }
      },
      [paint],
    );

    // Position + style the (focused, mostly invisible) input textarea over the
    // cursor cell so the IME candidate window anchors correctly and live
    // composition renders in place.
    const positionTextarea = useCallback(() => {
      const ta = textareaRef.current;
      const m = metricsRef.current;
      if (!ta || !m) return;
      const cursor = cursorRef.current;
      ta.style.left = `${m.padLeft + cursor.col * m.charWidth}px`;
      ta.style.top = `${m.padTop + cursor.row * m.lineHeight}px`;
      ta.style.height = `${m.lineHeight}px`;
      ta.style.lineHeight = `${m.lineHeight}px`;
      ta.style.fontFamily = m.fontFamily;
      ta.style.fontSize = `${m.fontSize}px`;
      ta.style.width = `${Math.max(8, m.charWidth * 24)}px`;
    }, []);

    // Apply each incoming frame to the retained grid and repaint the rows that
    // changed (plus the cursor's old and new rows).
    useEffect(() => {
      if (!frame) return;
      mouseRef.current = frame.mouse;
      const prevCursorRow = cursorRef.current.row;
      const sameDims =
        dimsRef.current.cols === frame.cols && dimsRef.current.rows === frame.rows;

      if (frame.dirtyRows && sameDims && gridRef.current.length === frame.rows) {
        const changed: number[] = [];
        frame.dirtyRows.forEach((rowIdx, i) => {
          const line = frame.lines[i];
          if (line && rowIdx < frame.rows) {
            gridRef.current[rowIdx] = line;
            changed.push(rowIdx);
          }
        });
        cursorRef.current = frame.cursor;
        const rows = new Set<number>(changed);
        rows.add(prevCursorRow);
        rows.add(frame.cursor.row);
        positionTextarea();
        requestPaint([...rows]);
      } else {
        gridRef.current = frame.lines.slice();
        dimsRef.current = { cols: frame.cols, rows: frame.rows };
        cursorRef.current = frame.cursor;
        positionTextarea();
        requestPaint("all");
      }
    }, [frame, positionTextarea, requestPaint]);

    // Measure metrics, size the canvas for HiDPI, report cols/rows, repaint.
    useEffect(() => {
      if (!active || !resizeReady) return;
      const root = rootRef.current;
      const canvas = canvasRef.current;
      if (!root || !canvas) return;

      const update = () => {
        const rect = root.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        rectRef.current = rect;
        const metrics = measureMetrics(root, canvas);
        if (!metrics) return;
        metricsRef.current = metrics;

        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.max(1, Math.floor(rect.width * dpr));
        const targetH = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const cols = Math.max(2, Math.floor((rect.width - metrics.padLeft * 2) / metrics.charWidth));
        const rows = Math.max(1, Math.floor((rect.height - metrics.padTop * 2) / metrics.lineHeight));
        const previous = lastSizeRef.current;
        if (!previous || previous.cols !== cols || previous.rows !== rows) {
          lastSizeRef.current = { cols, rows };
          onResize(cols, rows);
        }
        positionTextarea();
        requestPaint("all");
      };

      update();
      const observer = new ResizeObserver(update);
      observer.observe(root);
      return () => observer.disconnect();
    }, [active, onResize, positionTextarea, requestPaint, resizeReady]);

    // Repaint affected rows when the local selection changes.
    useEffect(() => {
      const prev = prevSelectionRangeRef.current;
      const next = selection ? normalizeSelection(selection) : null;
      selectionRangeRef.current = next;
      prevSelectionRangeRef.current = next;
      const rows = new Set<number>();
      const addRange = (range: CellRange | null) => {
        if (!range) return;
        for (let i = range.start.row; i <= range.end.row; i += 1) rows.add(i);
      };
      addRange(prev);
      addRange(next);
      if (rows.size) requestPaint([...rows]);
    }, [selection, requestPaint]);

    // Cursor style depends on focus (solid vs hollow); repaint its row.
    useEffect(() => {
      focusedRef.current = focused;
      requestPaint([cursorRef.current.row]);
    }, [focused, requestPaint]);

    useEffect(
      () => () => {
        if (rafRef.current != null) {
          window.cancelAnimationFrame(rafRef.current);
          // Must null it: otherwise a StrictMode remount (dev) sees a stale,
          // already-cancelled id and requestPaint never schedules again →
          // the canvas stays blank forever.
          rafRef.current = null;
        }
        pendingPaintRef.current = null;
      },
      [],
    );

    const cellFromClient = useCallback((clientX: number, clientY: number): CellPoint | null => {
      const m = metricsRef.current;
      const rect = rectRef.current ?? rootRef.current?.getBoundingClientRect() ?? null;
      if (!m || !rect) return null;
      const { cols, rows } = dimsRef.current;
      if (cols === 0 || rows === 0) return null;
      const x = clientX - rect.left - m.padLeft;
      const y = clientY - rect.top - m.padTop;
      const col = Math.max(0, Math.min(cols - 1, Math.floor(x / m.charWidth)));
      const row = Math.max(0, Math.min(rows - 1, Math.floor(y / m.lineHeight)));
      return { row, col };
    }, []);

    const onPointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        textareaRef.current?.focus();
        rectRef.current = rootRef.current?.getBoundingClientRect() ?? rectRef.current;
        const point = cellFromClient(event.clientX, event.clientY);
        if (!point) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const useMouse = mouseModeActive(mouseRef.current) && !event.shiftKey;
        if (useMouse) {
          pointerStateRef.current = { mode: "mouse", button: event.button };
          onInput({
            type: "mouse",
            button: domButtonToTerminal(event.button),
            col: point.col,
            row: point.row,
            action: "press",
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
          });
        } else {
          pointerStateRef.current = { mode: "select", button: event.button };
          setSelection({ anchor: point, focus: point });
        }
      },
      [cellFromClient, onInput],
    );

    const onPointerMove = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const state = pointerStateRef.current;
        const point = cellFromClient(event.clientX, event.clientY);
        if (!point) return;
        if (state?.mode === "select") {
          setSelection((current) => (current ? { ...current, focus: point } : current));
          return;
        }
        const mouse = mouseRef.current;
        if (!mouse) return;
        const pressing = state?.mode === "mouse";
        // 1003 (any-motion) reports hover; 1002 (button-motion) only while pressed.
        const wantMotion = mouse.motion || (mouse.drag && pressing);
        if (!wantMotion) return;
        const now = performance.now();
        if (now - lastMotionAtRef.current < 16) return;
        const last = lastMotionCellRef.current;
        if (last && last.row === point.row && last.col === point.col) return;
        lastMotionAtRef.current = now;
        lastMotionCellRef.current = point;
        onInput({
          type: "mouse",
          button: pressing ? domButtonToTerminal(state.button) : 3,
          col: point.col,
          row: point.row,
          action: "move",
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
        });
      },
      [cellFromClient, onInput],
    );

    const onPointerUp = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const state = pointerStateRef.current;
        pointerStateRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (!state) return;
        const point = cellFromClient(event.clientX, event.clientY);
        if (!point) return;
        if (state.mode === "mouse") {
          onInput({
            type: "mouse",
            button: domButtonToTerminal(state.button),
            col: point.col,
            row: point.row,
            action: "release",
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
          });
        } else {
          setSelection((current) => (current ? { ...current, focus: point } : current));
        }
      },
      [cellFromClient, onInput],
    );

    // Wheel must be a native, non-passive listener: React attaches `onWheel`
    // passively, so `preventDefault()` there is a no-op and the panel would
    // scroll instead of the terminal.
    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      const handler = (event: WheelEvent) => {
        const m = metricsRef.current;
        if (!m) return;
        const lineDelta = event.deltaMode === 1 ? event.deltaY : event.deltaY / m.lineHeight;
        wheelAccumRef.current += lineDelta;
        const steps = Math.trunc(wheelAccumRef.current);
        if (steps === 0) return;
        wheelAccumRef.current -= steps;
        event.preventDefault();
        const mouse = mouseRef.current;
        if (mouseModeActive(mouse) && !event.shiftKey) {
          const point = cellFromClient(event.clientX, event.clientY) ?? { row: 0, col: 0 };
          const up = steps < 0;
          const count = Math.min(Math.abs(steps), 8);
          for (let i = 0; i < count; i += 1) {
            onInput({
              type: "wheel",
              up,
              col: point.col,
              row: point.row,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
            });
          }
        } else {
          // Local scrollback: wheel up (negative steps) scrolls toward history,
          // which is a positive scroll_display delta.
          onScroll(-steps);
        }
      };
      root.addEventListener("wheel", handler, { passive: false });
      return () => root.removeEventListener("wheel", handler);
    }, [cellFromClient, onInput, onScroll]);

    const onKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const native = event.nativeEvent;
        // Use the authoritative per-event flag, NOT composingRef: a missed
        // compositionend can latch composingRef true and then swallow every
        // subsequent Enter (incl. Shift+Enter) forever.
        const composing = native.isComposing;
        const modified =
          event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
        // A *plain* Enter mid-composition commits the syllable: defer it and
        // replay after compositionend so the order is text-then-Enter. A
        // modified Enter (Shift/Alt/Ctrl/Meta) is a deliberate control input —
        // never a composition commit — so it must go straight through.
        if (event.key === "Enter" && composing && !modified) {
          enterDuringCompositionRef.current = {
            shiftKey: false,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
          };
          return;
        }
        if (composing && !modified) return;
        const command = terminalKeyEventToInput(native);
        if (!command) return;
        event.preventDefault();
        onInput(command);
      },
      [onInput],
    );

    const onBeforeInput = useCallback(
      (event: React.FormEvent<HTMLTextAreaElement>) => {
        const text = terminalBeforeInputToText(
          event.nativeEvent as InputEvent,
          composingRef.current,
        );
        if (!text) return;
        event.preventDefault();
        event.currentTarget.value = "";
        compositionSessionRef.current = null;
        onInput({ type: "text", text });
      },
      [onInput],
    );

    const onTextInput = useCallback(
      (event: React.FormEvent<HTMLTextAreaElement>) => {
        const native = event.nativeEvent as InputEvent;
        // Never touch the textarea value mid-composition — that text is the
        // live jamo the user is looking at.
        if (composingRef.current || native.isComposing) return;
        const text = terminalInputEventToText(native, event.currentTarget.value, false);
        event.currentTarget.value = "";
        if (!text) return;
        const now = performance.now();
        if (isTrailingCompositionDuplicate(text, compositionSessionRef.current, now)) {
          compositionSessionRef.current = null;
          return;
        }
        compositionSessionRef.current = null;
        onInput({ type: "text", text });
      },
      [onInput],
    );

    const onCompositionStart = useCallback(() => {
      composingRef.current = true;
      compositionSessionRef.current = null;
      enterDuringCompositionRef.current = null;
      const ta = textareaRef.current;
      if (ta) ta.style.background = DEFAULT_BG;
      // Drawn cursor hides while composing; refresh its row.
      requestPaint([cursorRef.current.row]);
    }, [requestPaint]);

    const onCompositionEnd = useCallback(
      (event: React.CompositionEvent<HTMLTextAreaElement>) => {
        composingRef.current = false;
        const text = finalCompositionText(event.data, event.currentTarget.value);
        event.currentTarget.value = "";
        const ta = textareaRef.current;
        if (ta) ta.style.background = "transparent";
        if (text) {
          compositionSessionRef.current = { text, at: performance.now() };
          onInput({ type: "text", text });
        }
        const enter = enterDuringCompositionRef.current;
        if (enter) {
          enterDuringCompositionRef.current = null;
          onInput({
            type: "key",
            key: "Enter",
            code: "Enter",
            shiftKey: enter.shiftKey,
            altKey: enter.altKey,
            ctrlKey: enter.ctrlKey,
            metaKey: enter.metaKey,
          });
        }
        requestPaint([cursorRef.current.row]);
      },
      [onInput, requestPaint],
    );

    const onPaste = useCallback(
      (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        event.preventDefault();
        onInput({ type: "paste", text: event.clipboardData.getData("text/plain") });
      },
      [onInput],
    );

    const onCopy = useCallback(
      (event: React.ClipboardEvent<HTMLDivElement>) => {
        if (!selection) return;
        const text = selectedTerminalText(gridRef.current, selection);
        if (!text) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
      },
      [selection],
    );

    return (
      <div
        ref={rootRef}
        className="native-terminal-view"
        data-session-id={sessionId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onCopy={onCopy}
      >
        <canvas ref={canvasRef} className="native-terminal-canvas" aria-hidden="true" />
        <textarea
          ref={textareaRef}
          className="native-terminal-input"
          aria-label={inputLabel}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          rows={1}
          onKeyDown={onKeyDown}
          onBeforeInput={onBeforeInput}
          onInput={onTextInput}
          onPaste={onPaste}
          onCompositionStart={onCompositionStart}
          onCompositionUpdate={() => {
            /* WKWebView renders the in-progress jamo in the textarea itself. */
          }}
          onCompositionEnd={onCompositionEnd}
        />
      </div>
    );
  }),
);

function rangeRows(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

function cellFg(cell: TerminalCell): string {
  return cell.inverse
    ? terminalColorToCss(cell.bg, DEFAULT_BG)
    : terminalColorToCss(cell.fg, DEFAULT_FG);
}

function cellBg(cell: TerminalCell): string {
  return cell.inverse
    ? terminalColorToCss(cell.fg, DEFAULT_FG)
    : terminalColorToCss(cell.bg, DEFAULT_BG);
}

function cellFont(cell: TerminalCell, m: TerminalMetrics): string {
  let prefix = "";
  if (cell.italic) prefix += "italic ";
  if (cell.bold) prefix += "700 ";
  return `${prefix}${m.fontCss}`;
}

function measureMetrics(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
): TerminalMetrics | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const cs = window.getComputedStyle(root);
  const fontSize = Number.parseFloat(cs.fontSize) || 12;
  const fontFamily = cs.fontFamily || "monospace";
  const lineHeight = cs.lineHeight.endsWith("px")
    ? Number.parseFloat(cs.lineHeight)
    : Math.round(fontSize * 1.25);
  const fontCss = `${fontSize}px ${fontFamily}`;
  ctx.font = fontCss;
  const charWidth = ctx.measureText("M").width || fontSize * 0.6;
  return {
    charWidth,
    lineHeight,
    fontSize,
    fontFamily,
    fontCss,
    padLeft: Number.parseFloat(cs.paddingLeft) || 0,
    padTop: Number.parseFloat(cs.paddingTop) || 0,
  };
}
