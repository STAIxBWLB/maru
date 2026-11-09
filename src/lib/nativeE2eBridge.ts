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
import type { ArchifyRenderReceipt } from "./archify";

/** Fixed read-only native fixture startup/diagnostic projection, no settings blobs. */
export interface NativeAppState {
  booting: boolean;
  settingsLoaded: boolean;
  settingsWritable: boolean;
  workspacePath: string | null;
  settingsWorkPath: string | null;
  terminalWorkspacePath: string | null;
  catalogReady: boolean;
  catalogLoading: boolean;
  catalogHasFixtureDocument: boolean;
  appMode: string;
  terminalOpen: boolean;
  terminalSplitOpen: boolean;
}

/** Timing for one terminal-frame JSON parse and receiver callback in the
 *  native-only channel harness. Rust preparation, transport and script
 *  compilation are outside this measurement. */
export type NativeE2eChannelEvalSample = Readonly<{
  bytes: number;
  durationMs: number;
  sessionId: string;
  cols: number;
  rows: number;
  /** True when the received frame had dirtyRows === null. */
  fullFrame: boolean;
}>;

export interface NativeE2eDiagramStaticExportResult {
  svgPath: "diagrams/native-static-export.svg";
  pngPath: "diagrams/native-static-export.png";
  svgReceipt: ArchifyRenderReceipt;
  pngReceipt: ArchifyRenderReceipt;
}

export interface NativeE2eEngineMeasurement {
  transport: "ipc";
  scope: string;
  coldMs: number;
  samples: Array<{ nodes: number; bytes: number; durationsMs: number[]; engine: { id: string; version: string; revision: string } }>;
  pngSamples: Array<{
    nodes: number;
    requestBytes: number;
    responseJsonBytes: number;
    outputBytes: number;
    durationMs: number;
    width: number;
    height: number;
    outputSha256: string;
  }>;
}

interface NativePngProbeReport {
  ok: boolean;
  bytes: number[] | null;
  width: number | null;
  height: number | null;
  diagnostics: Array<{ message: string; fix: string }>;
  receipt: { outputSha256: string | null };
}

export interface MaruNativeE2eBridge {
  diagramEngineMeasurement(): Promise<NativeE2eEngineMeasurement>;
  /** Whole-screen text mirror for one terminal session, or null when the
   *  session id was never registered (a spec racing a session teardown gets
   *  a clean answer, not a throw). */
  terminalText(sessionId: string): string | null;
  /** Read-only MainApp dispatcher readiness; namespace installation alone
   *  does not mean menu commands can be dispatched. */
  menuCommandReady(): boolean;
  /** Null until MainApp registers its fixed startup-state reader. */
  readAppState(): NativeAppState | null;
  /** Dispatch one menu command by id. False when no dispatcher is registered,
   *  true after invoking the current callback exactly once; never queued. */
  menuCommand(id: string): boolean;
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
  recordChannelEval(sample: NativeE2eChannelEvalSample): void;
  channelEvals(): ReadonlyArray<NativeE2eChannelEvalSample>;
  /** Fixed semantic export fixture, available only in native-e2e builds. */
  diagramStaticExportFixture(): Promise<NativeE2eDiagramStaticExportResult>;
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
const CHANNEL_EVAL_CAPACITY = 256;
const channelEvalSamples: NativeE2eChannelEvalSample[] = [];
let menuCommandRegistration: { dispatch: (id: string) => void } | null = null;
let appStateRegistration: { read: () => NativeAppState } | null = null;

/** Installs the single namespace on the first reader, dispatcher or harness
 *  registration. Menu readiness follows the dispatcher alone. The plan 08-27 responsiveness
 *  methods are fixed allowlisted production-command calls through imported
 *  invoke; there is deliberately no arbitrary command/path member. */
function bridgeNamespace(): MaruNativeE2eBridge {
  if (!window.__MARU_NATIVE_E2E__) {
    window.__MARU_NATIVE_E2E__ = {
      async diagramEngineMeasurement() {
        const start = performance.now();
        const { createIpcEngine } = await import("./diagram/engine");
        const engine = createIpcEngine();
        const fixtures = [
          (await import("../../src-tauri/crates/maru-diagram-engine/testdata/bench-50.json")).default,
          (await import("../../src-tauri/crates/maru-diagram-engine/testdata/bench-1000.json")).default,
        ];
        const first = await engine.validate(JSON.stringify(fixtures[0]));
        if (!first.ok) throw new Error("E0 IPC fixture failed validation; inspect the SDK fixture and rebuild native-e2e.");
        const coldMs = performance.now() - start;
        const samples = [];
        for (const fixture of fixtures) {
          const input = JSON.stringify(fixture);
          const durationsMs = [];
          let report = first;
          for (let i = 0; i < 30; i++) {
            const before = performance.now();
            report = await engine.validate(input);
            durationsMs.push(performance.now() - before);
            if (!report.ok) throw new Error("E0 IPC validation failed; inspect the engine diagnostics and rerun the spike.");
          }
          samples.push({ nodes: fixture.components.length, bytes: new TextEncoder().encode(input).length, durationsMs, engine: report.receipt.engine });
        }

        const pngFixtures = [
          { name: "typical", spec: (await import("../../src-tauri/crates/maru-diagram-engine/testdata/valid-architecture.json")).default },
          { name: "1000", spec: fixtures[1] },
        ];
        const pngSamples = [];
        const { invoke } = await import("@tauri-apps/api/core");
        for (const { name, spec } of pngFixtures) {
          const input = JSON.stringify(spec);
          const pngInput = JSON.stringify({
            specJson: input,
            format: "png",
            theme: "light",
            pixelRatio: 1,
          });
          const pngStarted = performance.now();
          let pngReport: NativePngProbeReport;
          try {
            pngReport = await invoke<NativePngProbeReport>("plugin:maru-diagram|render_png", { input: pngInput });
          } catch (error) {
            const body = error && typeof error === "object"
              ? error as { code?: unknown; message?: unknown; nextStep?: unknown; diagnostics?: unknown }
              : null;
            const code = typeof body?.code === "string" ? ` [${body.code}]` : "";
            const message = typeof body?.message === "string"
              ? body.message
              : error instanceof Error ? error.message : typeof error === "string" ? error : "unstructured IPC rejection";
            const nextStep = typeof body?.nextStep === "string" ? `; ${body.nextStep}` : "";
            const diagnostic = Array.isArray(body?.diagnostics) ? body.diagnostics[0] as { code?: unknown; message?: unknown; fix?: unknown } | undefined : undefined;
            const detail = typeof diagnostic?.message === "string"
              ? `; ${String(diagnostic.code ?? "diagnostic")}: ${diagnostic.message}${typeof diagnostic.fix === "string" ? `; ${diagnostic.fix}` : ""}`
              : "";
            throw new Error(`Native PNG IPC failed${code}: ${message}${nextStep}${detail}`);
          }
          const durationMs = performance.now() - pngStarted;
          if (!pngReport.ok || !Array.isArray(pngReport.bytes)
              || typeof pngReport.width !== "number" || typeof pngReport.height !== "number"
              || !pngReport.receipt || typeof pngReport.receipt.outputSha256 !== "string") {
            const diagnostic = Array.isArray(pngReport.diagnostics) ? pngReport.diagnostics[0] : undefined;
            throw new Error(`Native PNG probe refused the fixture: ${diagnostic?.message ?? "missing PNG artifact"}; ${diagnostic?.fix ?? "inspect the engine diagnostics and retry"}`);
          }
          const responseJsonBytes = new TextEncoder().encode(JSON.stringify(pngReport)).length;
          pngSamples.push({
            name,
            nodes: spec.components.length,
            requestBytes: new TextEncoder().encode(pngInput).length,
            responseJsonBytes,
            outputBytes: pngReport.bytes.length,
            durationMs,
            width: pngReport.width,
            height: pngReport.height,
            outputSha256: pngReport.receipt.outputSha256,
          });
        }
        return { transport: "ipc", scope: "pre-serialized spec through plugin render_png IPC; core validation, layout, SVG and PNG rendering, receipt/hash, response decode; requestBytes is the UTF-8 plugin input, responseJsonBytes is the UTF-8 JSON re-serialization of the decoded reply, one PNG sample per fixture", coldMs, samples, pngSamples };
      },
      terminalText: (sessionId) => terminalTextReaders.get(sessionId)?.() ?? null,
      menuCommandReady: () => menuCommandRegistration !== null,
      readAppState: () => {
        const state = appStateRegistration?.read();
        if (!state) return null;
        // Project only the allowlisted shape, even when a reader's object has extras.
        return {
          booting: state.booting, settingsLoaded: state.settingsLoaded, settingsWritable: state.settingsWritable,
          workspacePath: state.workspacePath, settingsWorkPath: state.settingsWorkPath, terminalWorkspacePath: state.terminalWorkspacePath,
          catalogReady: state.catalogReady, catalogLoading: state.catalogLoading, catalogHasFixtureDocument: state.catalogHasFixtureDocument,
          appMode: state.appMode, terminalOpen: state.terminalOpen, terminalSplitOpen: state.terminalSplitOpen,
        };
      },
      menuCommand: (id) => {
        const registration = menuCommandRegistration;
        if (!registration) return false;
        registration.dispatch(id);
        return true;
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
      recordChannelEval: (sample) => {
        if (
          !Number.isSafeInteger(sample.bytes) || sample.bytes < 0
          || !Number.isFinite(sample.durationMs) || sample.durationMs < 0
          || typeof sample.sessionId !== "string" || sample.sessionId.length === 0 || sample.sessionId.length > 128
          || !Number.isSafeInteger(sample.cols) || sample.cols <= 0
          || !Number.isSafeInteger(sample.rows) || sample.rows <= 0
          || typeof sample.fullFrame !== "boolean"
        ) return;
        // Copy only the allowlisted measurements; terminal/frame content never
        // enters the bridge ring or its readback.
        channelEvalSamples.push(Object.freeze({
          bytes: sample.bytes,
          durationMs: sample.durationMs,
          sessionId: sample.sessionId,
          cols: sample.cols,
          rows: sample.rows,
          fullFrame: sample.fullFrame,
        }));
        if (channelEvalSamples.length > CHANNEL_EVAL_CAPACITY) {
          channelEvalSamples.splice(0, channelEvalSamples.length - CHANNEL_EVAL_CAPACITY);
        }
      },
      channelEvals: () => Object.freeze(channelEvalSamples.map((sample) => Object.freeze({ ...sample }))),
      diagramStaticExportFixture: async () => {
        if (import.meta.env.VITE_NATIVE_E2E !== "1") {
          throw new Error("The diagram export fixture is available only in native-e2e builds.");
        }
        const state = appStateRegistration?.read();
        const workspace = state?.workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
        const segments = workspace.split("/");
        if (
          !/^(?:[A-Za-z]:)?\//.test(workspace)
          || segments.includes(".") || segments.includes("..")
          || !/(?:^|\/)maru-native-e2e-[^/]+\/workspace$/.test(workspace)
        ) {
          throw new Error("The native diagram export fixture requires the app's isolated maru-native-e2e workspace; restart the native fixture and retry.");
        }

        // Keep diagram/renderer modules out of ordinary frontend builds. The
        // literal build gate above is folded away when VITE_NATIVE_E2E is unset.
        const [{ createEmptyDoc }, { archifySpecToDataset }, { exportVerifiedSemanticArtifact }, { diagramExportBlobToPath }, { NATIVE_EXPORT_SPEC }] = await Promise.all([
          import("./diagram/types"),
          import("./diagram/archifyCodec"),
          import("./diagram/verifiedExport"),
          import("./diagram"),
          import("./diagram/__fixtures__/nativeExport"),
        ]);
        const { dataset } = archifySpecToDataset("architecture", NATIVE_EXPORT_SPEC, { id: "native-static-export-dataset" });
        const doc = { ...createEmptyDoc("native-static-export", Date.now()), datasets: [dataset] };
        const svg = await exportVerifiedSemanticArtifact({
          doc, datasetId: dataset.id, workspace, format: "svg", theme: "light",
        });
        const png = await exportVerifiedSemanticArtifact({
          doc, datasetId: dataset.id, workspace, format: "png", theme: "dark",
        });
        const svgPath = `${workspace}/diagrams/native-static-export.svg`;
        const pngPath = `${workspace}/diagrams/native-static-export.png`;
        const savedSvgPath = await diagramExportBlobToPath(svgPath, "svg", svg.bytes);
        const savedPngPath = await diagramExportBlobToPath(pngPath, "png", png.bytes);
        const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
        if (normalize(savedSvgPath) !== normalize(svgPath) || normalize(savedPngPath) !== normalize(pngPath)) {
          throw new Error("The native diagram export bridge returned an unexpected destination; inspect the isolated fixture workspace and retry.");
        }
        return {
          svgPath: "diagrams/native-static-export.svg",
          pngPath: "diagrams/native-static-export.png",
          svgReceipt: { ...svg.receipt, readback: { status: "passed", scope: "native-saved-file-byte-comparison" } },
          pngReceipt: { ...png.receipt, readback: { status: "passed", scope: "native-saved-file-byte-comparison" } },
        };
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
  const registration = { dispatch };
  menuCommandRegistration = registration;
  return () => {
    if (menuCommandRegistration === registration) menuCommandRegistration = null;
  };
}

/** Registers a fixed read-only app-state projection; registration identity
 * keeps an older disposer from clearing a replacement reader. */
export function registerNativeAppStateReader(read: () => NativeAppState): () => void {
  if (import.meta.env.VITE_NATIVE_E2E !== "1") return () => {};
  bridgeNamespace();
  const registration = { read };
  appStateRegistration = registration;
  return () => {
    if (appStateRegistration === registration) appStateRegistration = null;
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
