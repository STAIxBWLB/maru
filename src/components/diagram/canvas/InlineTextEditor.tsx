import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { DiagramNode } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";

export type InlineEditField = "title" | "body";

/** Why the editor settled: Enter, Tab (forward/back), or a click away. */
export type InlineEditCommitReason = "enter" | "tab" | "shift-tab" | "blur";

export interface InlineTextEditorProps {
  node: DiagramNode;
  field: InlineEditField;
  /** Screen-space rect (px, relative to the viewport container). */
  rect: { x: number; y: number; w: number; h: number };
  zoom: number;
  /** Plain commit callback (used when `onCommitReason` is absent). */
  onCommit?: (value: string) => void;
  onCancel: () => void;
  /**
   * When provided, replaces `onCommit` and also reports *why* the edit
   * settled (cell editing navigates on Enter/Tab). Tab handling is only
   * enabled in this mode so node title/body editing keeps its plain Tab.
   */
  onCommitReason?: (value: string, reason: InlineEditCommitReason) => void;
  /** Seed value override (e.g. printable-char quick entry in a table cell). */
  initialValue?: string;
  ariaLabel?: string;
  /** Final (already zoom-scaled) font size override, px. */
  fontSize?: number;
  textAlign?: "left" | "center" | "right";
}

/**
 * HTML overlay for editing a node's `title`/`body` in place. The parent
 * positions it over the node's screen rect; the editor owns the draft text
 * and reports exactly once — Enter commits, Escape cancels, clicking away
 * commits — so one editing gesture maps to a single store mutation (and a
 * single undo entry).
 *
 * Korean IME: `compositionstart/end` set a flag and `isComposing` keydowns
 * are ignored, so the Enter that confirms a hangul syllable never commits
 * the edit (modelled after WikilinkAutocomplete).
 */
export function InlineTextEditor({
  node,
  field,
  rect,
  zoom,
  onCommit,
  onCancel,
  onCommitReason,
  initialValue,
  ariaLabel,
  fontSize: fontSizeOverride,
  textAlign,
}: InlineTextEditorProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(
    () => initialValue ?? (field === "title" ? (node.title ?? "") : (node.body ?? "")),
  );
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const settledRef = useRef(false);
  // Latest-closure refs so the one-time window listener sees current state.
  const valueRef = useRef(value);
  valueRef.current = value;

  const commit = useCallback(
    (reason: InlineEditCommitReason) => {
      if (settledRef.current) return;
      settledRef.current = true;
      if (onCommitReason) onCommitReason(valueRef.current, reason);
      else onCommit?.(valueRef.current);
    },
    [onCommit, onCommitReason],
  );

  const cancel = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  }, [onCancel]);

  // Focus + select the draft on mount. Seeded quick-entry text (a single
  // printable char) places the caret at the end instead of selecting.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    if (initialValue !== undefined && initialValue.length === 1) {
      el.setSelectionRange(el.value.length, el.value.length);
    } else {
      el.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clicking anywhere outside the editor commits (capture phase so we settle
  // before canvas gestures react to the same pointerdown).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const el = areaRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) {
        commit("blur");
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [commit]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Keep diagram-level shortcuts (Delete, arrows, Cmd+Z, ...) out while editing.
    event.stopPropagation();
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commit("enter");
    } else if (event.key === "Tab" && onCommitReason) {
      event.preventDefault();
      commit(event.shiftKey ? "shift-tab" : "tab");
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  const fontSize =
    fontSizeOverride ?? (node.style?.fs ?? (node.kind === "text" ? 13 : 12)) * zoom;

  return (
    <textarea
      ref={areaRef}
      className="maru-diagram-inline-editor"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
      aria-label={ariaLabel ?? t(field === "title" ? "diagram.inlineEdit.title.aria" : "diagram.inlineEdit.body.aria")}
      style={{
        left: rect.x,
        top: rect.y,
        width: Math.max(rect.w, 40),
        minHeight: Math.max(rect.h, 24),
        fontSize,
        textAlign: textAlign ?? node.style?.align ?? "center",
      }}
    />
  );
}
