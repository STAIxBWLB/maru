// Written from scratch, not derived from playwright.config.ts (RESEARCH
// Pitfall 7 / plan action text): that config's `trace: "retain-on-failure"`
// block assumes headless, chrome-free, prompt-free conditions that do not
// hold for a real signed/unsigned macOS .app, and its retry story does not
// port either. e2e-native's own retry and cleanup policy is stated here,
// as literal values with reasons, not left at whatever the library defaults
// to.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cleanupFixtureWorkspace, createNativeFixtureLifecycle, seedFixtureWorkspace } from "./helpers/fixtureWorkspace";
import { nativeWorkerBoundary } from "./rootHooks";

const APP_BINARY = "./src-tauri/target/debug/maru";

export interface FixtureAppIdentity { pid: number; parent: number; cwd: string; started: string }

/** A matching argv is insufficient: only this launcher's child in this
 * checkout can be selected. Never choose the last of several candidates. */
export function selectOwnedFixtureApp(candidates: FixtureAppIdentity[], launcher: number, cwd: string): FixtureAppIdentity | undefined {
  const owned = candidates.filter((candidate) => candidate.parent === launcher && candidate.cwd === cwd);
  if (owned.length > 1) throw new Error("ambiguous native fixture app ownership");
  return owned[0];
}

function readAppIdentity(pid: number): FixtureAppIdentity {
  const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  if (command !== APP_BINARY) throw new Error(`native fixture argv changed for PID ${pid}`);
  const parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const cwdLines = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).split("\n").filter((line) => line.startsWith("n"));
  if (!Number.isInteger(parent) || parent <= 0 || !started || cwdLines.length !== 1) throw new Error(`missing native ownership telemetry for PID ${pid}`);
  return { pid, parent, started, cwd: realpathSync(cwdLines[0].slice(1)) };
}

function findOwnedFixtureApp(launcher: number): FixtureAppIdentity | undefined {
  const escaped = APP_BINARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pids: string[];
  try {
    pids = execFileSync("pgrep", ["-f", `^${escaped}$`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return undefined;
    throw error;
  }
  const candidates = pids.flatMap((pid) => {
    try { return [readAppIdentity(Number(pid))]; }
    catch (error) {
      if (!stillAlive(Number(pid))) return [];
      throw error;
    }
  });
  return selectOwnedFixtureApp(candidates, launcher, realpathSync(process.cwd()));
}

function stillAlive(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  // A zombie has exited and cannot write into the owned fixture anymore.
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch (error) {
    try { process.kill(pid, 0); }
    catch (gone) { if ((gone as NodeJS.ErrnoException).code === "ESRCH") return false; }
    throw error;
  }
}

async function stopOwnedApp(): Promise<void> {
  const owned = findOwnedFixtureApp(process.pid);
  if (!owned) return;
  const checkIdentity = () => {
    const actual = readAppIdentity(owned.pid);
    if (actual.parent !== owned.parent || actual.cwd !== owned.cwd || actual.started !== owned.started) throw new Error("native fixture process identity changed; refusing signal");
  };
  if (!stillAlive(owned.pid)) return;
  checkIdentity();
  try { process.kill(owned.pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const gracefulDeadline = Date.now() + 2_000;
  while (stillAlive(owned.pid) && Date.now() < gracefulDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (stillAlive(owned.pid)) { checkIdentity(); process.kill(owned.pid, "SIGKILL"); }
  const deadline = Date.now() + 3_000;
  while (stillAlive(owned.pid)) {
    if (Date.now() > deadline) throw new Error("owned native app did not exit; preserving its fixture");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function activateAppWindow(): boolean {
  const launcher = Number(process.env.MARU_NATIVE_E2E_LAUNCHER_PID);
  if (!Number.isInteger(launcher) || launcher <= 0) throw new Error("native fixture launcher identity is missing");
  const owned = findOwnedFixtureApp(launcher);
  if (!owned) return false;
  try {
    execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${owned.pid}) to true`]);
    return true;
  } catch {
    // Accessibility activation is best-effort; ownership checks above are not.
    return false;
  }
}

const lifecycle = createNativeFixtureLifecycle({ seed: seedFixtureWorkspace, stopOwnedApp, cleanup: cleanupFixtureWorkspace });
const launcherFailures: Error[] = [];
async function launcherBoundary(action: () => Promise<void>): Promise<void> {
  try {
    if (launcherFailures.length) throw new Error("a prior native fixture lifecycle boundary failed");
    await action();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    launcherFailures.push(failure);
    process.env.MARU_NATIVE_E2E_SETUP_ERROR = failure.message;
    throw failure;
  }
}

export function createNativeCompletionHook(complete: () => Promise<void>, failures: Error[]) {
  return async () => {
    await complete();
    delete process.env.MARU_NATIVE_E2E_LAUNCHER_PID;
    delete process.env.MARU_NATIVE_E2E_SETUP_ERROR;
    if (failures.length) throw new AggregateError(failures, "native fixture lifecycle failed");
  };
}

export const config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  // One app instance at a time: two instances would contend for window
  // focus and for the single fixture root a spec file's session writes to.
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: APP_BINARY,
      },
    },
  ],
  services: ["@wdio/tauri-service"], // driverProvider defaults to "embedded"
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    require: [fileURLToPath(new URL("./rootHooks.ts", import.meta.url))],
    // 120s, not a lean default: withGlobalTauri is false, so the service's
    // per-command window-state helper times out (~5s, twice) around every
    // wdio element command — each click/waitForDisplayed costs ~10-15s, and
    // 06-01's webview.spec alone needs ~50-70s across runs. 60s was observed
    // flaking on it; 120s still bounds a genuinely hung test.
    timeout: 120_000,
  },
  reporters: ["spec"],
  logLevel: "info",
  // A cold macOS debug binary launch (webview init, IPC bootstrap) is
  // slower than Playwright's warm Chromium connect; 2 minutes is generous
  // enough for that without letting a genuinely hung app run indefinitely.
  connectionRetryTimeout: 120_000,
  // Exactly one retry: RESEARCH found no precedent for this embedded
  // provider on a hosted macOS runner at all, so a single retry absorbs a
  // one-off cold-start hiccup without masking a real, reproducible failure
  // behind repeated attempts (that classification is D-02's job, not this
  // config's).
  connectionRetryCount: 1,

  // Config launcher hooks run before tauri-service hooks. The first app is
  // seeded before service onPrepare; later apps are reseeded before the
  // service's onWorkerStart health check restarts its stopped embedded server.
  onPrepare: async () => {
    process.env.TOKIO_WORKER_THREADS = "2";
    process.env.MARU_NATIVE_E2E_LAUNCHER_PID = String(process.pid);
    delete process.env.MARU_NATIVE_E2E_SETUP_ERROR;
    await launcherBoundary(() => lifecycle.prepare());
  },
  onWorkerStart: async (id: string) => {
    await launcherBoundary(() => lifecycle.start(id));
  },
  beforeSession: async () => {
    await nativeWorkerBoundary(async () => {
      for (let attempt = 0; attempt < 15; attempt++) {
        if (activateAppWindow()) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });
  },
  // No worker teardown/reset deletes state while its app is still running.
  // reloadSession within a spec intentionally retains the same disk fixture.
  onWorkerEnd: async (id: string) => {
    await launcherBoundary(() => lifecycle.end(id));
  },
  // Actual WDIO onComplete collects hook rejection as exit 1, unlike its
  // beforeTest hook. Keep sticky launcher failures inside this final gate.
  onComplete: createNativeCompletionHook(() => lifecycle.complete(), launcherFailures),
};
