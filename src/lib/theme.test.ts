import { describe, expect, it } from "vitest";
import { normalizeMaruSettings } from "./settings";
import { buildThemeVars, normalizeAccentInput, resolveThemeMode } from "./theme";

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (left, right) => right - left,
  );
  return (light + 0.05) / (dark + 0.05);
}

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

  it("keeps accent foreground text above the WCAG AA threshold", () => {
    // Mid-tone accents are the ones a naive luminance cutoff gets wrong.
    const accents = ["#0071e3", "#336699", "#7faf86", "#c89578", "#f5c518", "#ffffff"];
    for (const accent of accents) {
      const settings = normalizeMaruSettings({ ui: { accentColor: accent } });
      const foreground = buildThemeVars(settings)["--on-accent"];
      expect(contrastRatio(foreground, accent), `${foreground} on ${accent}`)
        .toBeGreaterThanOrEqual(4.5);
    }
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
