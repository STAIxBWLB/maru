/**
 * Test-only render observer for the production shell boundaries.  The normal
 * application path stays a constant-time no-op and never passes user data to
 * the observer.
 */
export type ShellSurfaceRenderTarget =
  | "MainApp"
  | "DocumentList"
  | "TerminalPanel"
  | "ActivityRail";

type ShellSurfaceRenderObserver = ((target: ShellSurfaceRenderTarget) => void) | null;

let observer: ShellSurfaceRenderObserver = null;

export function recordShellSurfaceRender(target: ShellSurfaceRenderTarget): void {
  observer?.(target);
}

/** Installs a test observer and returns a restoration function. */
export function setShellSurfaceRenderObserverForTest(
  nextObserver: ShellSurfaceRenderObserver,
): () => void {
  const previous = observer;
  observer = nextObserver;
  return () => {
    observer = previous;
  };
}
