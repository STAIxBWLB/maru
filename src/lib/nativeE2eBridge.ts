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
import type { EngineReceipt } from "../../src-tauri/crates/maru-diagram-engine/bindings/engine";

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
  svgReceipt: EngineReceipt;
  pngReceipt: EngineReceipt;
  svgEngineSource: string;
  pngEngineSource: string;
  svgTextMode: "text" | "outlines";
  pngTextMode: "text" | "outlines";
  applyProbe: {
    refused: boolean;
    unchangedAfterRefusal: boolean;
    historyAfterRefusal: number;
    refusalKeys: string[];
    applied: boolean;
    historyAfterApply: number;
    undoRestoredDocument: boolean;
  };
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
  /** T4 real-app check: seeds one document per engine family plus the legacy
   *  v7/v8 bodies, then reports what a fresh engine layout expects, so the
   *  spec can compare it with the boxes this WKWebView paints. */
  diagramEngineE4Fixture(): Promise<NativeE2eDiagramE4Result>;
}

export interface NativeE2eDiagramE4Family {
  type: string;
  datasetId: string;
  documentName: string;
  documentTitle: string;
  /** SHA-256 of the exact bytes handed to the engine, as the canvas publishes it. */
  specSha256: string;
  mixedLabel: string;
  nodes: Array<{ id: string; box: [number, number, number, number] }>;
  containers: Array<{ id: string; box: [number, number, number, number] }>;
  routes: Array<{ id: string; path: string }>;
  labels: Array<{ id: string; targetId: string; lines: string[] }>;
}

export interface NativeE2eDiagramE4Version {
  v: number;
  documentName: string;
  /** The title the app's open list shows for this document. */
  documentTitle: string;
  /** `v` as it was on disk before the loader migrated it. */
  sourceVersion: number | null;
  migratedVersion: number;
  nodeCount: number;
  datasets: number;
  /** Re-serializing what the loader returned equals what a second open returns. */
  reopenEqual: boolean;
}

/** The real engine's refusal of one fixture document, with the anchor the
 *  canvas maps it to, so the spec compares the painted badge against the
 *  engine's own placement instead of a number written by hand. */
export interface NativeE2eDiagramE4Refusal {
  documentName: string;
  documentTitle: string;
  /** SHA-256 of the refused bytes, as the canvas publishes it. */
  specSha256: string;
  code: string;
  path: string;
  category: string;
  targetKind: string;
  targetId: string;
  targetX: number;
  targetY: number;
}

export interface NativeE2eDiagramE4Result {
  families: NativeE2eDiagramE4Family[];
  versions: NativeE2eDiagramE4Version[];
  refusal: NativeE2eDiagramE4Refusal;
  apply: {
    refused: boolean;
    refusalKeys: string[];
    historyAfterRefusal: number;
    applied: boolean;
    historyAfterApply: number;
    undoRestored: boolean;
    redoRestored: boolean;
    /** Every field the saved document carried survives the reopen; the loader
     *  only fills defaults, which `addedFields` names. */
    reopenedWithoutLoss: boolean;
    addedFields: string[];
  };
}

/**
 * Collects the saved fields a reopen did not carry (`missing`) and the ones the
 * loader added on its own (`added`), walking both documents in parallel. A
 * shorter array counts as loss: a dropped member is exactly what a reopen must
 * not do. Key order is not compared, because rebuilding a member fixes it.
 */
function survivingFields(saved: unknown, reopened: unknown, path: string, missing: string[], added: string[]): void {
  if (Array.isArray(saved) || Array.isArray(reopened)) {
    if (!Array.isArray(saved) || !Array.isArray(reopened)) {
      missing.push(`${path} (${Array.isArray(saved) ? "array" : "value"} became ${Array.isArray(reopened) ? "array" : "value"})`);
      return;
    }
    if (saved.length !== reopened.length) {
      missing.push(`${path} length ${saved.length} → ${reopened.length}`);
      return;
    }
    saved.forEach((item, index) => survivingFields(item, reopened[index], `${path}[${index}]`, missing, added));
    return;
  }
  if (saved !== null && reopened !== null && typeof saved === "object" && typeof reopened === "object") {
    const left = saved as Record<string, unknown>;
    const right = reopened as Record<string, unknown>;
    for (const key of Object.keys(left)) {
      if (!Object.hasOwn(right, key)) {
        missing.push(path === "" ? key : `${path}.${key}`);
        continue;
      }
      survivingFields(left[key], right[key], path === "" ? key : `${path}.${key}`, missing, added);
    }
    for (const key of Object.keys(right)) {
      if (!Object.hasOwn(left, key)) added.push(path === "" ? key : `${path}.${key}`);
    }
    return;
  }
  if (!Object.is(saved, reopened)) {
    missing.push(`${path === "" ? "(root)" : path} ${JSON.stringify(saved)} → ${JSON.stringify(reopened)}`);
  }
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
        const [
          { createInitialEphemeral },
          { archifySpecToDataset },
          { SEMANTIC_FIXTURES },
          { projectSemanticDocument },
          { createDiagramStore },
          { applyValidatedSemanticEdit },
          { addSemanticEntry, removeSemanticEntries },
          { undo },
          { validateEngineCandidate, renderEngineCandidate },
          { exportVerifiedSemanticArtifact },
          { diagramExportBlobToPath },
        ] = await Promise.all([
          import("./diagram/types"),
          import("./diagram/archifyCodec"),
          import("./diagram/__fixtures__/semantic"),
          import("./diagram/semantic"),
          import("./diagram/state"),
          import("./diagram/semanticApply"),
          import("./diagram/semanticEdit"),
          import("./diagram/actions"),
          import("./diagram/engine"),
          import("./diagram/verifiedExport"),
          import("./diagram"),
        ]);

        const workflowSpec = {
          ...structuredClone(SEMANTIC_FIXTURES.workflow),
          semanticChecks: { allowedRoots: ["draft"], allowedTerminals: ["merge"] },
        };
        const refusedDataset = archifySpecToDataset("workflow", workflowSpec, { id: "native-apply-refusal" }).dataset;
        const refusedStore = createDiagramStore({
          doc: projectSemanticDocument(refusedDataset).doc,
          ephemeral: createInitialEphemeral(),
        });
        const beforeRefusal = refusedStore.getState().doc;
        const removal = removeSemanticEntries("workflow", refusedDataset.spec, [{ field: "nodes", index: 0 }]);
        const refused = await applyValidatedSemanticEdit(refusedStore, refusedDataset.id, removal.transform, {
          validateCandidate: (type, spec) => validateEngineCandidate(type, spec),
        });
        const refusalProbe = {
          refused: refused.status === "invalid",
          unchangedAfterRefusal: refusedStore.getState().doc === beforeRefusal,
          historyAfterRefusal: refusedStore.getState().ephemeral.history.past.length,
          refusalKeys: refused.status === "invalid" ? refused.diagnostics.map((item) => item.key) : [],
        };

        const lifecycleDataset = archifySpecToDataset("lifecycle", SEMANTIC_FIXTURES.lifecycle, { id: "native-apply-undo" }).dataset;
        const lifecycleStore = createDiagramStore({
          doc: projectSemanticDocument(lifecycleDataset).doc,
          ephemeral: createInitialEphemeral(),
        });
        const beforeApply = structuredClone(lifecycleStore.getState().doc);
        const applied = await applyValidatedSemanticEdit(
          lifecycleStore,
          lifecycleDataset.id,
          addSemanticEntry("lifecycle", "states", { type: "active", label: "Native probe", lane: "main", col: 3 }),
          { validateCandidate: (type, spec) => validateEngineCandidate(type, spec) },
        );
        const historyAfterApply = lifecycleStore.getState().ephemeral.history.past.length;
        if (applied.status === "applied") lifecycleStore.setState(undo());
        const applyProbe = {
          ...refusalProbe,
          applied: applied.status === "applied",
          historyAfterApply,
          undoRestoredDocument: JSON.stringify(lifecycleStore.getState().doc) === JSON.stringify(beforeApply),
        };

        const nativeSpec = structuredClone(SEMANTIC_FIXTURES.architecture);
        nativeSpec.meta = { ...(nativeSpec.meta as Record<string, unknown>), title: "Native engine export" };
        const components = nativeSpec.components as Array<Record<string, unknown>>;
        components[0] = { ...components[0], label: "한日中" };
        const { dataset } = archifySpecToDataset("architecture", nativeSpec, { id: "native-static-export-dataset" });
        const doc = projectSemanticDocument(dataset).doc;
        let svgEngineSource: string | null = null;
        let pngEngineSource: string | null = null;
        let svgTextMode: "text" | "outlines" | null = null;
        let pngTextMode: "text" | "outlines" | null = null;
        // Capture the SVG from each same render-and-store report: a PNG receipt
        // hashes its text-mode rasterization source, not the separate outlined SVG.
        const svg = await exportVerifiedSemanticArtifact({
          doc, datasetId: dataset.id, workspace, format: "svg", theme: "light",
          host: async (type, json, context, options) => {
            const rendered = await renderEngineCandidate(workspace, type, json, context, options);
            svgEngineSource = rendered.svg;
            svgTextMode = rendered.textMode ?? null;
            return rendered;
          },
        });
        const png = await exportVerifiedSemanticArtifact({
          doc, datasetId: dataset.id, workspace, format: "png", theme: "dark",
          host: async (type, json, context, options) => {
            const rendered = await renderEngineCandidate(workspace, type, json, context, options);
            pngEngineSource = rendered.svg;
            pngTextMode = rendered.textMode ?? null;
            return rendered;
          },
        });
        if (svgEngineSource === null || pngEngineSource === null || svgTextMode === null || pngTextMode === null) {
          throw new Error("The native diagram engine omitted an intermediate SVG source or text-mode receipt; rebuild the matching engine and retry.");
        }
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
          svgEngineSource,
          pngEngineSource,
          svgTextMode,
          pngTextMode,
          applyProbe,
        };
      },
      // T4: the canvas is the artifact under test, so this fixture reports what
      // a fresh engine layout expects for a document saved through the real IPC
      // path; the spec compares that with the boxes this WKWebView painted.
      diagramEngineE4Fixture: async () => {
        if (import.meta.env.VITE_NATIVE_E2E !== "1") {
          throw new Error("The diagram canvas fixture is available only in native-e2e builds.");
        }
        const state = appStateRegistration?.read();
        const workspace = state?.workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
        const segments = workspace.split("/");
        if (
          !/^(?:[A-Za-z]:)?\//.test(workspace)
          || segments.includes(".") || segments.includes("..")
          || !/(?:^|\/)maru-native-e2e-[^/]+\/workspace$/.test(workspace)
        ) {
          throw new Error("The native canvas fixture requires the app's isolated maru-native-e2e workspace; restart the native fixture and retry.");
        }

        const [
          { createInitialEphemeral },
          { archifySpecToDataset },
          { projectSemanticDocument },
          { createDiagramStore },
          { applyValidatedSemanticEdit },
          { undo, redo },
          { removeSemanticEntries, addSemanticEntry },
          { validateEngineCandidate, layout: layoutRequest },
          { buildEngineCanvasLayoutRequest, fixedToPixels },
          { serializeDoc, readDiagramDetailed },
          { diagramSaveDocument },
          { mapCanvasDiagnostics },
          { NATIVE_E4_DIAGRAM_TYPES, NATIVE_E4_LEGACY_DOCUMENTS, nativeE4Spec, nativeE4RefusedSpec, NATIVE_E4_MIXED_LABEL },
        ] = await Promise.all([
          import("./diagram/types"),
          import("./diagram/archifyCodec"),
          import("./diagram/semantic"),
          import("./diagram/state"),
          import("./diagram/semanticApply"),
          import("./diagram/actions"),
          import("./diagram/semanticEdit"),
          import("./diagram/engine"),
          import("./diagram/engineGeometryCanvas"),
          import("./diagram/persistence"),
          import("./diagram"),
          import("./diagram/canvasDiagnostics"),
          import("./diagram/__fixtures__/nativeEngineE4"),
        ]);

        const px = (value: number, what: string) => fixedToPixels(value, what);
        const boxOf = (bounds: { x: number; y: number; width: number; height: number }, what: string) =>
          [px(bounds.x, what), px(bounds.y, what), px(bounds.width, what), px(bounds.height, what)] as
            [number, number, number, number];

        const families: NativeE2eDiagramE4Family[] = [];
        for (const type of NATIVE_E4_DIAGRAM_TYPES) {
          const { dataset } = archifySpecToDataset(type, nativeE4Spec(type), { id: `native-e4-${type}` });
          const documentName = `t4-${type}`;
          await diagramSaveDocument(workspace, documentName, serializeDoc(projectSemanticDocument(dataset).doc));
          // Read it back through the app's own loader: the canvas lays out the
          // document a reopened file holds, not the projection in memory.
          const { doc } = await readDiagramDetailed(workspace, documentName);
          // A saved fixture carries no pins, so this is byte-for-byte the
          // request the canvas builds and the engine's own answer to it.
          const request = await buildEngineCanvasLayoutRequest(doc, dataset.id);
          const report = await layoutRequest(request);
          const scene = report.ok ? report.geometry : null;
          if (!scene) {
            throw new Error(`the engine refused the ${type} fixture: ${JSON.stringify(report.diagnostics)}; repair the fixture before comparing.`);
          }
          const what = `${type} geometry`;
          families.push({
            type,
            datasetId: dataset.id,
            documentName,
            documentTitle: doc.docTitle.length > 0 ? doc.docTitle : documentName,
            specSha256: request.pinSet?.sourceSpecSha256 ?? "",
            mixedLabel: NATIVE_E4_MIXED_LABEL[type],
            nodes: scene.nodes.map((node) => ({ id: node.id, box: boxOf(node.bounds, what) })),
            containers: scene.containers.map((container) => ({ id: container.id, box: boxOf(container.bounds, what) })),
            routes: scene.routes.flatMap((route) => (route.id ? [{
              id: route.id,
              path: route.points
                .map((point, index) => `${index === 0 ? "M" : "L"} ${px(point.x, what)} ${px(point.y, what)}`)
                .join(" "),
            }] : [])),
            labels: scene.labels.flatMap((label) => (typeof label.id === "string"
              ? [{ id: label.id, targetId: label.targetId, lines: label.text.split("\n") }]
              : [])),
          });
        }

        const versions: NativeE2eDiagramE4Version[] = [];
        for (const key of ["v7", "v8"] as const) {
          const body = NATIVE_E4_LEGACY_DOCUMENTS[key];
          const documentName = `t4-legacy-${key}`;
          await diagramSaveDocument(workspace, documentName, JSON.stringify(body));
          const first = await readDiagramDetailed(workspace, documentName);
          const second = await readDiagramDetailed(workspace, documentName);
          // The v7 upgrade mints a dataset id per load and writes it into the
          // node's own meta, so a reopen must preserve what the user authored:
          // the node geometry and labels plus the edge endpoints.
          const authored = (doc: typeof first.doc) => JSON.stringify({
            nodes: doc.nodes.map((node) => ({
              id: node.id, kind: node.kind, x: node.x, y: node.y, w: node.w, h: node.h, title: node.title ?? null,
            })),
            edges: doc.edges.map((edge) => ({ from: edge.fromNode, to: edge.toNode })),
          });
          const reopenEqual = key === "v7"
            ? authored(first.doc) === authored(second.doc)
              && (first.doc.datasets?.length ?? 0) === (second.doc.datasets?.length ?? 0)
            : serializeDoc(first.doc) === serializeDoc(second.doc);
          versions.push({
            v: body.v,
            documentName,
            documentTitle: first.doc.docTitle.length > 0 ? first.doc.docTitle : documentName,
            sourceVersion: first.sourceVersion,
            migratedVersion: first.doc.v,
            nodeCount: first.doc.nodes.length,
            datasets: first.doc.datasets?.length ?? 0,
            reopenEqual,
          });
        }
        const savedWorkflow = await readDiagramDetailed(workspace, "t4-workflow");
        versions.push({
          v: 9,
          documentName: "t4-workflow",
          documentTitle: savedWorkflow.doc.docTitle.length > 0 ? savedWorkflow.doc.docTitle : "t4-workflow",
          sourceVersion: savedWorkflow.sourceVersion,
          migratedVersion: savedWorkflow.doc.v,
          nodeCount: savedWorkflow.doc.nodes.length,
          datasets: savedWorkflow.doc.datasets?.length ?? 0,
          reopenEqual: serializeDoc(savedWorkflow.doc) === serializeDoc((await readDiagramDetailed(workspace, "t4-workflow")).doc),
        });

        // AC4: a structural edit that the engine refuses leaves no trace, the
        // accepted one costs one history step, undo and redo move between the
        // two documents, and the saved result reopens unchanged. The refusal
        // needs the authored semanticChecks; the accepted edit runs on the same
        // spec without them, so the guard cannot mask its own outcome.
        const guardedSpec = {
          ...nativeE4Spec("workflow"),
          semanticChecks: { allowedRoots: ["draft"], allowedTerminals: ["merge"] },
        };
        const host = { validateCandidate: (type: string, spec: Record<string, unknown>) => validateEngineCandidate(type, spec) };
        const { dataset: guardedDataset } = archifySpecToDataset("workflow", guardedSpec, { id: "native-e4-refusal" });
        const refusedStore = createDiagramStore({
          doc: projectSemanticDocument(guardedDataset).doc,
          ephemeral: createInitialEphemeral(),
        });
        const beforeRefusal = refusedStore.getState().doc;
        const refused = await applyValidatedSemanticEdit(
          refusedStore,
          guardedDataset.id,
          removeSemanticEntries("workflow", guardedDataset.spec, [{ field: "nodes", index: 0 }]).transform,
          host,
        );
        const historyAfterRefusal = refusedStore.getState().ephemeral.history.past.length;
        const unchangedAfterRefusal = refusedStore.getState().doc === beforeRefusal;

        // A distinct title keeps this probe's document out of the family
        // document's row in the app's open list, which matches on docTitle.
        const applySpec = nativeE4Spec("workflow");
        applySpec.meta = { ...(applySpec.meta as Record<string, unknown>), title: "T4 apply 점검 Check" };
        const { dataset: applyDataset } = archifySpecToDataset("workflow", applySpec, { id: "native-e4-apply" });
        const store = createDiagramStore({
          doc: projectSemanticDocument(applyDataset).doc,
          ephemeral: createInitialEphemeral(),
        });
        const beforeApply = store.getState().doc;
        const applied = await applyValidatedSemanticEdit(
          store,
          applyDataset.id,
          addSemanticEntry("workflow", "nodes", { lane: "reviewer", col: 3, type: "backend", label: "T4 점검 Check" }),
          host,
        );
        const historyAfterApply = store.getState().ephemeral.history.past.length;
        const afterApply = store.getState().doc;
        if (applied.status === "applied") store.setState(undo());
        const undoRestored = JSON.stringify(store.getState().doc) === JSON.stringify(beforeApply);
        if (applied.status === "applied") store.setState(redo());
        const redoRestored = JSON.stringify(store.getState().doc) === JSON.stringify(afterApply);
        const appliedName = "t4-workflow-apply";
        await diagramSaveDocument(workspace, appliedName, serializeDoc(store.getState().doc));
        const reopened = await readDiagramDetailed(workspace, appliedName);
        // The loader rebuilds every member through its own defaults, so a JSON
        // string comparison would fail on key order and on filled-in defaults
        // rather than on lost content. What must hold is that every saved field
        // survives and that a second load adds nothing further.
        const missing: string[] = [];
        const added: string[] = [];
        survivingFields(store.getState().doc, reopened.doc, "", missing, added);
        const secondLoad = await readDiagramDetailed(workspace, appliedName);
        const reloadAdded: string[] = [];
        survivingFields(reopened.doc, secondLoad.doc, "", [], reloadAdded);

        // AC8: the real engine refuses one fixture document, so the canvas has
        // to keep the member's place and anchor the diagnostic beside it.
        const refusedName = "t4-refused";
        const { dataset: refusedDataset } = archifySpecToDataset("workflow", nativeE4RefusedSpec(), { id: "native-e4-refused" });
        await diagramSaveDocument(workspace, refusedName, serializeDoc(projectSemanticDocument(refusedDataset).doc));
        const refusedDoc = (await readDiagramDetailed(workspace, refusedName)).doc;
        const refusedRequest = await buildEngineCanvasLayoutRequest(refusedDoc, refusedDataset.id);
        const refusedReport = await layoutRequest(refusedRequest);
        if (refusedReport.ok) {
          throw new Error(`the engine laid out the refusal fixture; the diagnostic check needs a document it refuses: ${JSON.stringify(refusedReport.diagnostics)}`);
        }
        const placements = mapCanvasDiagnostics(refusedDoc, refusedDataset.id, null, refusedReport.diagnostics);
        const anchored = placements.find((placement) => placement.target !== null);
        if (!anchored || !anchored.target) {
          throw new Error(`the engine's refusal carried no member anchor: ${JSON.stringify(refusedReport.diagnostics)}`);
        }
        const refusal: NativeE2eDiagramE4Refusal = {
          documentName: refusedName,
          documentTitle: refusedDoc.docTitle.length > 0 ? refusedDoc.docTitle : refusedName,
          specSha256: refusedRequest.pinSet?.sourceSpecSha256 ?? "",
          code: anchored.diagnostic.code,
          path: anchored.diagnostic.path,
          category: anchored.category,
          targetKind: anchored.target.kind,
          targetId: anchored.target.id,
          targetX: anchored.target.x,
          targetY: anchored.target.y,
        };

        return {
          families,
          versions,
          refusal,
          apply: {
            refused: refused.status === "invalid",
            refusalKeys: refused.status === "invalid" ? refused.diagnostics.map((item) => item.key) : [],
            historyAfterRefusal: unchangedAfterRefusal ? historyAfterRefusal : -1,
            applied: applied.status === "applied",
            historyAfterApply,
            undoRestored,
            redoRestored,
            reopenedWithoutLoss: missing.length === 0 && reloadAdded.length === 0,
            addedFields: [...new Set(added.map((field) => field.replace(/\[\d+\]/g, "[]")))].sort(),
          } satisfies NativeE2eDiagramE4Result["apply"],
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
