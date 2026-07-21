// Browser-only e2e seam. Playwright init scripts register per-command
// invoke handlers on `window.__MARU_E2E_INVOKE__`; command wrappers consult
// them before falling back to the real Tauri invoke (or to the existing
// browser fixtures in api.ts). In the packaged Tauri shell the global never
// exists and this is inert — same opt-in precedent as the
// "maru:e2e:graph-overlay" hook in api.ts.

declare global {
  interface Window {
    __MARU_E2E_INVOKE__?: Record<string, (args: Record<string, unknown>) => unknown>;
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Run the registered e2e override for a Tauri command. Returns null in the
 *  Tauri shell, outside a browser, or when no handler is registered for the
 *  command — callers must fall back to their normal path in those cases. */
export async function invokeE2EOverride<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  if (typeof window === "undefined" || window.__TAURI_INTERNALS__) return null;
  const handler = window.__MARU_E2E_INVOKE__?.[command];
  if (!handler) return null;
  return (await handler(args)) as T;
}
