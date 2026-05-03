import { describe, expect, it } from "vitest";
import { normalizeAnchorSettings } from "./settings";
import { buildThemeVars, normalizeAccentInput } from "./theme";

describe("theme helpers", () => {
  it("builds CSS variables from the configured accent color", () => {
    const settings = normalizeAnchorSettings({
      ui: {
        accentColor: "#336699",
      },
    });

    const vars = buildThemeVars(settings);
    expect(vars["--accent"]).toBe("#336699");
    expect(vars["--accent-soft"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars["--accent-tint"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("normalizes color input with fallback", () => {
    expect(normalizeAccentInput("#AABBCC", "#000000")).toBe("#aabbcc");
    expect(normalizeAccentInput("bad", "#123456")).toBe("#123456");
  });
});
