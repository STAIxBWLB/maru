import type { CSSProperties } from "react";
import type { AnchorSettings, ThemeMode } from "./settings";

export type ThemeVars = CSSProperties & Record<`--${string}`, string>;

export function buildThemeVars(settings: AnchorSettings): ThemeVars {
  const accent = settings.ui.accentColor;
  const dark =
    settings.ui.themeMode === "dark" ||
    (settings.ui.themeMode === "system" && prefersDarkMode());
  return {
    "--accent": accent,
    "--accent-soft": mixHex(accent, dark ? "#1b1a17" : "#ffffff", dark ? 0.68 : 0.78),
    "--accent-tint": mixHex(accent, dark ? "#1b1a17" : "#ffffff", dark ? 0.78 : 0.88),
  };
}

function prefersDarkMode(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function applyThemePreference(themeMode: ThemeMode): void {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (themeMode === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.dataset.theme = themeMode;
    }
  }

  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void import("@tauri-apps/api/app")
    .then(({ setTheme }) => setTheme(themeMode === "system" ? null : themeMode))
    .catch(() => {});
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
