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
  try {
    const pids = execFileSync("pgrep", ["-f", APP_BINARY], { encoding: "utf8" })
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
    timeout: 60_000,
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
    await cleanupFixtureWorkspace();
    killSurvivingAppProcesses();
  },
  onComplete: async () => {
    await cleanupFixtureWorkspace();
    killSurvivingAppProcesses();
  },
};
