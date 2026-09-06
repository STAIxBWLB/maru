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

import { invoke } from "@tauri-apps/api/core";

export interface MaruNativeE2eBridge {
  /** Whole-screen text mirror for one terminal session, or null when the
   *  session id was never registered (a spec racing a session teardown gets
   *  a clean answer, not a throw). */
  terminalText(sessionId: string): string | null;
  /** Dispatch a macOS menu command by id (consumed by plan 06-03's menu
   *  surface). */
  menuCommand(id: string): void;
  /** Plan 08-27: same-runtime one-yield async probe. */
  asyncProbe(): Promise<NativeE2eProbeResult>;
  /** Plan 08-27: feature-only saturation/source-race load control. The
   *  request shape is validated and refused by the Rust command; the bridge
   *  exposes no arbitrary command/path port. */
  loadControl(request: NativeE2eLoadControlRequest): Promise<NativeE2eLoadControlStatus>;
  /** Plan 08-27: fixed production-command calls (real registrations). */
  gitStatus(vaultPath: string): Promise<NativeE2eGitStatus>;
  scanVault(vaultPath: string): Promise<Array<{ relPath: string }>>;
  skillsSyncSource(sourceId: string): Promise<Array<{ title: string }>>;
  skillsSyncAllSources(): Promise<NativeE2eSyncAllOutcome>;
  skillsRemoveSource(sourceId: string): Promise<void>;
  parseKoreanDate(input: string, nowIso: string): Promise<string | null>;
}

export interface NativeE2eProbeResult {
  ok: boolean;
  yielded: boolean;
  workerCount: number;
  hook: string;
}

export interface NativeE2eLoadControlArmOp {
  op: "git_status" | "scan_vault" | "skills_sync_source";
  paths?: string[];
  sourceId?: string;
}

export type NativeE2eLoadControlRequest =
  | { action: "arm"; mode: "isolated" | "blockingAsync"; ops: NativeE2eLoadControlArmOp[] }
  | { action: "disarm" }
  | { action: "reset" }
  | { action: "status" }
  | { action: "changeSource"; sourceId: string }
  | { action: "revertSource" };

export interface NativeE2eLoadControlStatus {
  hook: string;
  workerCount: number;
  loadIntervalMs: number;
  armed: Array<{ op: string; mode: string; paths: string[] }>;
  active: Record<string, number>;
  totals: Record<string, number>;
  windows: Record<string, Array<[number, number]>>;
  maxConcurrent: number;
  changedSource: string | null;
}

export interface NativeE2eGitStatus {
  isRepo: boolean;
  modified: number;
  staged: number;
  untracked: number;
  untrackedKnown: boolean;
  clean: boolean;
  branch: string | null;
}

export interface NativeE2eSyncAllOutcome {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{
    sourceId: string;
    kind: string;
    ok: boolean;
    skipped: boolean;
    skills: number;
    lastSyncedAt: string | null;
    error: string | null;
    errorCode: string | null;
  }>;
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
 *  app with no terminal open installs nothing. The plan 08-27 responsiveness
 *  methods are fixed allowlisted production-command calls through imported
 *  invoke; there is deliberately no arbitrary command/path member. */
function bridgeNamespace(): MaruNativeE2eBridge {
  if (!window.__MARU_NATIVE_E2E__) {
    window.__MARU_NATIVE_E2E__ = {
      terminalText: (sessionId) => terminalTextReaders.get(sessionId)?.() ?? null,
      menuCommand: (id) => {
        menuCommandDispatcher?.(id);
      },
      asyncProbe: () => invoke<NativeE2eProbeResult>("native_e2e_async_probe"),
      loadControl: (request) =>
        invoke<NativeE2eLoadControlStatus>("native_e2e_load_control", { request }),
      gitStatus: (vaultPath) => invoke<NativeE2eGitStatus>("git_status", { vaultPath }),
      scanVault: (vaultPath) =>
        invoke<Array<{ relPath: string }>>("scan_vault", { vaultPath }),
      skillsSyncSource: (sourceId) =>
        invoke<Array<{ title: string }>>("skills_sync_source", { sourceId, progressId: null }),
      skillsSyncAllSources: () =>
        invoke<NativeE2eSyncAllOutcome>("skills_sync_all_sources", {
          workPath: null,
          progressId: null,
        }),
      skillsRemoveSource: (sourceId) => invoke("skills_remove_source", { sourceId }),
      parseKoreanDate: (input, nowIso) =>
        invoke<string | null>("parse_korean_date_cmd", { input, nowIso }),
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

/** Plan 08-27: installs the bridge namespace — including the narrowly
 *  allowlisted responsiveness harness (same-runtime async probe, feature-only
 *  load control, and fixed production-command calls) — at app mount, whether
 *  or not any terminal ever opens. The gate below is the literal build-time
 *  expression, so a production bundle folds it away and drops the whole
 *  namespace, harness methods included. */
export function installNativeE2eHarness(): void {
  // Literal gate expression — see the module header for why this is not a
  // nativeE2eEnabled() call.
  if (import.meta.env.VITE_NATIVE_E2E !== "1") return;
  bridgeNamespace();
}
