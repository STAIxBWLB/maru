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
  TerminalSearchMatch,
} from "../lib/api";

export interface NativeTerminalViewHandle {
  focus: () => void;
  refreshLayout: (options?: { focus?: boolean }) => void;
  pasteText: (text: string) => void;
  copySelection: () => string | null;
  selectAll: (text?: string | null) => void;
  clearSelection: () => void;
}

interface NativeTerminalViewProps {
  sessionId: string;
  frame: TerminalFrame | null;
  active: boolean;
  focused: boolean;
  resizeReady: boolean;
  inputLabel: string;
  copyOnSelect?: boolean;
  searchMatch?: TerminalSearchMatch | null;
  onInput: (command: TerminalInputCommand) => void;
  onResize: (cols: number, rows: number) => void;
  onScroll: (delta: number) => void;
  onCopyOnSelect?: (text: string) => void;
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

export type SelectionKind = "cell" | "word" | "line";

type PointerState =
  | { mode: "mouse"; button: number }
  | {
      mode: "select";
      button: number;
      anchor: CellPoint;
      moved: boolean;
      kind: SelectionKind;
      anchorSpan: CellRange | null;
    };

/** Consecutive left-click tracking for double/triple-click gestures.
 *  WKWebView reports `event.detail` unreliably for pointer events, so click
 *  counts are derived from our own timestamps. */
export interface ClickChain {
  at: number;
  point: CellPoint;
  button: number;
  count: number;
}

/** macOS WKWebView can emit a trailing `insertText` carrying the same text a
 *  hair after `compositionend`. We drop it only inside this tight window; a
 *  fresh composition of the same syllable starts a new session and is kept. */
const COMPOSITION_TRAILING_MS = 100;
const DEFAULT_FG = "#d4d4d4";
const DEFAULT_BG = "#111111";
const SELECTION_FILL = "rgba(56, 99, 161, 0.40)";
const SEARCH_FILL = "rgba(221, 171, 53, 0.34)";
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

/** xterm-256 cube levels for indices 16-231 (6x6x6). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** Resolve an xterm-256 indexed color: 0-15 themed table, 16-231 color cube,
 *  232-255 grayscale ramp. */
export function indexedColorToCss(index: number, fallback: string): string {
  if (index < 16) return INDEXED_COLORS[index] ?? fallback;
  if (index <= 231) {
    const offset = index - 16;
    const r = CUBE_LEVELS[Math.floor(offset / 36)];
    const g = CUBE_LEVELS[Math.floor(offset / 6) % 6];
    const b = CUBE_LEVELS[offset % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  return fallback;
}

export function terminalColorToCss(color: TerminalColor, fallback: string): string {
  if (color.kind === "rgb") return `rgb(${color.r}, ${color.g}, ${color.b})`;
  if (color.kind === "indexed") return indexedColorToCss(color.index, fallback);
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

export function comparePoint(a: CellPoint, b: CellPoint): number {
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

export function terminalSearchSpanForRow(
  match: TerminalSearchMatch | null | undefined,
  row: number,
  cols: number,
): { start: number; end: number } | null {
  if (!match || match.row !== row || match.length <= 0 || cols <= 0) return null;
  const start = Math.max(0, Math.min(cols - 1, match.col));
  const end = Math.max(start, Math.min(cols - 1, match.col + match.length - 1));
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

/** Characters that terminate a double-click word selection. Mirrors
 *  alacritty's default semantic_escape_chars (plus tab); `-_./~` stay word
 *  characters so paths and URLs select as one word. */
export const TERMINAL_WORD_SEPARATORS = ",│`|:\"' ()[]{}<>\t";

/** Column span of the "word" at `col`. Wide-cell spacers (width 0) inherit
 *  the glyph to their left so both columns of a CJK character classify the
 *  same; clicking whitespace selects the whitespace run; clicking a
 *  separator selects just that cell. Spans never cross the visual row — the
 *  frame carries no line-wrap flag. */
export function wordSpanAt(
  line: TerminalCell[] | undefined,
  col: number,
  separators: string = TERMINAL_WORD_SEPARATORS,
): { start: number; end: number } {
  if (!line || line.length === 0) return { start: 0, end: 0 };
  const max = line.length - 1;
  const at = Math.max(0, Math.min(max, col));
  const charAt = (index: number): string => {
    for (let i = index; i >= 0; i -= 1) {
      const cellAt = line[i];
      if (!cellAt) break;
      if (cellAt.width !== 0) return cellAt.ch || " ";
    }
    return " ";
  };
  const isSpace = (ch: string) => ch.trim().length === 0;
  const target = charAt(at);
  if (!isSpace(target) && separators.includes(target)) return { start: at, end: at };
  const sameClass = (ch: string) =>
    isSpace(target) ? isSpace(ch) : !isSpace(ch) && !separators.includes(ch);
  let start = at;
  while (start > 0 && sameClass(charAt(start - 1))) start -= 1;
  let end = at;
  while (end < max && sameClass(charAt(end + 1))) end += 1;
  return { start, end };
}

/** Fold a pointerdown into the click chain: left-clicks within `windowMs`
 *  on the same row (±`colTolerance` columns) count up, cycling 1→2→3→1;
 *  anything else starts a fresh chain. */
export function nextClickChain(
  prev: ClickChain | null,
  point: CellPoint,
  button: number,
  now: number,
  windowMs = 500,
  colTolerance = 1,
): ClickChain {
  if (
    prev &&
    button === 0 &&
    prev.button === 0 &&
    now - prev.at <= windowMs &&
    point.row === prev.point.row &&
    Math.abs(point.col - prev.point.col) <= colTolerance
  ) {
    return { at: now, point, button, count: prev.count >= 3 ? 1 : prev.count + 1 };
  }
  return { at: now, point, button, count: 1 };
}

/** Initial selection for a click of the given chain count: a single click
 *  selects nothing until the pointer moves, a double click selects the word,
 *  a triple click selects the visual row. */
export function selectionForClickCount(
  lines: TerminalCell[][],
  point: CellPoint,
  count: number,
  cols: number,
): CellSelection | null {
  if (count <= 1) return null;
  if (count === 2) {
    const span = wordSpanAt(lines[point.row], point.col);
    return {
      anchor: { row: point.row, col: span.start },
      focus: { row: point.row, col: span.end },
    };
  }
  return {
    anchor: { row: point.row, col: 0 },
    focus: { row: point.row, col: Math.max(0, cols - 1) },
  };
}

/** Selection for a drag at the gesture's granularity: plain drags track the
 *  cell, word/line drags extend whole words/rows away from the original
 *  anchor span. */
export function selectionForSelectDrag(
  lines: TerminalCell[][],
  kind: SelectionKind,
  anchor: CellPoint,
  anchorSpan: CellRange | null,
  point: CellPoint,
  cols: number,
): CellSelection {
  if (kind === "cell") return { anchor, focus: point };
  const base = anchorSpan ?? { start: anchor, end: anchor };
  if (kind === "word") {
    const span = wordSpanAt(lines[point.row], point.col);
    return comparePoint(point, base.start) >= 0
      ? { anchor: base.start, focus: { row: point.row, col: span.end } }
      : { anchor: base.end, focus: { row: point.row, col: span.start } };
  }
  const lastCol = Math.max(0, cols - 1);
  return point.row >= base.start.row
    ? { anchor: { row: base.start.row, col: 0 }, focus: { row: point.row, col: lastCol } }
    : { anchor: { row: base.end.row, col: lastCol }, focus: { row: point.row, col: 0 } };
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

export interface KeyMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

export interface CapturedEnterMods {
  mods: KeyMods;
  at: number;
}

export interface TerminalModifierTracking {
  mods: KeyMods;
  capturedEnter: CapturedEnterMods | null;
}

type KeyboardModifierEvent = Pick<
  KeyboardEvent,
  "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
> & {
  getModifierState?: (keyArg: string) => boolean;
};

const ENTER_CAPTURE_TTL_MS = 1000;
const ENTER_DEDUPE_MS = 100;

const EMPTY_KEY_MODS: KeyMods = { shift: false, alt: false, ctrl: false, meta: false };

function isEnterKey(event: Pick<KeyboardEvent, "key" | "code">): boolean {
  return event.key === "Enter" || event.code === "Enter";
}

function isModifierKey(key: string): boolean {
  return key === "Meta" || key === "Control" || key === "Alt" || key === "Shift";
}

export function keyModsFromEvent(
  event: KeyboardModifierEvent,
): KeyMods {
  const hasModifier = (key: string) =>
    typeof event.getModifierState === "function" ? event.getModifierState(key) : false;
  return {
    shift: event.shiftKey || hasModifier("Shift"),
    alt: event.altKey || hasModifier("Alt"),
    ctrl: event.ctrlKey || hasModifier("Control"),
    meta: event.metaKey || hasModifier("Meta"),
  };
}

function mergedKeyMods(...mods: KeyMods[]): KeyMods {
  return mods.reduce<KeyMods>(
    (current, next) => ({
      shift: current.shift || next.shift,
      alt: current.alt || next.alt,
      ctrl: current.ctrl || next.ctrl,
      meta: current.meta || next.meta,
    }),
    EMPTY_KEY_MODS,
  );
}

function freshCapturedEnter(
  captured: CapturedEnterMods | null,
  now: number,
  ttlMs = ENTER_CAPTURE_TTL_MS,
): KeyMods | null {
  if (!captured || now - captured.at > ttlMs) return null;
  return captured.mods;
}

export function resetTerminalModifierTracking(): TerminalModifierTracking {
  return { mods: EMPTY_KEY_MODS, capturedEnter: null };
}

export function recordTerminalKeyDown(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >,
  current: TerminalModifierTracking,
  now: number,
): TerminalModifierTracking {
  const eventMods = keyModsFromEvent(event);
  if (isEnterKey(event)) {
    return {
      mods: current.mods,
      capturedEnter: {
        mods: mergedKeyMods(current.mods, eventMods),
        at: now,
      },
    };
  }
  return {
    mods: eventMods,
    capturedEnter: isModifierKey(event.key) ? current.capturedEnter : null,
  };
}

export function recordTerminalKeyUp(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >,
  current: TerminalModifierTracking,
): TerminalModifierTracking {
  if (isEnterKey(event)) return current;
  return { mods: keyModsFromEvent(event), capturedEnter: current.capturedEnter };
}

export function effectiveTerminalEnterMods(
  event: KeyboardModifierEvent,
  current: TerminalModifierTracking,
  now: number,
): KeyMods {
  return mergedKeyMods(
    keyModsFromEvent(event),
    current.mods,
    freshCapturedEnter(current.capturedEnter, now) ?? EMPTY_KEY_MODS,
  );
}

export function effectiveTerminalLineBreakMods(
  current: TerminalModifierTracking,
  now: number,
  _inputType: string,
): KeyMods {
  return mergedKeyMods(
    { ...EMPTY_KEY_MODS, shift: true },
    current.mods,
    freshCapturedEnter(current.capturedEnter, now) ?? EMPTY_KEY_MODS,
  );
}

export function isTerminalLineBreakInput(
  event: Pick<InputEvent, "inputType"> & Partial<Pick<InputEvent, "data">>,
): boolean {
  return (
    event.inputType === "insertLineBreak" ||
    event.inputType === "insertParagraph" ||
    (event.inputType === "insertText" &&
      (event.data === "\n" || event.data === "\r" || event.data === "\r\n"))
  );
}

export function terminalEnterAlreadyHandled(
  now: number,
  handledAt: number,
  windowMs = ENTER_DEDUPE_MS,
): boolean {
  return handledAt > 0 && now - handledAt < windowMs;
}

export function terminalLineBreakCommand(
  _inputType: string,
  _current: TerminalModifierTracking,
  now: number,
  handledAt: number,
  composing: boolean,
  inputComposing?: boolean,
): TerminalInputCommand | null {
  if (composing || inputComposing) return null;
  if (terminalEnterAlreadyHandled(now, handledAt)) return null;
  return lineBreakCommand();
}

export function nativeShiftEnterCommand(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  > & {
    getModifierState?: (keyArg: string) => boolean;
  },
  current: TerminalModifierTracking,
  now: number,
  composing: boolean,
): TerminalInputCommand | null {
  if (composing || !isEnterKey(event)) return null;
  const mods = effectiveTerminalEnterMods(event, current, now);
  if (!mods.shift || mods.alt || mods.ctrl || mods.meta) return null;
  return lineBreakCommand();
}

export function lineBreakCommand(): TerminalInputCommand {
  return { type: "lineBreak" };
}

/** Build the structured Enter command from a modifier set. */
export function enterCommandFromMods(mods: KeyMods): TerminalInputCommand {
  return {
    type: "key",
    key: "Enter",
    code: "Enter",
    shiftKey: mods.shift,
    altKey: mods.alt,
    ctrlKey: mods.ctrl,
    metaKey: mods.meta,
  };
}

export function terminalEnterCommandFromMods(mods: KeyMods): TerminalInputCommand {
  if (mods.shift && !mods.alt && !mods.ctrl && !mods.meta) {
    return lineBreakCommand();
  }
  return enterCommandFromMods(mods);
}

export const NativeTerminalView = memo(
  forwardRef<NativeTerminalViewHandle, NativeTerminalViewProps>(function NativeTerminalView(
    {
      sessionId,
      frame,
      active,
      focused,
      resizeReady,
      inputLabel,
      copyOnSelect = false,
      searchMatch = null,
      onInput,
      onResize,
      onScroll,
      onCopyOnSelect,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    // IME composition state.
    const composingRef = useRef(false);
    const compositionSessionRef = useRef<CompositionSession | null>(null);
    const enterDuringCompositionRef = useRef<EnterDuringComposition | null>(null);

    // Modifier state tracked from the modifier keys' OWN events. macOS WKWebView
    // strips/consumes the Shift bit on a Shift+Enter keydown (insertNewline:), so
    // we cannot trust the Enter event's own modifiers — we read the held state
    // captured from non-Enter key events instead. enterHandledAtRef dedupes the
    // keydown path against the beforeinput(insertLineBreak) fallback.
    const modsRef = useRef<KeyMods>({ shift: false, alt: false, ctrl: false, meta: false });
    const capturedEnterRef = useRef<CapturedEnterMods | null>(null);
    const enterHandledAtRef = useRef(0);

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
    const wasFocusedRef = useRef(false);
    const mouseRef = useRef<TerminalMouseFlags | null>(null);

    // Pointer / selection state.
    const pointerStateRef = useRef<PointerState | null>(null);
    const clickChainRef = useRef<ClickChain | null>(null);
    const lastMotionAtRef = useRef(0);
    const lastMotionCellRef = useRef<CellPoint | null>(null);
    const wheelAccumRef = useRef(0);
    const [selection, setSelection] = useState<CellSelection | null>(null);
    const selectionRef = useRef<CellSelection | null>(null);
    const selectionRangeRef = useRef<CellRange | null>(null);
    const prevSelectionRangeRef = useRef<CellRange | null>(null);
    const allSelectionTextRef = useRef<string | null>(null);
    const searchMatchRef = useRef<TerminalSearchMatch | null>(null);

    // Paint scheduling.
    const pendingPaintRef = useRef<"all" | Set<number> | null>(null);
    const rafRef = useRef<number | null>(null);

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

      if (which === "all") {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }

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

        const searchSpan = terminalSearchSpanForRow(searchMatchRef.current, r, cols);
        if (searchSpan) {
          ctx.fillStyle = SEARCH_FILL;
          ctx.fillRect(
            m.padLeft + searchSpan.start * m.charWidth,
            y,
            (searchSpan.end - searchSpan.start + 1) * m.charWidth,
            m.lineHeight,
          );
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

    const refreshLayout = useCallback(
      (options: { focus?: boolean } = {}) => {
        if (!active || !resizeReady) return;
        const root = rootRef.current;
        const canvas = canvasRef.current;
        if (!root || !canvas) return;

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

        const cols = Math.max(
          2,
          Math.floor((rect.width - metrics.padLeft * 2) / metrics.charWidth),
        );
        const rows = Math.max(
          1,
          Math.floor((rect.height - metrics.padTop * 2) / metrics.lineHeight),
        );
        const previous = lastSizeRef.current;
        if (!previous || previous.cols !== cols || previous.rows !== rows) {
          lastSizeRef.current = { cols, rows };
          onResize(cols, rows);
        }
        positionTextarea();
        requestPaint("all");
        if (options.focus) textareaRef.current?.focus();
      },
      [active, onResize, positionTextarea, requestPaint, resizeReady],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        refreshLayout,
        pasteText: (text: string) => {
          if (!text) return;
          onInput({ type: "paste", text: normalizeTerminalInputText(text) });
          textareaRef.current?.focus();
        },
        copySelection: () => {
          const selected = allSelectionTextRef.current
            ?? selectedTerminalText(gridRef.current, selectionRef.current);
          return selected || null;
        },
        selectAll: (text?: string | null) => {
          allSelectionTextRef.current = text ?? frameToText(frame);
          const { cols, rows } = dimsRef.current;
          if (cols > 0 && rows > 0) {
            setSelection({
              anchor: { row: 0, col: 0 },
              focus: { row: rows - 1, col: cols - 1 },
            });
          }
          textareaRef.current?.focus();
        },
        clearSelection: () => {
          allSelectionTextRef.current = null;
          setSelection(null);
        },
      }),
      [frame, onInput, refreshLayout],
    );

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
      if (!root) return;

      refreshLayout();
      const observer = new ResizeObserver(() => refreshLayout());
      observer.observe(root);
      return () => observer.disconnect();
    }, [active, refreshLayout, resizeReady]);

    // Repaint affected rows when the local selection changes.
    useEffect(() => {
      const prev = prevSelectionRangeRef.current;
      const next = selection ? normalizeSelection(selection) : null;
      selectionRef.current = selection;
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

    useEffect(() => {
      const prev = searchMatchRef.current;
      const next = searchMatch ?? null;
      searchMatchRef.current = next;
      const rows = new Set<number>();
      if (prev) rows.add(prev.row);
      if (next) rows.add(next.row);
      if (rows.size) requestPaint([...rows]);
    }, [requestPaint, searchMatch]);

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
          clickChainRef.current = null;
          // Seed the motion cell with this gesture's press point so a cancel
          // without movement synthesizes its release here, not at a stale
          // cell from a previous hover/gesture.
          lastMotionCellRef.current = point;
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
          allSelectionTextRef.current = null;
          // Shift+click extends an existing selection from its original
          // anchor. (When a TUI owns the mouse, Shift already routed here
          // via `useMouse`; extend still wins over starting a new drag.)
          if (event.shiftKey && event.button === 0 && selectionRef.current) {
            clickChainRef.current = null;
            const anchor = selectionRef.current.anchor;
            pointerStateRef.current = {
              mode: "select",
              button: event.button,
              anchor,
              moved: true,
              kind: "cell",
              anchorSpan: null,
            };
            setSelection({ anchor, focus: point });
            return;
          }
          const chain = nextClickChain(
            clickChainRef.current,
            point,
            event.button,
            performance.now(),
          );
          clickChainRef.current = chain;
          const initial = selectionForClickCount(
            gridRef.current,
            point,
            chain.count,
            dimsRef.current.cols,
          );
          pointerStateRef.current = {
            mode: "select",
            button: event.button,
            anchor: point,
            moved: false,
            kind: chain.count >= 3 ? "line" : chain.count === 2 ? "word" : "cell",
            anchorSpan: initial ? normalizeSelection(initial) : null,
          };
          // A plain click paints nothing (and clears any prior highlight);
          // double/triple clicks select their word/line immediately.
          setSelection(initial);
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
          if (!state.moved) {
            if (point.row === state.anchor.row && point.col === state.anchor.col) return;
            pointerStateRef.current = { ...state, moved: true };
          }
          setSelection(
            selectionForSelectDrag(
              gridRef.current,
              state.kind,
              state.anchor,
              state.anchorSpan,
              point,
              dimsRef.current.cols,
            ),
          );
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
          // No-move: a plain click leaves nothing selected; word/line clicks
          // keep the span chosen at pointerdown (recomputed from anchorSpan
          // so we don't depend on React state timing).
          const next = !state.moved
            ? state.anchorSpan
              ? { anchor: state.anchorSpan.start, focus: state.anchorSpan.end }
              : null
            : selectionForSelectDrag(
                gridRef.current,
                state.kind,
                state.anchor,
                state.anchorSpan,
                point,
                dimsRef.current.cols,
              );
          setSelection(next);
          if (copyOnSelect && next) {
            const text = selectedTerminalText(gridRef.current, next);
            if (text) onCopyOnSelect?.(text);
          }
        }
      },
      [cellFromClient, copyOnSelect, onCopyOnSelect, onInput],
    );

    // Abort path: pointercancel / lostpointercapture must stop selection
    // tracking, otherwise a stale "select" state makes bare hover keep
    // extending the highlight. After a normal pointerup the state is already
    // null, so the trailing lostpointercapture is a no-op.
    const onPointerCancel = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const state = pointerStateRef.current;
        if (!state) return;
        pointerStateRef.current = null;
        clickChainRef.current = null;
        if (state.mode !== "mouse") return;
        // Synthesize a release so a TUI doesn't keep a stuck button after an
        // aborted gesture. pointercancel coordinates are unreliable in
        // WKWebView; prefer the last forwarded motion cell.
        const point =
          lastMotionCellRef.current ??
          cellFromClient(event.clientX, event.clientY) ?? { row: 0, col: 0 };
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
        const now = performance.now();
        const tracking = recordTerminalKeyDown(
          native,
          { mods: modsRef.current, capturedEnter: capturedEnterRef.current },
          now,
        );
        modsRef.current = tracking.mods;
        capturedEnterRef.current = tracking.capturedEnter;
        const composing = native.isComposing || composingRef.current;
        // Effective modifiers for an Enter: prefer the event's own flags, but
        // fall back to tracked/captured state when WKWebView stripped them.
        const mods = effectiveTerminalEnterMods(
          native,
          { mods: modsRef.current, capturedEnter: capturedEnterRef.current },
          now,
        );

        if (event.key === "Enter" || event.code === "Enter") {
          if (composing) {
            // Commit the composition first; replay the Enter (with its real
            // modifiers) after compositionend so order is text-then-Enter.
            enterDuringCompositionRef.current = {
              shiftKey: mods.shift,
              altKey: mods.alt,
              ctrlKey: mods.ctrl,
              metaKey: mods.meta,
            };
            return;
          }
          event.preventDefault();
          enterHandledAtRef.current = now;
          capturedEnterRef.current = null;
          onInput(terminalEnterCommandFromMods(mods));
          return;
        }

        if (composing) return;
        const command = terminalKeyEventToInput(native);
        if (!command) return;
        event.preventDefault();
        onInput(command);
      },
      [onInput],
    );

    const onKeyUp = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const native = event.nativeEvent;
      const tracking = recordTerminalKeyUp(native, {
        mods: modsRef.current,
        capturedEnter: capturedEnterRef.current,
      });
      modsRef.current = tracking.mods;
      capturedEnterRef.current = tracking.capturedEnter;
    }, []);

    // Reset tracked modifiers when focus/window leaves, so a missed keyup can't
    // latch a modifier and mislabel a later plain Enter as Shift+Enter.
    const resetMods = useCallback(() => {
      const tracking = resetTerminalModifierTracking();
      modsRef.current = tracking.mods;
      capturedEnterRef.current = tracking.capturedEnter;
      enterHandledAtRef.current = 0;
    }, []);

    // Composition state must not outlive focus reality: WKWebView can abandon
    // an IME composition without delivering compositionend (Korean input +
    // Cmd+Tab), which would leave composingRef stuck true and silently
    // swallow ALL input until something blurs the textarea. Reset at every
    // blur boundary; a late compositionend stays harmless — onCompositionEnd
    // is idempotent and prefers event.data over the cleared textarea value.
    const resetComposition = useCallback(() => {
      composingRef.current = false;
      compositionSessionRef.current = null;
      enterDuringCompositionRef.current = null;
      const ta = textareaRef.current;
      if (ta) {
        ta.value = "";
        ta.style.background = "transparent";
      }
      requestPaint([cursorRef.current.row]);
    }, [requestPaint]);

    const onTextareaBlur = useCallback(() => {
      resetMods();
      resetComposition();
    }, [resetComposition, resetMods]);

    // Track DOM-focus ownership continuously: sampling activeElement at
    // window-blur time races WKWebView, which may blur the textarea before
    // the window blur event fires. A focusin anywhere else falsifies
    // ownership; blur-to-body (window deactivation) fires no focusin and
    // keeps it.
    useEffect(() => {
      // The mount-time focus effect runs before this listener attaches, so
      // seed ownership from the current activeElement.
      wasFocusedRef.current = document.activeElement === textareaRef.current;
      const onFocusIn = (event: FocusEvent) => {
        wasFocusedRef.current = event.target === textareaRef.current;
      };
      document.addEventListener("focusin", onFocusIn, true);
      return () => document.removeEventListener("focusin", onFocusIn, true);
    }, []);

    // On window blur, drop modifier and composition state (macOS detaches the
    // IME at deactivation; a missed keyup must not latch a modifier). On
    // window focus, restore the textarea focus WKWebView fails to restore —
    // gated on the focused/active props (a hidden tab or unfocused split pane
    // never steals focus), on ownership, and on never stealing from another
    // genuinely focused element.
    useEffect(() => {
      const onWindowBlur = () => {
        resetMods();
        resetComposition();
      };
      const onWindowFocus = () => {
        if (!wasFocusedRef.current || !focused || !active) return;
        const el = document.activeElement;
        if (el && el !== document.body && el !== textareaRef.current) return;
        textareaRef.current?.focus();
      };
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("focus", onWindowFocus);
      return () => {
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("focus", onWindowFocus);
      };
    }, [active, focused, resetComposition, resetMods]);

    useEffect(() => {
      const focusedOnThisTerminal = () => document.activeElement === textareaRef.current;
      const onNativeKeyDown = (event: KeyboardEvent) => {
        if (!focusedOnThisTerminal()) return;
        const now = performance.now();
        const tracking = recordTerminalKeyDown(
          event,
          { mods: modsRef.current, capturedEnter: capturedEnterRef.current },
          now,
        );
        modsRef.current = tracking.mods;
        capturedEnterRef.current = tracking.capturedEnter;
        const command = nativeShiftEnterCommand(
          event,
          { mods: modsRef.current, capturedEnter: capturedEnterRef.current },
          now,
          composingRef.current,
        );
        if (!command) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        enterHandledAtRef.current = now;
        capturedEnterRef.current = null;
        onInput(command);
      };
      const onNativeKeyUp = (event: KeyboardEvent) => {
        if (!focusedOnThisTerminal()) return;
        const tracking = recordTerminalKeyUp(event, {
          mods: modsRef.current,
          capturedEnter: capturedEnterRef.current,
        });
        modsRef.current = tracking.mods;
        capturedEnterRef.current = tracking.capturedEnter;
      };
      window.addEventListener("keydown", onNativeKeyDown, true);
      window.addEventListener("keyup", onNativeKeyUp, true);
      return () => {
        window.removeEventListener("keydown", onNativeKeyDown, true);
        window.removeEventListener("keyup", onNativeKeyUp, true);
      };
    }, [onInput]);

    const handleLineBreakInput = useCallback(
      (native: InputEvent, target: HTMLTextAreaElement) => {
        target.value = "";
        const now = performance.now();
        const command = terminalLineBreakCommand(
          native.inputType,
          { mods: modsRef.current, capturedEnter: capturedEnterRef.current },
          now,
          enterHandledAtRef.current,
          composingRef.current,
          native.isComposing,
        );
        if (!command) return;
        enterHandledAtRef.current = now;
        capturedEnterRef.current = null;
        onInput(command);
      },
      [onInput],
    );

    useEffect(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const onNativeBeforeInput = (event: Event) => {
        const native = event as InputEvent;
        if (!isTerminalLineBreakInput(native)) return;
        event.preventDefault();
        handleLineBreakInput(native, ta);
      };
      ta.addEventListener("beforeinput", onNativeBeforeInput, true);
      return () => ta.removeEventListener("beforeinput", onNativeBeforeInput, true);
    }, [handleLineBreakInput]);

    const onBeforeInput = useCallback(
      (event: React.FormEvent<HTMLTextAreaElement>) => {
        const native = event.nativeEvent as InputEvent;
        // Enter often reaches WKWebView only as a text-edit (Shift+Enter →
        // insertLineBreak, with the keydown consumed/stripped). Catch it here
        // using the tracked modifier state, deduped against the keydown path.
        if (isTerminalLineBreakInput(native)) {
          event.preventDefault();
          handleLineBreakInput(native, event.currentTarget);
          return;
        }
        const text = terminalBeforeInputToText(native, composingRef.current);
        if (!text) return;
        event.preventDefault();
        event.currentTarget.value = "";
        // This is the path that actually delivers the WKWebView trailing
        // insertText echo after compositionend (preventDefault here suppresses
        // the later `input` event), so the dedup guard must run here too.
        const now = performance.now();
        if (isTrailingCompositionDuplicate(text, compositionSessionRef.current, now)) {
          compositionSessionRef.current = null;
          return;
        }
        compositionSessionRef.current = null;
        onInput({ type: "text", text });
      },
      [handleLineBreakInput, onInput],
    );

    const onTextInput = useCallback(
      (event: React.FormEvent<HTMLTextAreaElement>) => {
        const native = event.nativeEvent as InputEvent;
        if (isTerminalLineBreakInput(native)) {
          handleLineBreakInput(native, event.currentTarget);
          return;
        }
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
      [handleLineBreakInput, onInput],
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
          // Arm the Enter dedup window before replaying: the un-suppressed
          // composing-Enter keydown may still produce a textarea
          // insertLineBreak right after compositionend, which would otherwise
          // emit a second newline.
          enterHandledAtRef.current = performance.now();
          capturedEnterRef.current = null;
          onInput(
            terminalEnterCommandFromMods({
              shift: enter.shiftKey,
              alt: enter.altKey,
              ctrl: enter.ctrlKey,
              meta: enter.metaKey,
            }),
          );
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
        const text = allSelectionTextRef.current ?? selectedTerminalText(gridRef.current, selection);
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
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
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
          onKeyUp={onKeyUp}
          onBlur={onTextareaBlur}
          onBeforeInput={onBeforeInput}
          onInput={onTextInput}
          onPaste={onPaste}
          onCompositionStart={onCompositionStart}
          onCompositionUpdate={() => {
            // WKWebView renders the in-progress jamo in the textarea itself.
            // A composition resumed after an app switch arrives without a new
            // compositionstart (the blur-boundary reset cleared the flag) —
            // re-arm so the cursor/backdrop reflect the live composition.
            if (!composingRef.current) {
              composingRef.current = true;
              const ta = textareaRef.current;
              if (ta) ta.style.background = DEFAULT_BG;
              requestPaint([cursorRef.current.row]);
            }
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
