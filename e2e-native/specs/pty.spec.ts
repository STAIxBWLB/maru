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

import {
  assertTerminalInk,
  readTerminalText,
  type NativeE2eChannelEvalSample,
} from "../helpers/ptyAssertions";
import { openShellSession } from "../helpers/shellSession";

/** In-page poll deadline; the embedded driver's default script timeout is
 *  30s, so every executeAsync loop below must resolve before that. */
const POLL_TIMEOUT_MS = 20_000;

interface ChannelEvalProbe {
  bridgePresent: boolean;
  readerPresent: boolean;
  samples: NativeE2eChannelEvalSample[];
}

async function waitForFullFrameChannelEvals(sessionId: string): Promise<NativeE2eChannelEvalSample[]> {
  const probe = await browser.executeAsync(
    (id: string, timeout: number, done: (result: ChannelEvalProbe) => void) => {
      const deadline = Date.now() + timeout;
      const tick = () => {
        const bridge = window.__MARU_NATIVE_E2E__;
        const readerPresent = typeof bridge?.channelEvals === "function";
        const samples = readerPresent && bridge
          ? bridge.channelEvals().filter((sample) => sample.sessionId === id)
          : [];
        const qualifying = samples.filter((sample) =>
          sample.fullFrame && sample.bytes > 8192 && Number.isFinite(sample.durationMs)
          && sample.durationMs >= 0 && Number.isInteger(sample.cols) && sample.cols > 0
          && Number.isInteger(sample.rows) && sample.rows > 0,
        );
        if (!bridge || !readerPresent || qualifying.length > 0 || Date.now() >= deadline) {
          done({ bridgePresent: Boolean(bridge), readerPresent, samples });
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    },
    sessionId,
    POLL_TIMEOUT_MS,
  ) as ChannelEvalProbe;

  assert.ok(
    probe.bridgePresent,
    "native channel-evaluation bridge is absent; the app is serving a frontend built without the runner flag",
  );
  assert.ok(probe.readerPresent, "native channel-evaluation reader is missing from the bridge namespace");
  const fullFrames = probe.samples.filter((sample) =>
    sample.fullFrame && sample.bytes > 8192 && Number.isFinite(sample.durationMs)
    && sample.durationMs >= 0 && Number.isInteger(sample.cols) && sample.cols > 0
    && Number.isInteger(sample.rows) && sample.rows > 0,
  );
  assert.ok(
    fullFrames.length > 0,
    `no large full-screen channel frame was recorded for PTY session ${sessionId}: ${JSON.stringify(probe.samples)}`,
  );
  return fullFrames;
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

describe("native terminal PTY", () => {
  it(
    "runs a real command in a real shell and proves both its text and its paint",
    async () => {
      const sessionId = await openShellSession();
      const viewSelector = `.native-terminal-view[data-session-id="${sessionId}"]`;

      const fullFrames = await waitForFullFrameChannelEvals(sessionId);
      const frameDurationsMs = fullFrames.map((sample) => sample.durationMs).sort((a, b) => a - b);
      const latestFullFrame = fullFrames[fullFrames.length - 1]!;
      console.info("native_terminal_full_frame_channel_eval", JSON.stringify({
        measurement: "JavaScript JSON parse + bound channel callback",
        excludes: "Rust frame preparation, IPC transport, generated-script compilation, and asynchronous paint",
        sessionId: latestFullFrame.sessionId,
        sampleCount: fullFrames.length,
        bytes: latestFullFrame.bytes,
        cols: latestFullFrame.cols,
        rows: latestFullFrame.rows,
        fullFrame: latestFullFrame.fullFrame,
        minMs: frameDurationsMs[0],
        medianMs: median(frameDurationsMs),
        p95Ms: percentile(frameDurationsMs, 0.95),
      }));

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
