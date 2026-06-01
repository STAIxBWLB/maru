import { useEffect } from "react";

/** Pane roots whose contents Cmd/Ctrl+A should select. `closest()` returns the
 *  nearest match, so a node inside `.preview-surface` scopes to the rendered
 *  text rather than the whole editor pane. Tag any new pane with
 *  `data-select-scope` to opt in without editing this list. */
const PANE_SELECTOR = [
  "[data-select-scope]",
  ".preview-surface",
  ".editor-pane",
  ".outline-pane",
  ".document-list",
  ".inbox-pane",
  ".comms-pane",
  ".tasks-pane",
  ".system-pane",
  ".studio-pane",
  ".meetings-main",
].join(",");

/** A native editable already scopes select-all to itself — leave it alone.
 *  Duck-typed (no `instanceof HTMLElement`) so it is safe for non-element
 *  targets and unit-testable without a DOM. */
export function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as (Partial<HTMLElement> & { tagName?: string }) | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || node.isContentEditable === true;
}

/** Cmd+A on macOS / Ctrl+A elsewhere, with no other modifiers. */
export function selectAllComboPressed(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  isMac: boolean,
): boolean {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  return mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a";
}

function anchorElement(): HTMLElement | null {
  const node = window.getSelection()?.anchorNode ?? null;
  if (!node) return null;
  return node instanceof HTMLElement ? node : node.parentElement;
}

function closestPane(el: unknown): HTMLElement | null {
  return el instanceof HTMLElement ? el.closest<HTMLElement>(PANE_SELECTOR) : null;
}

/** Cmd/Ctrl+A selects only the active pane's text instead of the whole window.
 *  Native editables (the source textarea and the rich block editor) already
 *  scope to themselves, so they are left to the browser; everywhere else we
 *  select the contents of the nearest known pane. Capture phase so we win the
 *  default action; we only `preventDefault` once a pane scope is resolved, so
 *  dialogs and unrecognized surfaces keep their browser behavior. */
export function useScopedSelectAll(): void {
  useEffect(() => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    function handler(event: KeyboardEvent) {
      if (event.isComposing) return;
      if (!selectAllComboPressed(event, isMac)) return;
      if (isEditableTarget(event.target)) return;

      const scope =
        closestPane(event.target) ??
        closestPane(document.activeElement) ??
        closestPane(anchorElement());
      if (!scope) return;

      const selection = window.getSelection();
      if (!selection) return;
      event.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(scope);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.addEventListener("keydown", handler, { capture: true });
    return () =>
      document.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
