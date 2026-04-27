import { useEffect } from "react";

export interface ShortcutMap {
  [combo: string]: () => void;
}

/** Listen for Cmd/Ctrl-prefixed shortcuts. Combo grammar: `mod+s`,
 *  `mod+shift+s`, `mod+\`, `mod+/`, `mod+k`. The `mod` token resolves to
 *  Cmd on macOS and Ctrl elsewhere. Single bare keys (e.g. `escape`) work
 *  too. Returns nothing — registers a single document keydown listener. */
export function useKeyboardShortcuts(shortcuts: ShortcutMap, deps: unknown[] = []): void {
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? event.metaKey : event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      const editable =
        tag === "input" || tag === "textarea" || target?.isContentEditable;

      const parts: string[] = [];
      if (mod) parts.push("mod");
      if (event.shiftKey) parts.push("shift");
      if (event.altKey) parts.push("alt");
      const key = event.key.toLowerCase();
      parts.push(key);
      const combo = parts.join("+");

      const fn = shortcuts[combo];
      if (!fn) return;

      // Allow Cmd-S / Cmd-N / Cmd-K to fire even when typing.
      // Bare-key shortcuts (escape, etc.) are blocked while editing.
      if (!mod && editable) return;
      event.preventDefault();
      fn();
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
