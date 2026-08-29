// Written from scratch, not derived from playwright.config.ts (RESEARCH
// Pitfall 7 / plan action text): that config's `trace: "retain-on-failure"`
// block assumes headless, chrome-free, prompt-free conditions that do not
// hold for a real signed/unsigned macOS .app, and its retry story does not
// port either. e2e-native's own retry and cleanup policy is stated here,
// as literal values with reasons, not left at whatever the library defaults
// to.
import { execFileSync } from "node:child_process";

import { cleanupFixtureWorkspace, resetFixtureWorkspace, seedFixtureWorkspace } from "./helpers/fixtureWorkspace";

// app.withGlobalTauri is false (src-tauri/tauri.conf.json), so no spec may
// call invoke() via executeScript - everything a spec observes must come
// from the DOM or a global the app itself exposes. Every spec in this tree
// is bound by that constraint, not just this file.
const APP_BINARY = "./src-tauri/target/debug/maru";

/**
 * Backstop for the "no live app or PTY child left behind" truth: the
 * embedded provider owns the app process it spawns for the lifetime of a
 * session, but a session that never establishes (D-01's own stop
 * condition) never reaches a normal teardown. `onComplete` always runs,
 * on both the pass and the fail path, so a leftover process matching the
 * exact debug binary this run launched is force-killed here regardless of
 * how the session ended.
 */
function killSurvivingAppProcesses(): void {
  // pgrep -f treats the pattern as an unanchored ERE: the literal dots in
  // APP_BINARY are regex wildcards, so the bare pattern matches ANY command
  // line containing "<any char>/src-tauri/target/debug/maru" — including a
  // developer's own `tauri dev` or debug instance launched by absolute path
  // from this or any other checkout, which this backstop would then SIGKILL.
  // Escape every metacharacter and anchor the match to the exact relative
  // argv the tauri-service spawns, so teardown can only reach a process
  // started the same way this run starts its app.
  const escaped = APP_BINARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const pids = execFileSync("pgrep", ["-f", `^${escaped}$`], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already exited between pgrep and kill - nothing left to clean up.
      }
    }
  } catch {
    // pgrep exits non-zero when it finds nothing; that is the common case.
  }
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

  // Seeding happens in onPrepare, not beforeSession: beforeSession runs in
  // the worker process (@wdio/runner), but the tauri-service spawns the app
  // in the launcher's service onPrepare. @wdio/cli runs the config's own
  // onPrepare first, so env vars set here are in the launcher process.env
  // before the app spawn - and startEmbeddedDriver spreads process.env into
  // the app. Seeding in beforeSession left the app pointed at the real
  // ~/.maru (the 06-01 fixture-isolation bug).
  onPrepare: async () => {
    await seedFixtureWorkspace();
  },
  beforeTest: async () => {
    await resetFixtureWorkspace();
  },
  afterSession: async () => {
    // Kill only. Do NOT clean the fixture root here: afterSession runs per
    // worker, i.e. per spec file, but the app for the NEXT spec file is
    // spawned by the launcher pointed at the same fixture root — a cleanup
    // here deletes that root from under it, and the next app boots into an
    // empty registry and first-run-seeds its Sample Workspace instead
    // (observed: webview.spec failing with the sample workspace on screen
    // whenever it ran after another spec). The root is per-RUN state (D-09);
    // onComplete, which runs once per run on both the pass and the fail
    // path, owns its cleanup.
    killSurvivingAppProcesses();
  },
  onComplete: async () => {
    await cleanupFixtureWorkspace();
    killSurvivingAppProcesses();
  },
};
