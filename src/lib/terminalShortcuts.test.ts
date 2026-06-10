import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  normalizeTerminalShortcuts,
  terminalShortcutActionForEvent,
} from "./terminalShortcuts";

type KeyEventLike = Parameters<typeof terminalShortcutActionForEvent>[0];

function key(event: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return {
    key: event.key,
    code: event.code ?? `Key${event.key.toUpperCase()}`,
    metaKey: event.metaKey ?? false,
    ctrlKey: event.ctrlKey ?? false,
    altKey: event.altKey ?? false,
    shiftKey: event.shiftKey ?? false,
  };
}

describe("terminal shortcuts", () => {
  it("maps macOS command chords to terminal-owned actions", () => {
    expect(
      terminalShortcutActionForEvent(
        key({ key: "v", metaKey: true }),
        DEFAULT_TERMINAL_SHORTCUTS,
        true,
      ),
    ).toBe("paste");
    expect(
      terminalShortcutActionForEvent(
        key({ key: "f", metaKey: true }),
        DEFAULT_TERMINAL_SHORTCUTS,
        true,
      ),
    ).toBe("find");
    expect(
      terminalShortcutActionForEvent(
        key({ key: "3", metaKey: true, code: "Digit3" }),
        DEFAULT_TERMINAL_SHORTCUTS,
        true,
      ),
    ).toBe("tab3");
    // Cmd+K clears the terminal while it is focused (Warp/iTerm2 standard);
    // the app command palette keeps mod+k everywhere else.
    expect(
      terminalShortcutActionForEvent(
        key({ key: "k", metaKey: true }),
        DEFAULT_TERMINAL_SHORTCUTS,
        true,
      ),
    ).toBe("clear");
  });

  it("does not claim unrelated application shortcuts", () => {
    expect(
      terminalShortcutActionForEvent(
        key({ key: "p", metaKey: true }),
        DEFAULT_TERMINAL_SHORTCUTS,
        true,
      ),
    ).toBeNull();
    expect(
      terminalShortcutActionForEvent(
        key({ key: ",", metaKey: true, code: "Comma" }),
        DEFAULT_TERMINAL_SHORTCUTS,
        true,
      ),
    ).toBeNull();
  });

  it("normalizes remapped and unbound shortcuts", () => {
    const shortcuts = normalizeTerminalShortcuts({
      paste: "mod+shift+v",
      find: null,
      copy: "not a chord",
    });

    expect(shortcuts.paste).toBe("mod+shift+v");
    expect(shortcuts.find).toBeNull();
    expect(shortcuts.copy).toBe(DEFAULT_TERMINAL_SHORTCUTS.copy);
  });
});
