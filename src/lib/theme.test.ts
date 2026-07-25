import { describe, expect, it } from "vitest";
import { normalizeMaruSettings } from "./settings";
import { buildThemeVars, normalizeAccentInput, resolveThemeMode } from "./theme";

describe("theme helpers", () => {
  it("builds CSS variables from the configured accent color", () => {
    const settings = normalizeMaruSettings({
      ui: {
        accentColor: "#336699",
      },
    });

    const vars = buildThemeVars(settings);
    expect(vars["--accent"]).toBe("#336699");
    expect(vars["--accent-soft"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars["--accent-tint"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars["--focus-ring"]).toBe("#336699");
    expect(vars["--on-accent"]).toBe("#ffffff");
  });

  it("normalizes color input with fallback", () => {
    expect(normalizeAccentInput("#AABBCC", "#000000")).toBe("#aabbcc");
    expect(normalizeAccentInput("bad", "#123456")).toBe("#123456");
  });

  it("resolves system appearance without leaving consumers to infer it", () => {
    expect(resolveThemeMode("system", false)).toBe("light");
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("light", true)).toBe("light");
    expect(resolveThemeMode("dark", false)).toBe("dark");
  });
});
