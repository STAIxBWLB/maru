// Build-gated debug bridge for the native e2e runner (D-06). One namespaced
// global — `window.__MARU_NATIVE_E2E__` — carries every debug affordance the
// runner needs, so plan 06-04's ship-isolation guard is a single-string check
// rather than a growing allowlist.
//
// Unlike src/lib/e2eInvoke.ts, which is *runtime*-inert and ships in every
// build, this seam must be *build*-inert: the native runner launches the
// debug binary, which serves the production Vite build (import.meta.env.DEV
// is false there), so the gate is `import.meta.env.VITE_NATIVE_E2E === "1"`.
// Vite statically replaces that expression at build time — with `undefined`
// when the flag is unset — so a normal `pnpm build:frontend` folds the gate
// to a literal false and the minifier drops everything behind it. Only
// `pnpm build:frontend:native-e2e` sets the flag.
//
// Each registration entry point repeats the gate as the literal expression
// instead of calling nativeE2eEnabled(): the minifier folds a statically
// replaced expression in place but does not inline a function call across
// module boundaries, so a helper call here would keep the bridge namespace
// string in production bundles (T-06-01).

export interface MaruNativeE2eBridge {
  /** Whole-screen text mirror for one terminal session, or null when the
   *  session id was never registered (a spec racing a session teardown gets
   *  a clean answer, not a throw). */
  terminalText(sessionId: string): string | null;
  /** Dispatch a macOS menu command by id (consumed by plan 06-03's menu
   *  surface). */
  menuCommand(id: string): void;
}

declare global {
  interface Window {
    __MARU_NATIVE_E2E__?: MaruNativeE2eBridge;
  }
}

/** True only in a frontend built with VITE_NATIVE_E2E=1. Mirrors the shape
 *  of graphBridge.ts's graphBridgeEnabled(), including the try/catch. */
export function nativeE2eEnabled(): boolean {
  try {
    return import.meta.env.VITE_NATIVE_E2E === "1";
  } catch {
    return false;
  }
}

const terminalTextReaders = new Map<string, () => string>();
let menuCommandDispatcher: ((id: string) => void) | null = null;

/** Lazily installs the single namespace object on first registration, so an
 *  app with no terminal open installs nothing. */
function bridgeNamespace(): MaruNativeE2eBridge {
  if (!window.__MARU_NATIVE_E2E__) {
    window.__MARU_NATIVE_E2E__ = {
      terminalText: (sessionId) => terminalTextReaders.get(sessionId)?.() ?? null,
      menuCommand: (id) => {
        menuCommandDispatcher?.(id);
      },
    };
  }
  return window.__MARU_NATIVE_E2E__;
}

/** Registers the whole-screen text reader for one terminal session. Takes a
 *  closure rather than an import: src/lib/ must not import from
 *  src/components/, so the component hands the reader in and the dependency
 *  keeps pointing component-to-lib. Returns a disposer; a no-op pair when
 *  the gate is closed. */
export function registerTerminalTextReader(
  sessionId: string,
  read: () => string,
): () => void {
  // Literal gate expression — see the module header for why this is not a
  // nativeE2eEnabled() call.
  if (import.meta.env.VITE_NATIVE_E2E !== "1") return () => {};
  bridgeNamespace();
  terminalTextReaders.set(sessionId, read);
  return () => {
    terminalTextReaders.delete(sessionId);
  };
}

/** Registers the dispatcher behind `menuCommand` on the same single
 *  namespace object. Returns a disposer; a no-op pair when the gate is
 *  closed. */
export function registerMenuCommandDispatcher(dispatch: (id: string) => void): () => void {
  // Literal gate expression — see the module header for why this is not a
  // nativeE2eEnabled() call.
  if (import.meta.env.VITE_NATIVE_E2E !== "1") return () => {};
  bridgeNamespace();
  menuCommandDispatcher = dispatch;
  return () => {
    if (menuCommandDispatcher === dispatch) menuCommandDispatcher = null;
  };
}
