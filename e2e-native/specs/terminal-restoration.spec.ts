import assert from "node:assert/strict";
import type {} from "webdriverio";

import { openShellSession, waitForShellSplitReady } from "../helpers/shellSession";
import { verifyNativeProfileIsolation } from "../rootHooks";

const POLL_TIMEOUT_MS = 20_000;

/** Working shell tabs a persisted profile records, or 0 when it records none. */
function persistedSessions(profile: string | null): number {
  try {
    const parsed = JSON.parse(profile ?? "null") as { sessions?: unknown } | null;
    return Array.isArray(parsed?.sessions) ? parsed!.sessions!.length : 0;
  } catch {
    return 0;
  }
}

/** The panel writes `maru:terminal:v1` on a 400 ms debounce after the terminal
 *  state changes (`TerminalPanel.tsx`), so the entry a change adds lands well
 *  after the PTYs it belongs to are ready. Read the moment the split is ready,
 *  the store still holds the profile the panel had reported when it mounted —
 *  that is what the hosted run on 11-13 captured (saved
 *  `{"version":1,"tasks":[],"sessions":[]}` against a restart that restored three
 *  shell sessions). Wait for a profile that records at least `minSessions`
 *  entries and has stopped changing across that debounce, instead of pinning a
 *  count: the restored split plus the auto-launched pane does not always persist
 *  the same number of tabs.
 *
 *  A timeout is a failure, not a value. Returning the stale profile would let
 *  the restart below compare that profile with itself and pass with the split
 *  never persisted (reproduced: 20 s with two sessions requested and zero
 *  recorded still passed). The failure names counts and flags only - never
 *  titles, paths or terminal contents. */
type PersistedProfile =
  | { ready: true; profile: string; sessions: number }
  | { ready: false; sessions: number; present: boolean; parseable: boolean; stable: boolean; waitedMs: number };

async function waitForPersistedProfile(minSessions: number): Promise<string> {
  const settled = 500;
  const result: PersistedProfile | undefined = await browser.executeAsync(
    (
      wanted: number,
      settle: number,
      timeout: number,
      done: (value?: PersistedProfile) => void,
    ) => {
      const key = "maru:terminal:v1";
      // TerminalPanel's persist effect restarts this window on every state change.
      const startedAt = Date.now();
      const deadline = startedAt + timeout;
      const describe = (raw: string | null) => {
        if (raw === null) return { present: false, parseable: false, sessions: 0 };
        try {
          const parsed = JSON.parse(raw) as { sessions?: unknown } | null;
          return {
            present: true,
            parseable: true,
            sessions: Array.isArray(parsed?.sessions) ? parsed.sessions.length : 0,
          };
        } catch {
          return { present: true, parseable: false, sessions: 0 };
        }
      };
      let last = window.localStorage.getItem(key);
      let changedAt = Date.now();
      const tick = () => {
        const current = window.localStorage.getItem(key);
        const now = Date.now();
        if (current !== last) {
          last = current;
          changedAt = now;
        }
        const info = describe(last);
        const stable = now - changedAt >= settle;
        if (info.sessions >= wanted && stable) {
          done({ ready: true, profile: last ?? "", sessions: info.sessions });
          return;
        }
        if (now >= deadline) {
          done({
            ready: false,
            sessions: info.sessions,
            present: info.present,
            parseable: info.parseable,
            stable,
            waitedMs: now - startedAt,
          });
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    },
    minSessions,
    settled,
    POLL_TIMEOUT_MS,
  );
  if (!result) {
    assert.fail(`the terminal profile reader never answered within ${POLL_TIMEOUT_MS} ms`);
  }
  if (!result.ready) {
    assert.fail(
      `the terminal profile never recorded ${minSessions} shell sessions within ${POLL_TIMEOUT_MS} ms `
        + `(sessions=${result.sessions} present=${result.present} parseable=${result.parseable} `
        + `stable=${result.stable} waitedMs=${result.waitedMs})`,
    );
  }
  return result.profile;
}

describe("native restored terminal topology", () => {
  it("retains one spec profile across restart and binds the explicit shell after restored split autolaunch", async () => {
    await verifyNativeProfileIsolation("retained");
    const firstId = await openShellSession();
    // The split adds one entry to the profile, so the settled profile from before
    // it is the floor the split has to move past.
    const beforeSplit = persistedSessions(await waitForPersistedProfile(1));
    const splitDispatched = await browser.execute(() => window.__MARU_NATIVE_E2E__?.menuCommand("terminal.split"));
    assert.equal(splitDispatched, true, "the split command must be dispatched exactly once to the registered handler");
    const splitReady = await waitForShellSplitReady(firstId);
    assert.ok(splitReady, "both real split PTYs must be ready before restart");
    const saved = await waitForPersistedProfile(beforeSplit + 1);
    // The helper only returns a profile that reached this count and settled, so
    // this restates the floor the restart below is compared against.
    assert.ok(
      persistedSessions(saved) >= beforeSplit + 1,
      "the settled terminal profile lost the split's session before the restart",
    );
    await browser.reloadSession();
    await verifyNativeProfileIsolation("retained");
    const restored = await browser.execute(() => window.localStorage.getItem("maru:terminal:v1"));
    if (restored !== saved) {
      // Which side lost or gained an entry, without titles, paths or anything the
      // shell printed: the restored store is rewritten by the relaunched app, so
      // a diff here says whether the split's own tab survived the restart.
      const summary = (profile: string | null) => {
        try {
          const parsed = JSON.parse(profile ?? "null") as {
            tasks?: unknown[]; sessions?: Array<{ kind?: unknown; agentSessionId?: unknown }>;
          } | null;
          return {
            tasks: Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0,
            kinds: (parsed?.sessions ?? []).map((session) => String(session?.kind)),
            withAgentSession: (parsed?.sessions ?? []).filter(
              (session) => typeof session?.agentSessionId === "string",
            ).length,
          };
        } catch {
          return { error: "unparseable profile" };
        }
      };
      console.error("terminal_restoration_profile_diff", JSON.stringify({ saved: summary(saved), restored: summary(restored) }));
    }
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
