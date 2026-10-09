import { describe, expect, it } from "vitest";
import { alternateClickModifier, formatShortcut, isMacPlatform } from "./platform";

describe("isMacPlatform", () => {
  it("detects macOS platform strings", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("macOS")).toBe(true);
  });

  it("rejects non-macOS platform strings", () => {
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("")).toBe(false);
    expect(isMacPlatform(null)).toBe(false);
  });
});

describe("desktop shortcut labels", () => {
  it("uses Windows modifiers for compact and spaced shortcuts", () => {
    expect(formatShortcut("⌘K", "Win32")).toBe("Ctrl+K");
    expect(formatShortcut("⌘ ⇧ K", "Win32")).toBe("Ctrl+Shift+K");
    expect(formatShortcut("⌥⌘1", "Win32")).toBe("Alt+Ctrl+1");
    expect(alternateClickModifier("Win32")).toBe("Alt");
  });

  it("preserves macOS notation and uses Control on Linux", () => {
    expect(formatShortcut("⌘ ⇧ K", "MacIntel")).toBe("⌘ ⇧ K");
    expect(alternateClickModifier("MacIntel")).toBe("Option");
    expect(formatShortcut("⌘,", "Linux x86_64")).toBe("Ctrl+,");
  });
});
