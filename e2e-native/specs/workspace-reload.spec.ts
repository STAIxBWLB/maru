// Opt-in local macOS check: this needs the running Orca computer-use provider.
// Successful input injection alone is not evidence that Maru handled Cmd+R.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type {} from "webdriverio";
import { FIXTURE_DOC_NAME } from "../helpers/fixtureWorkspace";

const execute = promisify(execFile);
const orca = "/opt/homebrew/bin/orca";
interface ReloadProbe {
  sentinel: string;
  began: boolean;
  completed: boolean;
  observer?: MutationObserver;
}
type ProbeWindow = Window & { __maruWorkspaceReloadProbe?: ReloadProbe };

async function computer(args: string[]): Promise<void> {
  const { stdout } = await execute(orca, ["computer", ...args, "--json", "--no-screenshot"], { timeout: 30_000 });
  const response = JSON.parse(stdout) as { ok?: boolean; success?: boolean; error?: unknown };
  assert.ok(response.ok !== false && response.success !== false && !response.error, stdout);
}

describe("native OS workspace reload shortcut", () => {
  const run = process.env.MARU_NATIVE_OS_HOTKEY === "1" ? it : it.skip;
  run("handles physical Cmd+R from a focused search without reloading the WKWebView page", async () => {
    assert.equal(process.platform, "darwin");
    assert.ok(process.env.MARU_NATIVE_E2E_HOME, "fixture isolation is required");
    // Exact relative argv from wdio.conf.ts, excluding any installed Maru or
    // another checkout's absolute-path debug instance. Refuse ambiguity.
    const { stdout } = await execute("/usr/bin/pgrep", ["-f", "^\\./src-tauri/target/debug/maru$"]);
    const pids = stdout.trim().split("\n").filter(Boolean);
    assert.equal(pids.length, 1, `expected one fixture app, found ${pids.join(", ")}`);
    const app = `pid:${pids[0]}`;
    await computer(["get-app-state", "--app", app, "--restore-window"]);

    const ready = await browser.executeAsync((docName: string, done: (ready: boolean) => void) => {
      const deadline = Date.now() + 25_000;
      let opened = false;
      const timer = setInterval(() => {
        if (!opened && window.__MARU_NATIVE_E2E__?.menuCommand) {
          window.__MARU_NATIVE_E2E__.menuCommand("view.documents"); opened = true;
        }
        const refresh = document.querySelector(".topbar-refresh-action");
        const list = document.querySelector(".document-list");
        if (opened && refresh && !refresh.classList.contains("refreshing") && list?.textContent?.includes(docName)) {
          clearInterval(timer); done(true); return;
        }
        if (Date.now() > deadline) { clearInterval(timer); done(false); }
      }, 100);
    }, FIXTURE_DOC_NAME);
    assert.equal(ready, true, "fixture Documents view never reached stable readiness");

    const sentinel = randomUUID();
    const focused = await browser.execute((value: string) => {
      const target = window as ProbeWindow;
      const button = document.querySelector<HTMLElement>(".topbar-refresh-action");
      const input = document.querySelector<HTMLInputElement>(".document-list .search-box input");
      if (!button || !input) throw new Error("refresh action or document search is absent");
      if (button.classList.contains("refreshing")) throw new Error("an earlier refresh is still running");
      input.focus();
      const probe: ReloadProbe = { sentinel: value, began: false, completed: false };
      probe.observer = new MutationObserver((changes) => {
        if (changes.some((change) => /(?:^|\s)refreshing(?:\s|$)/.test(change.oldValue ?? "")) || button.classList.contains("refreshing")) probe.began = true;
        if (probe.began && !button.classList.contains("refreshing")) probe.completed = true;
      });
      probe.observer.observe(button, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
      target.__maruWorkspaceReloadProbe = probe;
      return document.activeElement === input;
    }, sentinel);
    assert.equal(focused, true, "Cmd+R must be tested with the search control focused");
    try {
      // Refresh window state immediately before injection. No accessibility
      // element indexes are reused, and the PID always identifies our fixture.
      await computer(["get-app-state", "--app", app, "--restore-window"]);
      assert.equal(await browser.execute(() => document.activeElement === document.querySelector(".document-list .search-box input")), true,
        "restoring the native window changed the focused search control");
      await computer(["hotkey", "--app", app, "--key", "CmdOrCtrl+R"]);
      const result = await browser.executeAsync((expected: string, docName: string, done: (value: { sentinel: boolean; began: boolean; completed: boolean; documents: boolean }) => void) => {
        const deadline = Date.now() + 25_000;
        const timer = setInterval(() => {
          const probe = (window as ProbeWindow).__maruWorkspaceReloadProbe;
          const value = {
            sentinel: probe?.sentinel === expected,
            began: probe?.began ?? false,
            completed: probe?.completed ?? false,
            documents: document.querySelector(".document-list")?.textContent?.includes(docName) ?? false,
          };
          if (!value.sentinel || (value.began && value.completed && value.documents) || Date.now() > deadline) {
            clearInterval(timer); done(value);
          }
        }, 50);
      }, sentinel, FIXTURE_DOC_NAME);
      assert.deepEqual(result, { sentinel: true, began: true, completed: true, documents: true },
        "OS injection is unproven unless workspace refresh completes and the original WKWebView sentinel survives");
    } finally {
      await browser.execute(() => {
        const target = window as ProbeWindow;
        target.__maruWorkspaceReloadProbe?.observer?.disconnect();
        delete target.__maruWorkspaceReloadProbe;
      });
    }
  }).timeout(180_000);
});
