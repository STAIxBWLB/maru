/**
 * Default skill install mode (symlink vs copy) for Claude Code / Codex installs.
 *
 * Persisted in localStorage under a versioned key, mirroring the locale and
 * diagram-flag conventions. `symlink` (the backend default) keeps installs live
 * against the Anchor store; `copy` writes a self-contained, frozen directory.
 * The stored value is the global DEFAULT — individual installs may override it.
 */
import type { SkillInstallMode } from "./skills";

export const SKILLS_INSTALL_MODE_STORAGE_KEY = "anchor:skills:installMode:v1";

const DEFAULT_INSTALL_MODE: SkillInstallMode = "symlink";

export function readDefaultInstallMode(): SkillInstallMode {
  if (typeof window === "undefined") return DEFAULT_INSTALL_MODE;
  try {
    return window.localStorage.getItem(SKILLS_INSTALL_MODE_STORAGE_KEY) === "copy"
      ? "copy"
      : "symlink";
  } catch {
    return DEFAULT_INSTALL_MODE;
  }
}

export function writeDefaultInstallMode(mode: SkillInstallMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SKILLS_INSTALL_MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore — storage unavailable */
  }
}
