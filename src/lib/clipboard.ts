import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

/** Native clipboard write — bypasses WebKit's paste consent overlay. */
export async function clipboardWriteText(text: string): Promise<void> {
  if (!isTauri()) {
    await navigator.clipboard.writeText(text);
    return;
  }
  await writeText(text);
}

/** Native clipboard read. The plugin rejects with arboard's
 *  ContentNotAvailable message when the clipboard holds no text — treat only
 *  that as empty; real failures (permissions, OS errors) propagate so callers
 *  can surface them. */
export async function clipboardReadText(): Promise<string> {
  if (!isTauri()) return navigator.clipboard.readText();
  try {
    return await readText();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("clipboard is empty")) return "";
    throw err;
  }
}
