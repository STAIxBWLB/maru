// Mocha hooks propagate setup failures to the spec. WDIO config.beforeTest
// catches/logs such errors and still runs the test, so do not put resets there.
import fs from "node:fs/promises";
import path from "node:path";
import { fixtureRootDir, resetFixtureWorkspace } from "./helpers/fixtureWorkspace";
import type { NativeAppState } from "./helpers/ptyAssertions";
import type {} from "webdriverio";

export const NATIVE_PROFILE_MARKER_KEY = "maru:native-e2e:fixture-profile-owner";

function assertNoWorkerFailure(): void {
  if (process.env.MARU_NATIVE_E2E_SETUP_ERROR) throw new Error(process.env.MARU_NATIVE_E2E_SETUP_ERROR);
}

/** WDIO resolves rejected beforeSession hooks as Error values. Preserve the
 * failure until a real Mocha hook reports it, including during reloadSession. */
export async function nativeWorkerBoundary(action: () => Promise<void>): Promise<void> {
  try { assertNoWorkerFailure(); await action(); }
  catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!process.env.MARU_NATIVE_E2E_SETUP_ERROR) process.env.MARU_NATIVE_E2E_SETUP_ERROR = failure.message || "native worker setup failed";
    throw failure;
  }
}

export interface NativeFixtureProfileRequest {
  key: string;
  owner: string;
  fresh: boolean;
  ownedPaths: string[];
  deadline: number;
}
export interface NativeFixtureProfileResult {
  ok: boolean;
  reason: string;
  previous: string | null;
  diagnostics: { menuReady: boolean; activityRail: boolean; state: NativeAppState | null; ownedPaths: string[] };
}

/** Self-contained callback used by WebDriver and hermetic readiness tests.
 * Retained verification is marker-only; it never reads startup state. */
export function pollNativeFixtureProfile(request: NativeFixtureProfileRequest, done: (result: NativeFixtureProfileResult) => void): void {
  const tick = () => {
    const namespace = window.__MARU_NATIVE_E2E__;
    const menuReady = namespace?.menuCommandReady?.() === true;
    const activityRail = Boolean(document.querySelector(".activity-rail"));
    let state: NativeAppState | null = null;
    if (request.fresh && typeof namespace?.readAppState === "function") {
      try { state = namespace.readAppState(); }
      catch {
        done({ ok: false, reason: "app state reader failed", previous: null,
          diagnostics: { menuReady, activityRail, state: null, ownedPaths: request.ownedPaths } });
        return;
      }
    }
    const owned = (value: string | null) => typeof value === "string" && request.ownedPaths.includes(value);
    const sanitized = state ? {
      booting: state.booting, settingsLoaded: state.settingsLoaded, settingsWritable: state.settingsWritable,
      workspacePath: owned(state.workspacePath) ? state.workspacePath : state.workspacePath === null ? null : "outside-fixture",
      settingsWorkPath: owned(state.settingsWorkPath) ? state.settingsWorkPath : state.settingsWorkPath === null ? null : "outside-fixture",
      terminalWorkspacePath: owned(state.terminalWorkspacePath) ? state.terminalWorkspacePath : state.terminalWorkspacePath === null ? null : "outside-fixture",
      catalogReady: state.catalogReady, catalogLoading: state.catalogLoading, catalogHasFixtureDocument: state.catalogHasFixtureDocument,
      appMode: state.appMode, terminalOpen: state.terminalOpen, terminalSplitOpen: state.terminalSplitOpen,
    } : null;
    const diagnostics = { menuReady, activityRail, state: sanitized, ownedPaths: request.ownedPaths };
    const fixtureReady = !request.fresh || Boolean(state && state.booting === false
      && state.settingsLoaded === true && state.settingsWritable === true
      && owned(state.workspacePath) && owned(state.settingsWorkPath) && owned(state.terminalWorkspacePath)
      && state.catalogReady === true && state.catalogLoading === false && state.catalogHasFixtureDocument === true);
    if (menuReady && activityRail && Date.now() <= request.deadline) {
      try {
        const previous = window.localStorage.getItem(request.key);
        if (request.fresh ? previous !== null : previous !== request.owner) {
          done({ ok: false, reason: request.fresh ? "profile marker leaked from another spec" : "profile marker did not survive same-spec reload",
            previous: previous === request.owner ? previous : previous === null ? null : "outside-fixture-owner", diagnostics });
          return;
        }
        if (fixtureReady) {
          if (request.fresh) window.localStorage.setItem(request.key, request.owner);
          done({ ok: window.localStorage.getItem(request.key) === request.owner, reason: "profile marker readback", previous, diagnostics });
          return;
        }
      } catch {
        done({ ok: false, reason: "profile marker storage failed", previous: null, diagnostics });
        return;
      }
    }
    if (Date.now() >= request.deadline) {
      done({ ok: false, reason: request.fresh ? "fixture startup/profile readiness timed out" : "main bridge/document readiness timed out", previous: null, diagnostics });
      return;
    }
    setTimeout(tick, 100);
  };
  tick();
}

/** Fresh verification proves startup and all workspace owners in the same
 * original 20s deadline as profile ownership. No storage is cleared. */
export async function verifyNativeProfileIsolation(expectation: "fresh" | "retained" = "fresh"): Promise<void> {
  const deadline = Date.now() + 20_000;
  const owner = process.env.MARU_NATIVE_E2E_CONFIG_DIR;
  if (!owner || !process.env.MARU_NATIVE_E2E_HOME) throw new Error("native fixture isolation is missing");
  const ownedPaths: string[] = [];
  if (expectation === "fresh") {
    const root = fixtureRootDir();
    const raw = path.join(root, "workspace");
    const [real, realRoot] = await Promise.all([fs.realpath(raw), fs.realpath(root)]);
    if (real !== path.join(realRoot, "workspace")) throw new Error("native fixture workspace resolves outside its owned root");
    ownedPaths.push(...new Set([raw, real]));
  }
  const result = await browser.executeAsync(pollNativeFixtureProfile, {
    key: NATIVE_PROFILE_MARKER_KEY, owner, fresh: expectation === "fresh", ownedPaths, deadline,
  }) as NativeFixtureProfileResult;
  if (!result.ok) throw new Error(`native profile isolation failed: ${JSON.stringify(result)}`);
}

export function createNativeRootHooks(restore: () => Promise<void>, verifyProfile: () => Promise<void> = async () => {}) {
  return {
    async beforeAll() {
      assertNoWorkerFailure();
      if (!process.env.MARU_NATIVE_E2E_HOME || !process.env.MARU_NATIVE_E2E_CONFIG_DIR) throw new Error("native fixture isolation is missing");
      await verifyProfile();
    },
    async beforeEach() { assertNoWorkerFailure(); await restore(); },
    async afterEach() { assertNoWorkerFailure(); },
  };
}

export const mochaHooks = createNativeRootHooks(resetFixtureWorkspace, verifyNativeProfileIsolation);
