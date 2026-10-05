import assert from "node:assert/strict";
import type {} from "webdriverio";

import { openShellSession, waitForShellSplitReady } from "../helpers/shellSession";
import { verifyNativeProfileIsolation } from "../rootHooks";

const POLL_TIMEOUT_MS = 20_000;

describe("native restored terminal topology", () => {
  it("retains one spec profile across restart and binds the explicit shell after restored split autolaunch", async () => {
    await verifyNativeProfileIsolation("retained");
    const firstId = await openShellSession();
    const splitDispatched = await browser.execute(() => window.__MARU_NATIVE_E2E__?.menuCommand("terminal.split"));
    assert.equal(splitDispatched, true, "the split command must be dispatched exactly once to the registered handler");
    const splitReady = await waitForShellSplitReady(firstId);
    assert.ok(splitReady, "both real split PTYs must be ready before restart");
    const saved = await browser.execute(() => window.localStorage.getItem("maru:terminal:v1"));
    assert.ok(saved, "terminal metadata must be persisted for the restored-state regression");
    await browser.reloadSession();
    await verifyNativeProfileIsolation("retained");
    const restored = await browser.execute(() => window.localStorage.getItem("maru:terminal:v1"));
    assert.equal(restored, saved, "same-spec restart must preserve the actual terminal profile");
    const sessionId = await openShellSession();
    const focused = await browser.execute((id: string) => {
      const view = document.querySelector<HTMLElement>(`.terminal-instance.active.focused .native-terminal-view[data-session-id="${id}"]`);
      return Boolean(view && view.getClientRects().length && view.querySelector(".native-terminal-input") === document.activeElement);
    }, sessionId);
    assert.ok(focused, "the explicit restored-split shell must own the visible textarea");
    const command = 'echo MARU""_RESTORED_PTY_OK_388';
    await browser.keys(command);
    await browser.keys("Enter");
    const executed = await browser.executeAsync((id: string, timeout: number, done: (ready: boolean) => void) => {
      const end = Date.now() + timeout;
      const tick = () => {
        if (window.__MARU_NATIVE_E2E__?.terminalText(id)?.includes("MARU_RESTORED_PTY_OK_388")) { done(true); return; }
        if (Date.now() >= end) { done(false); return; }
        setTimeout(tick, 100);
      };
      tick();
    }, sessionId, POLL_TIMEOUT_MS);
    assert.ok(executed, "the restored-split shell must execute the command on the selected PTY");
  });
});
