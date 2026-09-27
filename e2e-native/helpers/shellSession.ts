// Shared shell-launch flow for the terminal-facing native specs (pty.spec.ts
// and ime.spec.ts; ime previously kept a verbatim copy of pty's flow, so the
// two now import the same helper instead of drifting).
//
// The ordering below is the #388 fix. Opening the panel auto-launches one
// shell (settings.terminal.autoLaunch defaults to "shell"), and the spec then
// launches a second shell through the Shell launcher — two mounts racing.
// NativeTerminalView focuses its textarea when its instance becomes active
// (TerminalPanel's post-spawn rAF), so the later mount steals DOM focus
// mid-typing: keystrokes and Enter land on the wrong PTY, and the polled
// session's screen never shows the typed command or its output. Waiting for
// the auto-launched session to mount BEFORE the launcher click means the
// post-click poll can only match the launcher's own session — which is also
// the app's focused terminal, so the app's focus-restore paths work for the
// spec instead of against it.
import assert from "node:assert/strict";
import type {} from "webdriverio";

import { readTerminalText } from "./ptyAssertions";

/** In-page poll deadline; the embedded driver's default script timeout is
 *  30s, so every executeAsync loop below must resolve before that. */
const POLL_TIMEOUT_MS = 20_000;

/** Opens the tool panel's terminal surface, lets the auto-launched shell
 *  mount, then launches a real shell through the Shell launcher and returns
 *  the launcher-created session's id, with its textarea verified focused. */
export async function openShellSession(): Promise<string> {
  const beforeIds = (await browser.execute(() =>
    Array.from(document.querySelectorAll(".native-terminal-view[data-session-id]")).map((el) =>
      el.getAttribute("data-session-id"),
    ),
  )) as Array<string | null>;

  // Wait for the shell chrome, then open the tool panel's terminal surface.
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

  // The auto-launched shell first (#388): it must be mounted and recorded
  // before the launcher click, or the post-click poll can latch it and the
  // launcher shell's later mount steals focus mid-typing.
  const autoLaunchedId = await browser.executeAsync(
    (
      priorIds: Array<string | null>,
      timeout: number,
      done: (id: string | null) => void,
    ) => {
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
  assert.ok(
    autoLaunchedId,
    "the panel's auto-launched shell never mounted a native terminal view",
  );
  const settledIds = [...beforeIds, autoLaunchedId];

  // The shell launcher specifically, not the literal first enabled button:
  // the AI-CLI launchers ahead of it spawn an interactive TUI where the CLI
  // is installed (and fail to spawn where it is not), and only a real shell
  // makes the screen-echo assertions in the calling specs meaningful.
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

  // Wait for the launcher-created session's active view. Deliberately only
  // the view: the bridge namespace installs lazily on first registration, so
  // a missing namespace means nothing until a terminal is on screen.
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
    settledIds,
    POLL_TIMEOUT_MS,
  );
  assert.ok(sessionId, "launching a shell never mounted a new active native terminal view");

  // Bridge gate, evaluated now that a terminal is on screen: readTerminalText
  // throws naming `pnpm build:frontend:native-e2e` when the app serves a
  // frontend built without the runner flag, which deserves its own message
  // rather than a downstream null.
  await readTerminalText(sessionId);

  // Wait for the text mirror to serve non-empty text, so the shell has
  // painted its prompt before the caller types into it.
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

  // Focus is verified, not assumed: WebDriver key input goes to the focused
  // element, and re-focusing each tick absorbs a late focus steal while the
  // launch settles.
  const focused = await browser.executeAsync(
    (id: string, timeout: number, done: (ready: boolean) => void) => {
      const selector = `.native-terminal-view[data-session-id="${id}"] .native-terminal-input`;
      const deadline = Date.now() + timeout;
      const tick = () => {
        const textarea = document.querySelector<HTMLTextAreaElement>(selector);
        if (textarea && document.activeElement === textarea) {
          done(true);
          return;
        }
        if (Date.now() > deadline) {
          done(false);
          return;
        }
        textarea?.focus();
        setTimeout(tick, 250);
      };
      tick();
    },
    sessionId,
    POLL_TIMEOUT_MS,
  );
  assert.ok(focused, "the new terminal's textarea never took DOM focus");
  return sessionId;
}
