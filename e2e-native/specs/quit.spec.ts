// Plan 09-08, D-03 ("one quit path"): app.quit and window.close share the
// same requestWindowClose() -> onCloseRequested guard proven by
// menu.spec.ts's "native macOS quit route" describe. That spec only proves
// the DIRTY-draft branch (the confirm dialog appears, Cancel keeps the app
// open). It never proves the CLEAN branch actually exits: a fixed reviewer
// build with no dirty draft and no pending autosave never closed at all
// (owner-observed regression, checkpoint items 2/5/6/8) because
// getCurrentWindow().close() -> onCloseRequested's replay -> destroy() was
// silently denied by ACL (core:window:allow-destroy was never granted; see
// src-tauri/capabilities/default.json). Only a real process-exit check can
// catch "nothing crashed, no dialog, the window/app just never closes" —
// jsdom/vitest and the chromium Playwright suite can only observe the
// webview's own state, not whether the surrounding Tauri window and OS
// process actually went away.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type {} from "webdriverio";

/** Same relative path and escaped-anchor pgrep pattern as
 *  e2e-native/wdio.conf.ts's killSurvivingAppProcesses/activateAppWindow:
 *  duplicated here (each spec file is an independent mocha module, matching
 *  pty.spec.ts's convention) rather than importing from the config file. */
const APP_BINARY = "./src-tauri/target/debug/maru";

function findAppPid(): string | null {
  const escaped = APP_BINARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const pids = execFileSync("pgrep", ["-f", `^${escaped}$`], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return pids[pids.length - 1] ?? null;
  } catch {
    // pgrep exits non-zero when it finds nothing.
    return null;
  }
}

function isPidAlive(pid: string): boolean {
  try {
    // Signal 0 checks existence/permission without actually signaling.
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !isPidAlive(pid);
}

/** Dispatches a menu command id through the debug bridge — same helper as
 *  menu.spec.ts, duplicated for the same reason. */
async function dispatchMenuCommand(id: string): Promise<void> {
  const bridgeReady = await browser.executeAsync(
    (timeout: number, done: (ready: boolean) => void) => {
      const deadline = Date.now() + timeout;
      const tick = () => {
        if (window.__MARU_NATIVE_E2E__?.menuCommand) {
          done(true);
          return;
        }
        if (Date.now() > deadline) {
          done(false);
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    },
    20_000,
  );
  assert.ok(
    bridgeReady,
    "window.__MARU_NATIVE_E2E__.menuCommand never registered — the app is " +
      "serving a frontend built without the runner flag, or App.tsx's " +
      "dispatcher registration effect did not run",
  );
  await browser.execute((commandId: string) => {
    window.__MARU_NATIVE_E2E__?.menuCommand(commandId);
  }, id);
}

describe("native clean quit actually exits the app (09-08, D-03 one quit path)", () => {
  it(
    "app.quit with no dirty draft and no pending save exits the process",
    async () => {
      // Fresh fixture profile (fixtureWorkspace.ts): zero dirty drafts, zero
      // mounted-and-pending autosave surfaces. This is the minimal
      // reproduction of the clean-quit branch onCloseRequested runs after a
      // successful (trivially "clean", nothing registered) flush.
      const activityRail = await browser.$(".activity-rail");
      await activityRail.waitForDisplayed({ timeout: 30_000 });

      const pid = findAppPid();
      assert.ok(pid, "could not find the running app's PID via pgrep before quitting");

      await dispatchMenuCommand("app.quit");

      // D-04's 3s flush budget plus the close-requested/destroy IPC round
      // trip; generous margin over both.
      const exited = await waitForPidExit(pid, 8_000);
      assert.ok(
        exited,
        `app.quit on a clean state (no dirty draft, no pending save) never exited the app ` +
          `process (pid ${pid} still alive after 8s) — the quit flush completed but the ` +
          `window/app never actually closed`,
      );
    },
  ).timeout(60_000);
});
