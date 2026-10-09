export function isMacPlatform(platform: string | null | undefined): boolean {
  return typeof platform === "string" && platform.toLowerCase().includes("mac");
}

export function currentPlatform(): string {
  return globalThis.navigator?.platform ?? "";
}

/** Format the existing macOS shortcut notation for the current desktop OS. */
export function formatShortcut(shortcut: string, platform = currentPlatform()): string {
  if (isMacPlatform(platform)) return shortcut;
  return shortcut
    .replace(/\s+/g, "")
    .replace(/⌘/g, "Ctrl+")
    .replace(/⇧/g, "Shift+")
    .replace(/⌥/g, "Alt+");
}

export function alternateClickModifier(platform = currentPlatform()): string {
  return isMacPlatform(platform) ? "Option" : "Alt";
}
