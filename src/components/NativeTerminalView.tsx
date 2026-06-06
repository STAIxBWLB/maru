import type React from "react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  TerminalCell,
  TerminalColor,
  TerminalFrame,
  TerminalInputCommand,
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
}

interface CellPoint {
  row: number;
  col: number;
}

interface CellSelection {
  anchor: CellPoint;
  focus: CellPoint;
}

interface TerminalInputEventLike {
  data: string | null;
  inputType: string;
  isComposing?: boolean;
}

interface RecentComposition {
  text: string;
  at: number;
}

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

export function selectedTerminalText(
  frame: TerminalFrame | null,
  selection: CellSelection | null,
): string {
  if (!frame || !selection) return "";
  const start =
    comparePoint(selection.anchor, selection.focus) <= 0 ? selection.anchor : selection.focus;
  const end =
    comparePoint(selection.anchor, selection.focus) <= 0 ? selection.focus : selection.anchor;
  const chunks: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const line = frame.lines[row] ?? [];
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

export function isDuplicateCompositionInput(
  text: string,
  recent: RecentComposition | null,
  now: number,
  windowMs = 500,
): boolean {
  return Boolean(recent && recent.text === text && now - recent.at <= windowMs);
}

export function finalCompositionText(eventData: string, textareaValue: string): string {
  return normalizeTerminalInputText(eventData || textareaValue);
}

export const NativeTerminalView = memo(
  forwardRef<NativeTerminalViewHandle, NativeTerminalViewProps>(function NativeTerminalView(
    { sessionId, frame, active, focused, resizeReady, inputLabel, onInput, onResize },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const measureRef = useRef<HTMLSpanElement | null>(null);
    const composingRef = useRef(false);
    const recentCompositionRef = useRef<RecentComposition | null>(null);
    const pointerDownRef = useRef(false);
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const [selection, setSelection] = useState<CellSelection | null>(null);

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

    useEffect(() => {
      if (!active || !resizeReady) return;
      const root = rootRef.current;
      const measure = measureRef.current;
      if (!root || !measure) return;

      const update = () => {
        const rect = root.getBoundingClientRect();
        const measureRect = measure.getBoundingClientRect();
        const styles = window.getComputedStyle(root);
        const horizontalPadding =
          Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
        const verticalPadding =
          Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
        const charWidth = measureRect.width || 7;
        const lineHeight = measureRect.height || 15;
        const cols = Math.max(2, Math.floor((rect.width - horizontalPadding) / charWidth));
        const rows = Math.max(1, Math.floor((rect.height - verticalPadding) / lineHeight));
        const previous = lastSizeRef.current;
        if (!previous || previous.cols !== cols || previous.rows !== rows) {
          lastSizeRef.current = { cols, rows };
          onResize(cols, rows);
        }
      };

      update();
      const observer = new ResizeObserver(update);
      observer.observe(root);
      return () => observer.disconnect();
    }, [active, onResize, resizeReady]);

    const selectedText = useMemo(
      () => selectedTerminalText(frame, selection),
      [frame, selection],
    );

    const cellFromPointer = useCallback((event: React.PointerEvent): CellPoint | null => {
      const root = rootRef.current;
      const measure = measureRef.current;
      if (!root || !measure || !frame) return null;
      const rect = root.getBoundingClientRect();
      const measureRect = measure.getBoundingClientRect();
      const styles = window.getComputedStyle(root);
      const x = event.clientX - rect.left - Number.parseFloat(styles.paddingLeft);
      const y = event.clientY - rect.top - Number.parseFloat(styles.paddingTop);
      const col = Math.max(0, Math.min(frame.cols - 1, Math.floor(x / (measureRect.width || 7))));
      const row = Math.max(0, Math.min(frame.rows - 1, Math.floor(y / (measureRect.height || 15))));
      return { row, col };
    }, [frame]);

    const onPointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        textareaRef.current?.focus();
        const point = cellFromPointer(event);
        if (!point) return;
        pointerDownRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelection({ anchor: point, focus: point });
      },
      [cellFromPointer],
    );

    const onPointerMove = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (!pointerDownRef.current) return;
        const point = cellFromPointer(event);
        if (!point) return;
        setSelection((current) => current ? { ...current, focus: point } : current);
      },
      [cellFromPointer],
    );

    const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      pointerDownRef.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }, []);

    const onKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (composingRef.current) return;
        const command = terminalKeyEventToInput(event.nativeEvent);
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
        recentCompositionRef.current = null;
        onInput({ type: "text", text });
      },
      [onInput],
    );

    const onTextInput = useCallback(
      (event: React.FormEvent<HTMLTextAreaElement>) => {
        const text = terminalInputEventToText(
          event.nativeEvent as InputEvent,
          event.currentTarget.value,
          composingRef.current,
        );
        event.currentTarget.value = "";
        if (!text) return;
        const now = performance.now();
        if (isDuplicateCompositionInput(text, recentCompositionRef.current, now)) {
          recentCompositionRef.current = null;
          return;
        }
        recentCompositionRef.current = null;
        onInput({ type: "text", text });
      },
      [onInput],
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
        if (!selectedText) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", selectedText);
      },
      [selectedText],
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
        <span ref={measureRef} className="native-terminal-measure" aria-hidden="true">
          W
        </span>
        <textarea
          ref={textareaRef}
          className="native-terminal-input"
          aria-label={inputLabel}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={onKeyDown}
          onBeforeInput={onBeforeInput}
          onInput={onTextInput}
          onPaste={onPaste}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const text = finalCompositionText(event.data, event.currentTarget.value);
            event.currentTarget.value = "";
            if (text) {
              recentCompositionRef.current = { text, at: performance.now() };
              onInput({ type: "text", text });
            }
          }}
        />
        <div className="native-terminal-grid" role="presentation">
          {(frame?.lines ?? []).map((line, rowIndex) => (
            <div key={rowIndex} className="native-terminal-row">
              {line.map((cell, colIndex) => (
                <span
                  key={colIndex}
                  className={[
                    "native-terminal-cell",
                    isPointSelected(selection, rowIndex, colIndex) ? "selected" : null,
                    frame?.cursor.visible &&
                    frame.cursor.row === rowIndex &&
                    frame.cursor.col === colIndex
                      ? "cursor"
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    width: cellDisplayWidth(cell),
                    color: terminalColorToCss(cell.fg, "#d4d4d4"),
                    backgroundColor: terminalColorToCss(cell.bg, "#111111"),
                    fontWeight: cell.bold ? 700 : 400,
                    fontStyle: cell.italic ? "italic" : "normal",
                    textDecoration: cell.underline ? "underline" : "none",
                  }}
                >
                  {cellDisplayText(cell)}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }),
);

function comparePoint(a: CellPoint, b: CellPoint): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

function isPointSelected(selection: CellSelection | null, row: number, col: number): boolean {
  if (!selection) return false;
  const point = { row, col };
  const start =
    comparePoint(selection.anchor, selection.focus) <= 0 ? selection.anchor : selection.focus;
  const end =
    comparePoint(selection.anchor, selection.focus) <= 0 ? selection.focus : selection.anchor;
  return comparePoint(point, start) >= 0 && comparePoint(point, end) <= 0;
}
