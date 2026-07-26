import { useEffect } from "react";

/** Pane roots whose contents Cmd/Ctrl+A should select. `closest()` returns the
 *  nearest match, so a node inside `.preview-surface` scopes to the rendered
 *  text rather than the whole editor pane. Tag any new pane with
 *  `data-select-scope` to opt in without editing this list. */
const PANE_SELECTOR = [
  "[data-select-scope]",
  // Radix mounts Dialog.Content outside .app-shell, so a dialog resolves via
  // neither a pane class nor the mode-surface fallback. Without this, Cmd+A in
  // a dialog falls through to whatever the selection anchor last touched -
  // i.e. the pane hidden behind it.
  '[role="dialog"]',
  '[role="alertdialog"]',
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

/** Window chrome. Selecting it is never useful, so it resolves to no scope. */
const SHELL_CHROME_SELECTOR = ".topbar, .activity-rail";

/** Chrome that owns the keystroke outright while it is up. Selecting a menu's
 *  items is meaningless, and an open menu is often portaled to the body, so
 *  merely failing to resolve would let the search fall through to the selection
 *  anchor and pick the pane hidden behind it. Same for the top bar and activity
 *  rail: a focused chrome button must not select whatever was last highlighted. */
const CHROME_TARGET_SELECTOR = [
  ".topbar",
  ".activity-rail",
  '[role="menu"]',
  '[role="menubar"]',
].join(",");

export function isChromeTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && el.closest(CHROME_TARGET_SELECTOR) !== null;
}

/** True when the node sits inside a surface that handles Cmd/Ctrl+A itself.
 *  Mark such a surface with `data-select-all-owner`; its own handler runs on
 *  the bubble phase and is responsible for calling `preventDefault`. */
export function ownsSelectAll(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && el.closest("[data-select-all-owner]") !== null;
}

function closestPane(el: unknown): HTMLElement | null {
  return el instanceof HTMLElement ? el.closest<HTMLElement>(PANE_SELECTOR) : null;
}

/** The mode surface the node sits in: the `.app-shell` grid child that owns it.
 *  This is the fallback for panes missing from `PANE_SELECTOR`. Without it every
 *  unlisted surface — `.today-pane`, `.catalog-pane`, `.sites-pane`, and any
 *  pane added later — would resolve to nothing and Cmd+A would do nothing at
 *  all there, which is no better than selecting the whole window. */
export function closestModeSurface(el: unknown): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  const shell = el.closest<HTMLElement>(".app-shell");
  if (!shell) return null;
  let node: HTMLElement | null = el;
  while (node && node.parentElement !== shell) node = node.parentElement;
  if (!node || node.matches(SHELL_CHROME_SELECTOR)) return null;
  return node;
}

/** The narrowest sensible scope for the first candidate that resolves at all:
 *  a known pane if one encloses it, otherwise the mode surface it belongs to.
 *
 *  Each candidate is resolved completely before moving to the next, because the
 *  candidates are in falling order of trust - the event target, then the focused
 *  element, then wherever the selection happens to be anchored. Trying every
 *  candidate against panes first would let a stale anchor outrank the element
 *  the user actually pressed the key on.
 *
 *  `null` means chrome or nothing at all - callers block the keystroke either
 *  way, never letting the browser select the whole window. */
export function resolveSelectScope(candidates: unknown[]): HTMLElement | null {
  for (const candidate of candidates) {
    const scope = closestPane(candidate) ?? closestModeSurface(candidate);
    if (scope) return scope;
  }
  return null;
}

/** Cmd/Ctrl+A selects only the active pane's text instead of the whole window.
 *  Native editables (the source textarea and the rich block editor) already
 *  scope to themselves, so they are left to the browser; everywhere else we
 *  select the contents of the nearest known pane. Capture phase so we win the
 *  default action.
 *
 *  Outside a known pane we still `preventDefault` and select nothing: the
 *  browser default would highlight the entire window - topbar, activity bar,
 *  every pane and the terminal - which is never what Cmd+A should mean here.
 *  Panes that implement their own select-all (the Files list selects rows) run
 *  their handler on the bubble phase and are unaffected by the blocked default. */
export function createSelectAllHandler(isMac: boolean) {
  return function handler(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (!selectAllComboPressed(event, isMac)) return;
    if (isEditableTarget(event.target)) return;
    // A surface that implements its own select-all (the Files list selects
    // rows) owns the keystroke outright: text-selecting it as well would leave
    // a highlight over the rows it just selected.
    if (ownsSelectAll(event.target)) return;

    event.preventDefault();

    // Chrome answers for itself: block the key and select nothing rather than
    // letting a weaker candidate resolve something behind it.
    if (isChromeTarget(event.target)) return;

    const scope = resolveSelectScope([
      event.target,
      document.activeElement,
      anchorElement(),
    ]);
    if (!scope) return;

    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(scope);
    selection.removeAllRanges();
    selection.addRange(range);
  };
}

export function useScopedSelectAll(): void {
  useEffect(() => {
    const handler = createSelectAllHandler(
      navigator.platform.toLowerCase().includes("mac"),
    );
    document.addEventListener("keydown", handler, { capture: true });
    return () =>
      document.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
