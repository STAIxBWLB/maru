declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const DIAGRAM_ENABLE_STORAGE_KEY = "anchor:diagram:enabled";

export function isDiagramEnabled(): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const envValue = env?.VITE_ANCHOR_DIAGRAM;
  if (envValue === "1" || envValue === "true" || envValue === true) return true;
  if (typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get("anchor-diagram");
  if (queryValue === "1" || queryValue === "true") return true;

  try {
    const storedValue = window.localStorage.getItem(DIAGRAM_ENABLE_STORAGE_KEY);
    return storedValue === "1" || storedValue === "true";
  } catch {
    return false;
  }
}
