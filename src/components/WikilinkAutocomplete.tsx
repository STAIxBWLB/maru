import { useCallback, useEffect, useRef, useState } from "react";
import {
  suggestWikilinkTargets,
  type WikilinkSuggestion,
} from "../lib/wikilinkSuggestions";
import type { VaultEntry } from "../lib/types";

interface UseAutocompleteOptions {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  entries: VaultEntry[];
  onChange: (next: string) => void;
}

interface AutocompleteState {
  open: boolean;
  /** Index of the opening `[` in textarea.value (so the leading `[[` is at
   *  positions [start, start+1]). */
  start: number;
  /** Caret position when the popup was opened — equals query end. */
  caret: number;
  query: string;
  results: WikilinkSuggestion[];
  active: number;
  coords: { top: number; left: number } | null;
}

const closed: AutocompleteState = {
  open: false,
  start: 0,
  caret: 0,
  query: "",
  results: [],
  active: 0,
  coords: null,
};

/** Wires `[[` autocomplete onto a controlled textarea. Returns event handlers
 *  to spread onto the <textarea> plus a popup element to render alongside it.
 *  Korean IME compositionstart/end is handled — we don't trigger detection
 *  while a 한자 conversion is in progress. */
export function useWikilinkAutocomplete({
  textareaRef,
  value,
  entries,
  onChange,
}: UseAutocompleteOptions) {
  const [state, setState] = useState<AutocompleteState>(closed);
  const composingRef = useRef(false);

  const close = useCallback(() => {
    setState((s) => (s.open ? closed : s));
  }, []);

  const detect = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (composingRef.current) return;
    const caret = ta.selectionEnd;
    const found = findOpenWikilink(ta.value, caret);
    if (!found) {
      setState((prev) => (prev.open ? closed : prev));
      return;
    }
    const results = suggestWikilinkTargets(entries, found.query);
    if (results.length === 0) {
      setState((prev) => (prev.open ? closed : prev));
      return;
    }
    const coords = caretCoords(ta);
    setState({
      open: true,
      start: found.start,
      caret,
      query: found.query,
      results,
      active: 0,
      coords,
    });
  }, [entries, textareaRef]);

  useEffect(() => {
    detect();
  }, [value, detect]);

  const insertSuggestion = useCallback(
    (s: WikilinkSuggestion) => {
      const ta = textareaRef.current;
      if (!ta) return;
      setState((prev) => {
        if (!prev.open) return prev;
        const before = ta.value.slice(0, prev.start);
        const after = ta.value.slice(prev.caret);
        const insert = `[[${s.target}]]`;
        const next = `${before}${insert}${after}`;
        const newCaret = prev.start + insert.length;
        onChange(next);
        // Caret restore must happen after React commits the value change.
        requestAnimationFrame(() => {
          const node = textareaRef.current;
          if (!node) return;
          node.selectionStart = newCaret;
          node.selectionEnd = newCaret;
          node.focus();
        });
        return closed;
      });
    },
    [onChange, textareaRef],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!state.open || state.results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setState((s) => ({
          ...s,
          active: (s.active + 1) % s.results.length,
        }));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setState((s) => ({
          ...s,
          active: (s.active - 1 + s.results.length) % s.results.length,
        }));
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertSuggestion(state.results[state.active]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    },
    [state, insertSuggestion, close],
  );

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);
  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
    detect();
  }, [detect]);
  const onClick = useCallback(() => detect(), [detect]);
  const onKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Selection changes via arrow keys/Home/End don't fire onChange.
      if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
        detect();
      }
    },
    [detect],
  );

  const popup =
    state.open && state.results.length > 0 && state.coords ? (
      <WikilinkPopup
        coords={state.coords}
        results={state.results}
        active={state.active}
        onSelect={insertSuggestion}
        onHover={(idx) => setState((s) => ({ ...s, active: idx }))}
      />
    ) : null;

  return {
    handlers: {
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      onClick,
      onKeyUp,
    },
    popup,
  };
}

/** Walk back from caret to find the most recent `[[` that has not been closed.
 *  Aborts on newline or unmatched `]` — wikilinks don't span lines, and a
 *  `]` between `[[` and caret means the popup should already have closed. */
function findOpenWikilink(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  if (caret < 2) return null;
  for (let i = caret - 1; i >= 1; i--) {
    const ch = value[i];
    if (ch === "\n" || ch === "]") return null;
    if (ch === "[" && value[i - 1] === "[") {
      const start = i - 1;
      const query = value.slice(i + 1, caret);
      if (query.includes("[") || query.includes("\n")) return null;
      return { start, query };
    }
  }
  return null;
}

const MIRROR_PROPS: (keyof CSSStyleDeclaration)[] = [
  "boxSizing",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontVariant",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textAlign",
  "textIndent",
  "textTransform",
  "whiteSpace",
  "wordSpacing",
  "wordWrap",
  "tabSize",
];

/** Mirror the textarea into an off-screen div and measure where the caret
 *  would sit in screen coords. Returns viewport-relative top/left. */
function caretCoords(ta: HTMLTextAreaElement): { top: number; left: number } {
  const cs = window.getComputedStyle(ta);
  const div = document.createElement("div");
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.top = "0";
  div.style.left = "-9999px";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.overflow = "hidden";
  for (const p of MIRROR_PROPS) {
    (div.style as unknown as Record<string, string>)[p as string] = (cs as unknown as Record<string, string>)[p as string];
  }
  div.style.width = `${ta.clientWidth}px`;
  div.textContent = ta.value.substring(0, ta.selectionEnd);
  const span = document.createElement("span");
  span.textContent = ta.value.substring(ta.selectionEnd) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const rect = ta.getBoundingClientRect();
  const lineHeight = parseFloat(cs.lineHeight || "0") || parseFloat(cs.fontSize || "16") * 1.4;
  const top = rect.top + span.offsetTop - ta.scrollTop + lineHeight;
  const left = rect.left + span.offsetLeft - ta.scrollLeft;
  document.body.removeChild(div);
  return { top, left };
}

interface PopupProps {
  coords: { top: number; left: number };
  results: WikilinkSuggestion[];
  active: number;
  onSelect: (s: WikilinkSuggestion) => void;
  onHover: (idx: number) => void;
}

function WikilinkPopup({ coords, results, active, onSelect, onHover }: PopupProps) {
  return (
    <div
      className="wikilink-popup"
      role="listbox"
      style={{ position: "fixed", top: coords.top, left: coords.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {results.map((r, i) => (
        <button
          key={r.path}
          type="button"
          role="option"
          aria-selected={i === active}
          className={i === active ? "wikilink-suggestion active" : "wikilink-suggestion"}
          onMouseEnter={() => onHover(i)}
          onClick={() => onSelect(r)}
        >
          <span className="wikilink-title">{r.title}</span>
          <span className="wikilink-path">{r.relPath}</span>
        </button>
      ))}
    </div>
  );
}
