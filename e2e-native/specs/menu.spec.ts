// D-13 surface 4: the macOS menu bar. The menu lives outside the webview and
// WebDriver cannot reach it — driving it needs an Accessibility grant no
// unattended runner can give itself (06-PATTERNS.md "No Analog Found"). What
// this spec CAN and DOES prove: the app's menu-command handling runs
// correctly in the real WKWebView against the real backend, for the actual
// command ids the native menu emits (src-tauri/src/app_menu.rs), dispatched
// through window.__MARU_NATIVE_E2E__.menuCommand into the same runMenuCommand
// the Tauri menu listener calls (src/App.tsx). What it does NOT prove: that
// clicking the macOS menu bar, or pressing a key equivalent the menu owns,
// actually delivers that id. That half is human-attended; the checklist lives
// in docs/native-e2e.md "## macOS menu bar".
//
// Command-economy note (same constraint as pty.spec.ts): wdio element
// commands cost ~10-15s each under the embedded provider, so dispatches and
// polls run in-page, one WebDriver command per wait.
import assert from "node:assert/strict";
import type {} from "webdriverio";

import { FIXTURE_DOC_NAME } from "../helpers/fixtureWorkspace";

/** In-page poll deadline; the embedded driver's default script timeout is
 *  30s, so every executeAsync loop below must resolve before that. */
const POLL_TIMEOUT_MS = 20_000;

/** Dispatches a menu command id through the debug bridge, after waiting for
 *  the bridge's menuCommand member to register (App.tsx's effect installs it
 *  at mount). */
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
    POLL_TIMEOUT_MS,
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

describe("native macOS menu command path", () => {
  it(
    "view.documents switches the active mode surface to the document list",
    async () => {
      // A fresh profile lands on the Today view, so the document list does
      // not exist until the documents (pkm) mode opens (webview.spec.ts
      // relies on the same fact).
      await dispatchMenuCommand("view.documents");

      const listReady = await browser.executeAsync(
        (docName: string, timeout: number, done: (ready: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const list = document.querySelector(".document-list");
            if (list && list.textContent?.includes(docName)) {
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
        FIXTURE_DOC_NAME,
        POLL_TIMEOUT_MS,
      );
      assert.ok(
        listReady,
        `menuCommand("view.documents") never opened the document list showing "${FIXTURE_DOC_NAME}"`,
      );
    },
  ).timeout(120_000);

  it(
    "terminal.shell then terminal.split produces a second terminal pane",
    async () => {
      await dispatchMenuCommand("terminal.shell");

      // The menu command opens the tool panel's terminal surface and launches
      // a shell; wait for its view before splitting.
      const firstSession = await browser.executeAsync(
        (timeout: number, done: (id: string | null) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const active = document.querySelector(
              ".terminal-instance.active .native-terminal-view[data-session-id]",
            );
            const id = active?.getAttribute("data-session-id") ?? null;
            if (id) {
              done(id);
              return;
            }
            if (Date.now() > deadline) {
              done(null);
              return;
            }
            setTimeout(tick, 250);
          };
          tick();
        },
        POLL_TIMEOUT_MS,
      );
      assert.ok(
        firstSession,
        'menuCommand("terminal.shell") never mounted a native terminal view',
      );

      await dispatchMenuCommand("terminal.split");

      // Split launches a second session into the right pane
      // (TerminalPanel's splitOpen effect), so the DOM consequence is a
      // split body with both panes active and two distinct session ids.
      const splitState = await browser.executeAsync(
        (leftId: string, timeout: number, done: (state: unknown) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const body = document.querySelector(".terminal-body.split");
            const rightView = document.querySelector(
              ".terminal-instance.pane-right.active .native-terminal-view[data-session-id]",
            );
            const rightId = rightView?.getAttribute("data-session-id") ?? null;
            if (body && rightId) {
              done({ split: true, rightId, distinct: rightId !== leftId });
              return;
            }
            if (Date.now() > deadline) {
              done({ split: Boolean(body), rightId, distinct: false });
              return;
            }
            setTimeout(tick, 250);
          };
          tick();
        },
        firstSession,
        POLL_TIMEOUT_MS,
      );
      const state = splitState as { split: boolean; rightId: string | null; distinct: boolean };
      assert.ok(
        state.split,
        'menuCommand("terminal.split") never switched the terminal body to split mode',
      );
      assert.ok(
        state.rightId,
        'menuCommand("terminal.split") never mounted a right-pane terminal view',
      );
      assert.ok(
        state.distinct,
        "the split's right pane shows the same session as the left — no second terminal was launched",
      );
    },
  ).timeout(120_000);
});
