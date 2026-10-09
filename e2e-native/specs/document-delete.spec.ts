// #441 real-app check: deleting a document after the review dialog moves it to
// the macOS system Trash through NSFileManager, which Chromium e2e cannot prove.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {} from "webdriverio";

import { fixtureRootDir } from "../helpers/fixtureWorkspace";

describe("native document delete", () => {
  it("moves the reviewed document to the system Trash", async () => {
    assert.equal(process.platform, "darwin");
    const name = `delete-probe-${randomUUID().slice(0, 8)}`;
    const file = path.join(fixtureRootDir(), "workspace", `${name}.md`);
    await fs.writeFile(file, `# ${name}\n\nnative delete probe\n`, "utf8");
    await browser.switchToWindow(await browser.getWindowHandle());

    // Open Documents, rescan, then open the row's context menu and the dialog.
    const opened = await browser.executeAsync((title: string, done: (ok: boolean) => void) => {
      const deadline = Date.now() + 60_000;
      let stage = "open";
      const timer = setInterval(() => {
        if (stage === "open" && window.__MARU_NATIVE_E2E__?.menuCommand) {
          window.__MARU_NATIVE_E2E__.menuCommand("view.documents");
          stage = "refresh";
        }
        const refresh = document.querySelector<HTMLElement>(".topbar-refresh-action");
        if (stage === "refresh" && refresh && !refresh.classList.contains("refreshing")) {
          refresh.click();
          stage = "row";
        }
        const row = [...document.querySelectorAll<HTMLElement>(".document-list button")].find((button) =>
          button.textContent?.includes(title),
        );
        if (stage === "row" && row) {
          const box = row.getBoundingClientRect();
          row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: box.x + 8, clientY: box.y + 8 }));
          stage = "menu";
        }
        const item = [...document.querySelectorAll<HTMLElement>('.context-menu [role="menuitem"]')].find((button) =>
          /휴지통|Trash/.test(button.textContent ?? ""),
        );
        if (stage === "menu" && item) {
          item.click();
          clearInterval(timer);
          done(true);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          done(false);
        }
      }, 200);
    }, name);
    assert.equal(opened, true, "the probe document's delete action never opened");

    const confirm = await browser.$(".document-delete-dialog .button-danger");
    await confirm.waitForEnabled({ timeout: 30_000 });
    await confirm.click();
    await browser.waitUntil(
      async () => !(await fs.stat(file).then(() => true, () => false)),
      { timeout: 30_000, timeoutMsg: "the probe document is still in the workspace" },
    );
    const notice = await browser.execute(() => document.body.textContent ?? "");
    assert.match(notice, /휴지통으로 옮겼습니다|to the Trash/);

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
