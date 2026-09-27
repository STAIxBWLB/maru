import { lazyImport } from "./lazyModule";

// wry 0.54 implements no JavaScript alert/confirm/prompt panels on macOS, so in
// the app confirm() answers false and alert() shows nothing, at once (#377).
// These helpers route to the dialog plugin there and keep the browser dialogs
// in a plain browser, where Playwright and vitest answer them.

const loadDialogModule = lazyImport(() => import("@tauri-apps/plugin-dialog"));

// Same check as clipboard.ts. Not api.ts's isTauri, which a test's partial
// api mock could leave undefined.
const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export interface ConfirmDialogOptions {
  kind?: "warning" | "info" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

// One sheet at a time per window (PR #361): a second sheet stacked on an open
// one leaves both dead, so each dialog waits for the one before it.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(show: () => Promise<T>, onFailure: T): Promise<T> {
  // A dialog that fails to open settles as `onFailure`, so the queue keeps
  // moving and the caller gets an answer instead of waiting forever.
  const settled = queue.then(show).catch(() => onFailure);
  queue = settled;
  return settled;
}

/** Asks OK/Cancel; resolves true only on OK. A failed dialog counts as Cancel. */
export function confirmDialog(message: string, options: ConfirmDialogOptions = {}): Promise<boolean> {
  if (!isTauri()) {
    // eslint-disable-next-line no-alert -- browser fallback, answered by Playwright and vitest
    return Promise.resolve(window.confirm(message));
  }
  return enqueue(async () => {
    const { confirm } = await loadDialogModule();
    return confirm(message, { ...options, kind: options.kind ?? "warning" });
  }, false);
}

/** Shows a notice with a single OK button. */
export function messageDialog(message: string, kind: ConfirmDialogOptions["kind"] = "info"): Promise<void> {
  if (!isTauri()) {
    // eslint-disable-next-line no-alert -- browser fallback, answered by Playwright and vitest
    window.alert(message);
    return Promise.resolve();
  }
  return enqueue(async () => {
    const { message: show } = await loadDialogModule();
    await show(message, { kind });
  }, undefined);
}
