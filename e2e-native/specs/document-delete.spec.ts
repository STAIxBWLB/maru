// #441 real-app check: deleting a document after the review dialog moves it to
// the macOS system Trash through NSFileManager, which Chromium e2e cannot prove.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {} from "webdriverio";

import { fixtureRootDir } from "../helpers/fixtureWorkspace";

/** Keep each WebDriver script synchronous and below its 30s script limit.
 * The runner owns the stage deadline and captures where UI readiness stalled. */
async function waitForDeleteStage(stage: string, ready: () => Promise<boolean>): Promise<void> {
  console.info("native_document_delete_stage", stage);
  try {
    await browser.waitUntil(ready, {
      timeout: 30_000, interval: 200, timeoutMsg: `native document delete stalled at ${stage}`,
    });
  } catch (error) {
    let diagnostics: unknown;
    try {
      diagnostics = await browser.execute(() => {
        const state = window.__MARU_NATIVE_E2E__?.readAppState();
        return {
          mode: state?.appMode, catalogLoading: state?.catalogLoading,
          listPresent: Boolean(document.querySelector(".document-list")),
          rows: [...document.querySelectorAll(".document-list .doc-row strong")].slice(0, 10).map((row) => row.textContent),
          menu: document.querySelector(".context-menu")?.textContent?.slice(0, 800),
          dialog: document.querySelector(".document-delete-dialog")?.textContent?.slice(0, 1200),
          error: document.querySelector(".inline-error, .error-toast, .error-banner")?.textContent?.slice(0, 800),
        };
      });
    } catch (inspectionError) { diagnostics = { unavailable: String(inspectionError) }; }
    throw new Error(`native_document_delete_stage_failed: ${stage}; ${String(error)}; diagnostics=${JSON.stringify(diagnostics)}`);
  }
}

describe("native document delete", () => {
  it("moves the reviewed document to the system Trash", async () => {
    assert.equal(process.platform, "darwin");
    const name = `delete-probe-${randomUUID().slice(0, 8)}`;
    const file = path.join(fixtureRootDir(), "workspace", `${name}.md`);
    await fs.writeFile(file, `# ${name}\n\nnative delete probe\n`, "utf8");
    await browser.switchToWindow(await browser.getWindowHandle());

    // A mode switch and refresh in one browser task can hit the old surface's
    // refresh closure. Wait for Documents to mount, then use its own refresh.
    await waitForDeleteStage("Documents menu dispatch", () => browser.execute(() => {
      const bridge = window.__MARU_NATIVE_E2E__;
      return bridge?.menuCommandReady() === true && bridge.menuCommand("view.documents");
    }));
    await waitForDeleteStage("Documents refresh", () => browser.execute(() => {
      const lists = [...document.querySelectorAll<HTMLElement>(".document-list")];
      const list = lists.find((node) => node.getBoundingClientRect().height > 0);
      const refresh = [...(list?.querySelectorAll<HTMLButtonElement>(".list-header button") ?? [])]
        .find((button) => /^(Workspace 다시 읽기|Reload workspace)$/.test(button.getAttribute("aria-label") ?? ""));
      if (!refresh || refresh.disabled) return false;
      refresh.click();
      return true;
    }));
    await waitForDeleteStage("probe row context menu", () => browser.execute((title: string) => {
      const row = [...document.querySelectorAll<HTMLElement>(".document-list .doc-row")]
        .find((button) => button.textContent?.includes(title) && button.getBoundingClientRect().height > 0);
      if (!row) return false;
      const box = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: box.x + 8, clientY: box.y + 8 }));
      return true;
    }, name));
    await waitForDeleteStage("Move to Trash menu action", () => browser.execute((title: string) => {
      const menu = [...document.querySelectorAll<HTMLElement>('.context-menu[role="menu"]')]
        .find((node) => node.querySelector(".context-menu-title")?.textContent?.includes(title));
      const item = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        .find((button) => /휴지통|Trash/.test(button.textContent ?? ""));
      if (!item) return false;
      item.click();
      return true;
    }, name));
    await waitForDeleteStage("reviewed file list and confirmation", () => browser.execute((title: string) => {
      const dialog = document.querySelector(".document-delete-dialog");
      const confirm = dialog?.querySelector<HTMLButtonElement>(".button-danger");
      if (!dialog?.textContent?.includes(`${title}.md`) || !confirm || confirm.disabled) return false;
      confirm.click();
      return true;
    }, name));
    await waitForDeleteStage("workspace source removal", async () => {
      try { await fs.stat(file); return false; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
    });
    await waitForDeleteStage("Trash success notice", () => browser.execute(() =>
      /휴지통으로 옮겼습니다|to the Trash/.test(document.body.textContent ?? ""),
    ));

    // Reading ~/.Trash needs Full Disk Access on some hosts; only a readable
    // Trash can prove the landing spot, and an unreadable one is reported.
    try {
      const entries = await fs.readdir(path.join(os.homedir(), ".Trash"));
      assert.ok(entries.some((entry) => entry.startsWith(name)), "the probe is not in ~/.Trash");
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(name))
          .map((entry) => fs.rm(path.join(os.homedir(), ".Trash", entry), { force: true })),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      console.warn("native_document_delete_trash_unreadable", String(error));
    }
  }).timeout(240_000);
});
