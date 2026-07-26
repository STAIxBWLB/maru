/**
 * Keyboard shortcut helpers shared by the diagram and graph surfaces.
 *
 * `isDiagramKeystroke` is the single ownership boundary for DiagramMode's
 * window-level handler; `matchesShortcut` and `isInEditable` are the
 * primitives its branches are written against.
 *
 * `useScopedKeyboardShortcuts(predicate, handler)` attaches a capture-phase
 * `keydown` on `window`, invokes the handler only when the predicate passes,
 * and stops propagation once the handler prevents the default so outer Maru
 * handlers don't re-process. GraphView uses it. DiagramMode deliberately does
 * not: the inline text editor suppresses diagram shortcuts with React
 * `stopPropagation`, which stops a bubble listener but not a capture one.
 */

import { useEffect } from "react";

import { isChromeTarget } from "../useScopedSelectAll";

export function isInEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Whether a keystroke belongs to the diagram surface.
 *
 *  The diagram's shortcut handler is on `window`, and the canvas is an
 *  unfocusable `<svg>` that nothing focuses on click — so after a bare-canvas
 *  click `event.target` is `BODY`. Ownership therefore cannot be derived from
 *  focus; it is decided by ruling the target *out*: a text field, one of the
 *  diagram's own portaled dialogs, or app chrome. Stated once here so the
 *  ~15 shortcut branches cannot drift apart, which is how Mod+A ended up as
 *  the only branch that fired from a text field. */
export type ShortcutHandler = (event: KeyboardEvent) => void;
export type ShortcutPredicate = (event: KeyboardEvent) => boolean;

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
        // Handled here — stop other listeners from re-acting.
        event.stopImmediatePropagation();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [predicate, handler]);
}

export function isDiagramKeystroke(target: EventTarget | null): boolean {
  if (isInEditable(target)) return false;
  if (isChromeTarget(target)) return false;
  if (target instanceof Element && target.closest('[role="dialog"],[role="alertdialog"]')) {
    return false;
  }
  return true;
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
