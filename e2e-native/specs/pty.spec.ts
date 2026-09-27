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
//
// The shell session comes from helpers/shellSession.ts: its launch ordering
// (auto-launched shell settled before the launcher click) is the #388 fix,
// and ime.spec.ts shares the same helper so the two flows cannot drift.
import assert from "node:assert/strict";
import type {} from "webdriverio";

import { assertTerminalInk, readTerminalText } from "../helpers/ptyAssertions";
import { openShellSession } from "../helpers/shellSession";

/** In-page poll deadline; the embedded driver's default script timeout is
 *  30s, so every executeAsync loop below must resolve before that. */
const POLL_TIMEOUT_MS = 20_000;

describe("native terminal PTY", () => {
  it(
    "runs a real command in a real shell and proves both its text and its paint",
    async () => {
      const sessionId = await openShellSession();
      const viewSelector = `.native-terminal-view[data-session-id="${sessionId}"]`;

      // The marker split is the point of the whole spec: the typed line is
      // `echo MARU""_PTY_OK_7F3A2B`, but the shell evaluates the empty quoted
      // pair away and prints `MARU_PTY_OK_7F3A2B`. A terminal that echoed
      // input without ever spawning a child shows only the typed characters
      // — the marker below never appears — so a green result means a child
      // process ran (T-06-07). Do not "simplify" this back to a plain echo.
      const MARKER = "MARU_PTY_OK_7F3A2B";
      const COMMAND = 'echo MARU""_PTY_OK_7F3A2B';
      await browser.keys(COMMAND);

      // Prove the keystrokes landed on this session's PTY before committing
      // the line: the marker poll alone cannot distinguish "the command
      // never ran" from "the marker printed but the screen read missed it"
      // (#388's diagnosis question), and only the typed line contains the
      // empty quoted pair.
      const typedSeen = await browser.executeAsync(
        (id: string, command: string, timeout: number, done: (hit: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const text = window.__MARU_NATIVE_E2E__?.terminalText(id);
            if (text && text.includes(command)) {
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
        COMMAND,
        POLL_TIMEOUT_MS,
      );
      assert.ok(
        typedSeen,
        "the typed command never landed on the terminal screen — the keystrokes went to another surface",
      );
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
