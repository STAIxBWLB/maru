// D-13 surface 3 / D-07 / ROADMAP criterion 4: the IME sub-spike. This spec
// judges, on evidence, what a synthetic event stream can and cannot do to the
// two surfaces that handle IME composition themselves — the terminal's hidden
// textarea (hand-written composition handling including the trailing-duplicate
// guard) and the rich editor (a ProseMirror-family surface that handles
// composition its own way). Each surface is driven by both mechanisms in a
// fixed order: first WebDriver key input (the raw jamo keystrokes for a
// two-syllable Hangul word), then an in-page synthetic composition sequence.
// The verdicts below were observed by running this spec on 2026-08-29 and are
// recorded in docs/native-e2e.md "## IME sub-spike"; the assertions here lock
// them in, so a future WebDriver-provider or WebKit change that alters what
// synthetic events can do turns this spec red instead of silently widening or
// narrowing coverage.
//
// Observed verdicts (macOS, WKWebView, embedded provider):
//
// - Terminal × WebDriver keys: the jamo arrive as LITERAL text through the
//   app's plain insertText path — no compositionstart/update/end ever fires,
//   so the composition handlers and the trailing-duplicate guard are never
//   engaged. The screen shows ㅎㅏㄴㄱㅡㄹ, never 한글.
// - Terminal × synthetic composition events: they DO drive the app's real
//   composition handlers. The composed word commits at compositionend and the
//   deliberately dispatched trailing insertText echo (WKWebView's known
//   duplicate, see COMPOSITION_TRAILING_MS in NativeTerminalView.tsx) is
//   dropped by isTrailingCompositionDuplicate — the word lands exactly once.
//   This half stays a live regression test (D-08).
// - Rich editor × WebDriver keys: no observable change at all — the document
//   text is unchanged after the keystrokes.
// - Rich editor × synthetic composition: events alone change nothing
//   (ProseMirror reads its DOM through a mutation observer, and synthetic
//   events mutate nothing); pairing the events with the DOM mutation a real
//   engine produces alongside them lands the composed word in the document.
//   This half stays a live regression test (D-08).
//
// What neither mechanism can do, on either surface: exercise the OS input
// method itself. A synthetic stream drives the app's handler code; the macOS
// IME that sits in front of it stays human-attended (D-08).
//
// Command-economy note (same constraint as pty.spec.ts): wdio element commands
// cost ~10-15s each under the embedded provider, so DOM setup uses in-page
// clicks and every wait is one executeAsync with the poll loop inlined. Real
// key events (browser.keys) are used for mechanism A — that is the path under
// test.
import assert from "node:assert/strict";
import type {} from "webdriverio";

import { readTerminalText } from "../helpers/ptyAssertions";

/** In-page poll deadline; the embedded driver's default script timeout is
 *  30s, so every executeAsync loop below must resolve before that. */
const POLL_TIMEOUT_MS = 20_000;

/** The two-syllable word both mechanisms attempt, and its raw jamo
 *  keystrokes. */
const WORD = "한글";
const JAMO = "ㅎㅏㄴㄱㅡㄹ";

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Opens the tool panel's terminal surface and launches a real shell — the
 *  same flow pty.spec.ts uses, kept verbatim so the two specs read the same
 *  way. Returns the new session's id. */
async function openShellSession(): Promise<string> {
  const beforeIds = (await browser.execute(() =>
    Array.from(document.querySelectorAll(".native-terminal-view[data-session-id]")).map((el) =>
      el.getAttribute("data-session-id"),
    ),
  )) as Array<string | null>;

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

  // The shell launcher specifically, for the same reason as pty.spec.ts: the
  // AI-CLI launchers ahead of it spawn interactive TUIs, and only a real
  // shell makes the screen-echo assertions below meaningful.
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

  // Wait for the shell to paint its prompt before typing into it.
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

  await browser.execute((id: string) => {
    document
      .querySelector<HTMLTextAreaElement>(
        `.native-terminal-view[data-session-id="${id}"] .native-terminal-input`,
      )
      ?.focus();
  }, sessionId);
  return sessionId;
}

describe("native IME sub-spike — terminal hidden textarea", () => {
  let sessionId: string | null = null;

  it(
    "opens a real shell session (the D-13 surface-2 flow)",
    async () => {
      sessionId = await openShellSession();
    },
  ).timeout(120_000);

  it(
    "mechanism A — WebDriver key input delivers raw jamo as plain text, never composition",
    async () => {
      assert.ok(sessionId, "no terminal session");
      // Real key events: six jamo keystrokes for 한글. A real Korean IME would
      // compose these into two syllables through compositionstart/update/end;
      // the question is what WebDriver's key path does instead.
      await browser.keys(JAMO);

      const jamoSeen = await browser.executeAsync(
        (id: string, jamo: string, timeout: number, done: (hit: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const text = window.__MARU_NATIVE_E2E__?.terminalText(id);
            if (text && text.includes(jamo)) {
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
        JAMO,
        POLL_TIMEOUT_MS,
      );
      const text = (await readTerminalText(sessionId)) ?? "";
      // Observed verdict: the jamo land literally (the app's plain insertText
      // path delivers them), and the composed syllables never appear — no
      // composition handler ran. If a future provider version starts driving
      // real IME composition, the second assertion goes red and the recorded
      // verdict in docs/native-e2e.md must be revisited.
      assert.ok(jamoSeen, "raw jamo keystrokes never appeared on the terminal screen");
      assert.equal(
        countOccurrences(text, WORD),
        0,
        "WebDriver key input must not compose jamo into syllables on the terminal surface",
      );
    },
  ).timeout(120_000);

  it(
    "mechanism B — synthetic composition drives the real handlers; the word lands exactly once",
    async () => {
      assert.ok(sessionId, "no terminal session");
      // The sequence a real engine emits, dispatched in-page at the hidden
      // textarea: compositionstart, compositionupdate(s) with the in-progress
      // text, the paired beforeinput/input events, then compositionend with
      // the final data — followed by WKWebView's known trailing echo, an
      // insertText carrying the same text a hair after compositionend, which
      // isTrailingCompositionDuplicate must drop (the 100ms
      // COMPOSITION_TRAILING_MS window). The echo is dispatched deliberately:
      // if the guard ever stops dropping it, the count assertion below fails
      // with a doubled word.
      const dispatched = await browser.execute((id: string, word: string) => {
        const ta = document.querySelector<HTMLTextAreaElement>(
          `.native-terminal-view[data-session-id="${id}"] .native-terminal-input`,
        );
        if (!ta) return false;
        const first = word.slice(0, 1);
        ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        ta.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertCompositionText",
            data: first,
          }),
        );
        ta.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: first }));
        ta.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertCompositionText",
            data: first,
            isComposing: true,
          } as InputEventInit),
        );
        ta.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: word }));
        ta.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertCompositionText",
            data: word,
          }),
        );
        ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: word }));
        // The trailing duplicate, still inside the guard window.
        ta.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: word,
          }),
        );
        ta.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: word }),
        );
        return true;
      }, sessionId, WORD);
      assert.ok(dispatched, "no terminal textarea to dispatch the composition sequence at");

      const wordSeen = await browser.executeAsync(
        (id: string, word: string, timeout: number, done: (hit: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const text = window.__MARU_NATIVE_E2E__?.terminalText(id);
            if (text && text.includes(word)) {
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
        WORD,
        POLL_TIMEOUT_MS,
      );
      assert.ok(wordSeen, "the composed word never reached the terminal screen");

      // Settle well past the 100ms guard window, then count — containment
      // alone would miss a doubled trailing syllable, which is exactly the
      // regression this half of D-08 guards.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const text = (await readTerminalText(sessionId)) ?? "";
      assert.equal(
        countOccurrences(text, WORD),
        1,
        "the composed word must arrive exactly once — a count of 2 means the trailing-duplicate guard let WKWebView's echo through",
      );
    },
  ).timeout(120_000);
});

describe("native IME sub-spike — rich editor contenteditable", () => {
  /** Opens the seeded Welcome document and switches it to rich mode. The
   *  contenteditable selector is resolved by reading the rendered structure —
   *  `.rich-editor-surface [contenteditable="true"]`, which currently resolves
   *  to BlockNote's `div.tiptap.ProseMirror.bn-editor` — rather than pinning a
   *  BlockNote internal class name. */
  async function openRichEditor(): Promise<void> {
    await browser.execute(() => {
      const button =
        document.querySelector<HTMLButtonElement>('.activity-rail button[aria-label="문서"]') ??
        document.querySelector<HTMLButtonElement>('.activity-rail button[aria-label="Documents"]');
      button?.click();
    });

    // The document list defaults to tree mode; the seeded document row is a
    // .tree-row.file button (list mode would be .doc-row).
    const rowClicked = await browser.executeAsync(
      (timeout: number, done: (ok: boolean) => void) => {
        const deadline = Date.now() + timeout;
        const tick = () => {
          const rows = Array.from(
            document.querySelectorAll<HTMLButtonElement>(".tree-row.file, .doc-row"),
          );
          const row = rows.find((el) => el.textContent?.includes("Welcome"));
          if (row) {
            row.click();
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
    assert.ok(rowClicked, "the seeded Welcome document row never appeared");

    // Radix Tabs activates a trigger on mousedown, not click (observed: a
    // plain .click() left data-state on the source tab), so the mode switch
    // dispatches the mouse sequence.
    const richReady = await browser.executeAsync(
      (timeout: number, done: (ok: boolean) => void) => {
        const deadline = Date.now() + timeout;
        const tick = () => {
          if (document.querySelector('.rich-editor-surface [contenteditable="true"]')) {
            done(true);
            return;
          }
          const triggers = Array.from(
            document.querySelectorAll<HTMLButtonElement>(".document-mode-surface .tab-trigger"),
          );
          const rich = triggers.find(
            (el) =>
              (el.textContent?.trim() === "리치" || el.textContent?.trim() === "Rich") &&
              el.getAttribute("data-state") !== "active",
          );
          if (rich) {
            rich.dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: false }),
            );
            rich.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
            rich.click();
          }
          if (Date.now() > deadline) {
            done(false);
            return;
          }
          setTimeout(tick, 250);
        };
        tick();
      },
      POLL_TIMEOUT_MS,
    );
    assert.ok(richReady, "the rich editor contenteditable never appeared");
  }

  async function readEditorText(): Promise<string> {
    return ((await browser.execute(
      () =>
        document.querySelector('.rich-editor-surface [contenteditable="true"]')?.textContent ??
        null,
    )) as string | null) ?? "";
  }

  it(
    "opens the seeded document in rich mode",
    async () => {
      await openRichEditor();
      const text = await readEditorText();
      assert.ok(text.includes("Welcome"), "the rich editor did not render the seeded document");
    },
  ).timeout(120_000);

  it(
    "mechanism A — WebDriver key input produces no observable change",
    async () => {
      const before = await readEditorText();
      await browser.execute(() => {
        const ed = document.querySelector<HTMLElement>(
          '.rich-editor-surface [contenteditable="true"]',
        );
        ed?.focus();
        ed?.click();
      });
      await browser.keys(JAMO);

      // Give any asynchronous insertion path a chance before concluding.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const after = await readEditorText();
      // Observed verdict: nothing arrives — no raw jamo, no composed
      // syllables. Asserting the negative is the boundary guard: if a future
      // provider version starts delivering text to this surface, this case
      // goes red and the recorded verdict must be revisited.
      assert.ok(
        !after.includes(JAMO) && !after.includes(WORD),
        "WebDriver key input unexpectedly inserted text into the rich editor",
      );
      assert.equal(after, before, "the rich editor document changed under WebDriver key input");
    },
  ).timeout(120_000);

  it(
    "mechanism B — synthetic composition with the engine's DOM mutation lands the word once",
    async () => {
      // A real engine does two things at once: it fires the composition event
      // sequence AND mutates the DOM with the in-progress text. Events alone
      // change nothing on this surface (observed: ProseMirror reads its DOM
      // through a mutation observer, and a synthetic event mutates nothing),
      // so the faithful reproduction pairs the sequence with the DOM
      // mutation the browser would perform — here, appending the in-progress
      // syllables into the first text node, then ending the composition so
      // ProseMirror's observer flush adopts the final text.
      const result = await browser.execute((word: string) => {
        const ed = document.querySelector<HTMLElement>(
          '.rich-editor-surface [contenteditable="true"]',
        );
        if (!ed) return "no-ed";
        const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
        const textNode = walker.nextNode() as Text | null;
        if (!textNode) return "no-text-node";
        const before = textNode.data;
        ed.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        textNode.data = before + word.slice(0, 1);
        ed.dispatchEvent(
          new CompositionEvent("compositionupdate", { bubbles: true, data: word.slice(0, 1) }),
        );
        textNode.data = before + word;
        ed.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: word }));
        ed.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: word }));
        return "dispatched";
      }, WORD);
      assert.equal(result, "dispatched", `could not drive the rich editor: ${result}`);

      const wordSeen = await browser.executeAsync(
        (word: string, timeout: number, done: (hit: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const text =
              document.querySelector('.rich-editor-surface [contenteditable="true"]')
                ?.textContent ?? "";
            if (text.includes(word)) {
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
        WORD,
        POLL_TIMEOUT_MS,
      );
      assert.ok(wordSeen, "the composed word never landed in the rich editor document");

      // Settle so ProseMirror's observer flush and any re-render complete,
      // then count: the word must survive the flush (a reverted DOM means the
      // editor never adopted the composition) and appear exactly once.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const text = await readEditorText();
      assert.equal(
        countOccurrences(text, WORD),
        1,
        "the composed word must land in the rich editor document exactly once",
      );
    },
  ).timeout(120_000);
});
