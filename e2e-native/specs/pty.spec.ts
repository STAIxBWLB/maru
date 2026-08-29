// D-13 surface 2 / ROADMAP criterion 2: one real PTY flow through the real
// app, asserted both ways from D-05 — exact text through the debug bridge,
// and ink on the canvas. Kept to this single flow on purpose (D-14 reserves
// suite breadth for the phases that need it; Phase 8's load test and Phase
// 9's SIGHUP test attach their own specs to the same two helpers).
//
// Command-economy note: withGlobalTauri is false, so the tauri-service's
// per-command window-state helper times out (~5s, twice) around every
// wdio element command — a single element click costs ~15s, while
// browser.execute returns in milliseconds. This spec therefore drives DOM
// setup with in-page clicks and does every wait as one executeAsync with
// the poll loop inlined (a probe passed as an argument cannot cross the
// WebDriver boundary — only the serialized top-level function and JSON
// args can). In-page deadlines stay below the driver's 30s default script
// timeout. Real key events (browser.keys) are used for the terminal input,
// which is the path under test.
import assert from "node:assert/strict";
import type {} from "webdriverio";

import { assertTerminalInk, readTerminalText } from "../helpers/ptyAssertions";

/** In-page poll deadline; the embedded driver's default script timeout is
 *  30s, so every executeAsync loop below must resolve before that. */
const POLL_TIMEOUT_MS = 20_000;

describe("native terminal PTY", () => {
  it(
    "runs a real command in a real shell and proves both its text and its paint",
    async () => {
      // Session ids that exist before we launch ours — a fresh profile
      // auto-launches one shell when the panel opens, so the view we want is
      // the one whose session id is new (and only the visible instance
      // carries .terminal-instance.active).
      const beforeIds = (await browser.execute(() =>
        Array.from(document.querySelectorAll(".native-terminal-view[data-session-id]")).map((el) =>
          el.getAttribute("data-session-id"),
        ),
      )) as Array<string | null>;

      // Wait for the shell chrome, open the tool panel's terminal surface,
      // then start a shell. The shell launcher specifically, not the literal
      // first enabled button: the AI-CLI launchers ahead of it spawn an
      // interactive TUI where the CLI is installed (and fail to spawn where
      // it is not), and only a real shell makes the marker assertion below
      // meaningful.
      const shellReady = await browser.executeAsync(
        (timeout: number, done: (ready: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            if (document.querySelector(".terminal-title")) {
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
      assert.ok(shellReady, ".terminal-title never rendered");
      await browser.execute(() => {
        document.querySelector<HTMLButtonElement>(".terminal-title")?.click();
      });

      const launcherReady = await browser.executeAsync(
        (timeout: number, done: (ready: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const button = document.querySelector<HTMLButtonElement>(
              '.terminal-launchers button[aria-label="Shell"]',
            );
            if (button && !button.disabled) {
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
      assert.ok(launcherReady, "the shell launcher never became enabled");
      await browser.execute(() => {
        document
          .querySelector<HTMLButtonElement>('.terminal-launchers button[aria-label="Shell"]')
          ?.click();
      });

      // Wait for the new session's active view. Deliberately only the view:
      // the bridge namespace installs lazily on first registration, so a
      // missing namespace means nothing until a terminal is on screen.
      const sessionId = await browser.executeAsync(
        (priorIds: Array<string | null>, timeout: number, done: (id: string | null) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const active = document.querySelector(
              ".terminal-instance.active .native-terminal-view[data-session-id]",
            );
            const id = active?.getAttribute("data-session-id") ?? null;
            if (id && !priorIds.includes(id)) {
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
        beforeIds,
        POLL_TIMEOUT_MS,
      );
      assert.ok(sessionId, "launching a shell never mounted a new active native terminal view");
      const viewSelector = `.native-terminal-view[data-session-id="${sessionId}"]`;

      // Bridge gate, evaluated now that a terminal is on screen: when the
      // app serves a frontend built by plain `pnpm build:frontend` this
      // throws, naming `pnpm build:frontend:native-e2e` — a missing bridge
      // means the wrong build is in dist/, and that mistake deserves its own
      // message rather than a downstream null. With the bridge present this
      // returns the current mirror (possibly an empty string before the
      // shell paints its prompt).
      await readTerminalText(sessionId);

      // Wait for the text mirror to serve non-empty text, so the shell has
      // painted its prompt before we type into it.
      const promptPainted = await browser.executeAsync(
        (id: string, timeout: number, done: (ready: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const text = window.__MARU_NATIVE_E2E__?.terminalText(id);
            if (text && text.trim().length > 0) {
              done(true);
              return;
            }
            if (Date.now() > deadline) {
              done(false);
              return;
            }
            setTimeout(tick, 250);
          };
          tick();
        },
        sessionId,
        POLL_TIMEOUT_MS,
      );
      assert.ok(promptPainted, "terminal text mirror stayed empty after the shell launched");

      await browser.execute((selector: string) => {
        document.querySelector<HTMLTextAreaElement>(selector)?.focus();
      }, `${viewSelector} .native-terminal-input`);

      // The marker split is the point of the whole spec: the typed line is
      // `echo MARU""_PTY_OK_7F3A2B`, but the shell evaluates the empty quoted
      // pair away and prints `MARU_PTY_OK_7F3A2B`. A terminal that echoed
      // input without ever spawning a child shows only the typed characters
      // — the marker below never appears — so a green result means a child
      // process ran (T-06-07). Do not "simplify" this back to a plain echo.
      const MARKER = "MARU_PTY_OK_7F3A2B";
      await browser.keys('echo MARU""_PTY_OK_7F3A2B');
      await browser.keys("Enter");

      const found = await browser.executeAsync(
        (id: string, marker: string, timeout: number, done: (hit: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const text = window.__MARU_NATIVE_E2E__?.terminalText(id);
            if (text && text.includes(marker)) {
              done(true);
              return;
            }
            if (Date.now() > deadline) {
              done(false);
              return;
            }
            setTimeout(tick, 250);
          };
          tick();
        },
        sessionId,
        MARKER,
        POLL_TIMEOUT_MS,
      );
      assert.ok(found, `terminal screen never showed the shell-printed marker ${MARKER}`);

      // readTerminalText is the helper sibling specs call; exercise it once
      // directly so its bridge-missing error path stays honest.
      const mirrored = await readTerminalText(sessionId);
      assert.ok(mirrored !== null && mirrored.includes(MARKER));

      // Text says *what* printed; ink says the canvas region *painted*.
      await assertTerminalInk(`${viewSelector} .native-terminal-canvas`);
    },
  ).timeout(120_000); // element commands cost ~10-15s each under the
  // embedded provider; the in-page waits above exist to keep this test far
  // under the ceiling, but the ceiling itself must clear the slow path.
});
