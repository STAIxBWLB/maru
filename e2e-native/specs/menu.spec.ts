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

// Plan 09-03 (D-03/A1): the macOS App-submenu Quit item now emits "app.quit"
// instead of tauri's predefined native quit item, which used to bypass the
// webview entirely (NSApplication terminate:, research Pitfall 2). What this
// spec proves: dispatching "app.quit" through the same debug bridge reaches
// runMenuCommand -> requestWindowClose(), the exact guard the red close
// button reaches, so a dirty draft shows the unsaved-changes dialog instead
// of an immediate exit. What it does NOT prove: that the OS actually delivers
// the physical Cmd+Q keypress or menu click to this item — that half is
// human-attended (docs/native-e2e.md "## macOS menu bar" / "## Human-attended
// checklist").
describe("native macOS quit route (app.quit)", () => {
  /** Opens the seeded fixture document in rich mode — same recipe as
   *  ime.spec.ts's openRichEditor, duplicated locally since each spec file
   *  is an independent mocha module. */
  async function openRichEditor(): Promise<void> {
    await browser.execute(() => {
      const button =
        document.querySelector<HTMLButtonElement>('.activity-rail button[aria-label="문서"]') ??
        document.querySelector<HTMLButtonElement>('.activity-rail button[aria-label="Documents"]');
      button?.click();
    });

    const rowClicked = await browser.executeAsync(
      (docName: string, timeout: number, done: (ok: boolean) => void) => {
        const deadline = Date.now() + timeout;
        const tick = () => {
          const rows = Array.from(
            document.querySelectorAll<HTMLButtonElement>(".tree-row.file, .doc-row"),
          );
          const row = rows.find((el) => el.textContent?.includes(docName));
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
      FIXTURE_DOC_NAME,
      POLL_TIMEOUT_MS,
    );
    assert.ok(rowClicked, "the seeded fixture document row never appeared");

    // Radix Tabs activates a trigger on mousedown, not click (see
    // ime.spec.ts's openRichEditor for the same observation).
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
    return (
      ((await browser.execute(
        () =>
          document.querySelector('.rich-editor-surface [contenteditable="true"]')?.textContent ??
          null,
      )) as string | null) ?? ""
    );
  }

  /** Dirties the first text node in the rich editor via a synthetic
   *  composition sequence — the only mechanism proven (ime.spec.ts mechanism
   *  B) to reach ProseMirror's mutation observer; a synthetic event alone
   *  changes nothing on this surface. Returns the node's original text so the
   *  caller can restore it byte-for-byte afterward. */
  async function dirtyFirstTextNode(marker: string): Promise<{ ok: boolean; nodeBefore: string }> {
    return browser.execute((mark: string) => {
      const ed = document.querySelector<HTMLElement>(
        '.rich-editor-surface [contenteditable="true"]',
      );
      if (!ed) return { ok: false, nodeBefore: "" };
      const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      const textNode = walker.nextNode() as Text | null;
      if (!textNode) return { ok: false, nodeBefore: "" };
      const nodeBefore = textNode.data;
      ed.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      textNode.data = nodeBefore + mark;
      ed.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: mark }));
      ed.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: mark }));
      return { ok: true, nodeBefore };
    }, marker);
  }

  /** Reverses dirtyFirstTextNode: restores the first text node to its
   *  captured original value through the same composition-sequence
   *  mechanism, so the session ends with no dirty draft (Task 1 acceptance
   *  criteria). */
  async function restoreFirstTextNode(nodeBefore: string): Promise<boolean> {
    return browser.execute((original: string) => {
      const ed = document.querySelector<HTMLElement>(
        '.rich-editor-surface [contenteditable="true"]',
      );
      if (!ed) return false;
      const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      const textNode = walker.nextNode() as Text | null;
      if (!textNode) return false;
      ed.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      textNode.data = original;
      ed.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: original }));
      ed.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: original }));
      return true;
    }, nodeBefore);
  }

  it(
    "app.quit routes into the window-close guard",
    async () => {
      await openRichEditor();
      const originalText = await readEditorText();

      const marker = "!";
      const { ok, nodeBefore } = await dirtyFirstTextNode(marker);
      assert.ok(ok, "could not locate a text node in the rich editor to dirty");

      const dirtied = await browser.executeAsync(
        (mark: string, timeout: number, done: (hit: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const text =
              document.querySelector('.rich-editor-surface [contenteditable="true"]')
                ?.textContent ?? "";
            if (text.includes(mark)) {
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
        marker,
        POLL_TIMEOUT_MS,
      );
      assert.ok(dirtied, "the synthetic composition edit never landed in the rich editor");

      await dispatchMenuCommand("app.quit");

      const dialogShown = await browser.executeAsync(
        (timeout: number, done: (ok: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            if (document.querySelector('.dialog-backdrop [role="alertdialog"]')) {
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
        dialogShown,
        'dispatching "app.quit" with a dirty draft never showed the unsaved-changes dialog — ' +
          "app.quit is not reaching the window-close guard",
      );

      const cancelClicked = await browser.execute(() => {
        const cancel = document.querySelector<HTMLButtonElement>(
          ".dialog-backdrop .button-ghost",
        );
        cancel?.click();
        return Boolean(cancel);
      });
      assert.ok(cancelClicked, "the unsaved-changes dialog's Cancel button was not found");

      const dialogGoneAndAppAlive = await browser.executeAsync(
        (timeout: number, done: (ok: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const dialogGone = !document.querySelector('.dialog-backdrop [role="alertdialog"]');
            const appAlive = Boolean(document.querySelector(".activity-rail"));
            if (dialogGone && appAlive) {
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
        dialogGoneAndAppAlive,
        "Cancel did not dismiss the unsaved-changes dialog and leave Maru open and responsive",
      );

      // Leave no dirty draft behind: restore the exact original text through
      // the same composition mechanism used to dirty it.
      const restored = await restoreFirstTextNode(nodeBefore);
      assert.ok(restored, "could not restore the rich editor text to its original content");

      const textRestored = await browser.executeAsync(
        (original: string, timeout: number, done: (ok: boolean) => void) => {
          const deadline = Date.now() + timeout;
          const tick = () => {
            const text =
              document.querySelector('.rich-editor-surface [contenteditable="true"]')
                ?.textContent ?? "";
            if (text === original) {
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
        originalText,
        POLL_TIMEOUT_MS,
      );
      assert.ok(
        textRestored,
        "the rich editor text was not restored to its original content after the test",
      );
    },
  ).timeout(120_000);
});
