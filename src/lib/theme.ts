import type { CSSProperties } from "react";
import type { MaruSettings, ThemeMode } from "./settings";

export type ThemeVars = CSSProperties & Record<`--${string}`, string>;
export type ResolvedThemeMode = "light" | "dark";

export function buildThemeVars(settings: MaruSettings): ThemeVars {
  const accent = settings.ui.accentColor;
  const dark = resolveThemeMode(settings.ui.themeMode) === "dark";
  // Tints mix toward the warm paper/ink base (not pure white/black) so any
  // user-picked accent stays in the hanji/ink palette family.
  const base = dark ? "#231f17" : "#fcfaf3";
  return {
    "--accent": accent,
    "--accent-soft": mixHex(accent, base, dark ? 0.68 : 0.78),
    "--accent-tint": mixHex(accent, base, dark ? 0.8 : 0.9),
    "--active-surface": mixHex(accent, base, dark ? 0.78 : 0.9),
    "--button-primary-hover": mixHex(accent, dark ? "#f0ead9" : "#221e15", 0.14),
    "--focus-ring": accent,
    "--on-accent": contrastText(accent),
    "--rail-indicator": accent,
  };
}

function prefersDarkMode(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function resolveThemeMode(
  themeMode: ThemeMode,
  systemPrefersDark = prefersDarkMode(),
): ResolvedThemeMode {
  if (themeMode === "system") return systemPrefersDark ? "dark" : "light";
  return themeMode;
}

export function applyThemePreference(themeMode: ThemeMode): void {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.theme = resolveThemeMode(themeMode);
    root.dataset.themePreference = themeMode;
  }

  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void import("@tauri-apps/api/app")
    .then(({ setTheme }) => setTheme(themeMode === "system" ? null : themeMode))
    .catch(() => {});
}

export function subscribeToSystemTheme(
  themeMode: ThemeMode,
  onChange: () => void,
): () => void {
  if (
    themeMode !== "system" ||
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => {};
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = () => onChange();
  query.addEventListener?.("change", listener);
  return () => query.removeEventListener?.("change", listener);
}

export function applyThemeVars(vars: ThemeVars): void {
  if (typeof document === "undefined") return;
  for (const [key, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(key, value);
  }
}

export function normalizeAccentInput(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

function mixHex(a: string, b: string, amountB: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const amountA = 1 - amountB;
  const channels = [0, 1, 2].map((index) =>
    Math.round(ca[index] * amountA + cb[index] * amountB),
  );
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function contrastText(value: string): "#ffffff" | "#1d1d1f" {
  const parsed = parseHex(value);
  if (!parsed) return "#ffffff";
  const [r, g, b] = parsed.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Crossover where white and #1d1d1f give equal WCAG contrast against the
  // accent: (1.05)/(L+0.05) == (L+0.05)/(0.0123+0.05) => L ~= 0.206. The old
  // 0.48 handed white text to every mid-tone accent at roughly 2:1.
  return luminance > 0.206 ? "#1d1d1f" : "#ffffff";
}

function parseHex(value: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (!match) return null;
  const raw = match[1];
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}
