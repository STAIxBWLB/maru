// Mocha hooks propagate setup failures to the spec. WDIO config.beforeTest
// catches/logs such errors and still runs the test, so do not put resets there.
import { resetFixtureWorkspace } from "./helpers/fixtureWorkspace";
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

/** Black-box readback of the isolated WKWebView store. Only this owned key
 * is used; never clear storage or reset another profile. */
export async function verifyNativeProfileIsolation(expectation: "fresh" | "retained" = "fresh"): Promise<void> {
  const owner = process.env.MARU_NATIVE_E2E_CONFIG_DIR;
  if (!owner || !process.env.MARU_NATIVE_E2E_HOME) throw new Error("native fixture isolation is missing");
  const result = await browser.executeAsync(
    (key: string, expectedOwner: string, fresh: boolean, done: (result: { ok: boolean; reason: string; previous?: string | null }) => void) => {
      const deadline = Date.now() + 20_000;
      const tick = () => {
        if (window.__MARU_NATIVE_E2E__?.menuCommand && document.querySelector(".activity-rail")) {
          try {
            const previous = window.localStorage.getItem(key);
            if (fresh ? previous !== null : previous !== expectedOwner) {
              done({ ok: false, reason: fresh ? "profile marker leaked from another spec" : "profile marker did not survive same-spec reload", previous });
              return;
            }
            if (fresh) window.localStorage.setItem(key, expectedOwner);
            done({ ok: window.localStorage.getItem(key) === expectedOwner, reason: "profile marker readback", previous });
          } catch (error) {
            done({ ok: false, reason: String(error) });
          }
          return;
        }
        if (Date.now() >= deadline) { done({ ok: false, reason: "main bridge/document readiness timed out" }); return; }
        setTimeout(tick, 100);
      };
      tick();
    },
    NATIVE_PROFILE_MARKER_KEY,
    owner,
    expectation === "fresh",
  );
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
