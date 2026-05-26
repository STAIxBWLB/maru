/**
 * Diagram-scoped keyboard shortcut hook.
 *
 * The source HTML editor's keydown handler (line 9223) is a 100-line global
 * switch that fires regardless of focus context. Anchor's main shell already
 * binds Cmd+S elsewhere; we need a way to scope diagram shortcuts to the
 * diagram pane and call `stopImmediatePropagation()` so the global handler
 * doesn't double-fire.
 *
 * `useScopedKeyboardShortcuts(predicate, handler)` attaches a `keydown` on
 * `window` (with `capture: true`) but only invokes the handler when the
 * `predicate` returns truthy. When the handler calls `event.preventDefault()`
 * we also stop propagation so the outer Anchor handlers don't re-process.
 */

import { useEffect } from "react";

export type ShortcutHandler = (event: KeyboardEvent) => void;
export type ShortcutPredicate = (event: KeyboardEvent) => boolean;

export function isInEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useScopedKeyboardShortcuts(
  predicate: ShortcutPredicate,
  handler: ShortcutHandler,
): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!predicate(event)) return;
      const before = event.defaultPrevented;
      handler(event);
      if (!before && event.defaultPrevented) {
        // Diagram handled it — stop other listeners from re-acting.
        event.stopImmediatePropagation();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [predicate, handler]);
}

export function matchesShortcut(
  event: KeyboardEvent,
  combo: { key: string; mod?: boolean; shift?: boolean; alt?: boolean },
): boolean {
  if (event.key.toLowerCase() !== combo.key.toLowerCase()) return false;
  if (combo.mod && !(event.metaKey || event.ctrlKey)) return false;
  if (!combo.mod && (event.metaKey || event.ctrlKey)) return false;
  if (combo.shift !== undefined && event.shiftKey !== combo.shift) return false;
  if (combo.alt !== undefined && event.altKey !== combo.alt) return false;
  return true;
}
