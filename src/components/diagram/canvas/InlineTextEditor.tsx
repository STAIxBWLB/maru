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

export interface InlineTextEditorProps {
  node: DiagramNode;
  field: InlineEditField;
  /** Screen-space rect (px, relative to the viewport container). */
  rect: { x: number; y: number; w: number; h: number };
  zoom: number;
  onCommit: (value: string) => void;
  onCancel: () => void;
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
}: InlineTextEditorProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(
    field === "title" ? (node.title ?? "") : (node.body ?? ""),
  );
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const settledRef = useRef(false);
  // Latest-closure refs so the one-time window listener sees current state.
  const valueRef = useRef(value);
  valueRef.current = value;

  const commit = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(valueRef.current);
  }, [onCommit]);

  const cancel = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  }, [onCancel]);

  // Focus + select the draft on mount.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Clicking anywhere outside the editor commits (capture phase so we settle
  // before canvas gestures react to the same pointerdown).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const el = areaRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) {
        commit();
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
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  const fontSize = (node.style?.fs ?? (node.kind === "text" ? 13 : 12)) * zoom;

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
      aria-label={t(field === "title" ? "diagram.inlineEdit.title.aria" : "diagram.inlineEdit.body.aria")}
      style={{
        left: rect.x,
        top: rect.y,
        width: Math.max(rect.w, 40),
        minHeight: Math.max(rect.h, 24),
        fontSize,
        textAlign: node.style?.align ?? "center",
      }}
    />
  );
}
