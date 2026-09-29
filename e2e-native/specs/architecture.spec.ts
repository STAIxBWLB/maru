// #410 real-WKWebView check for the 설계도 mode: a listed blueprint loads in an
// asset-origin iframe, its inline scripts run (the app CSP does not reach
// it), `?theme=` arrives and follows a live toggle, and the frame can reach
// neither the app document nor Tauri IPC. Chromium e2e cannot prove any of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {} from "webdriverio";

import { fixtureRootDir } from "../helpers/fixtureWorkspace";

interface Probe {
  theme: string | null;
  ipc: string;
  parent: string;
}

const PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Probe</title></head><body>
<script>
  var parentAccess;
  try { parentAccess = String(window.parent.document.title); } catch (_) { parentAccess = "blocked"; }
  window.parent.postMessage({
    source: "architecture-probe",
    theme: new URLSearchParams(location.search).get("theme"),
    ipc: typeof window.__TAURI_INTERNALS__,
    parent: parentAccess
  }, "*");
</script>
</body></html>
`;

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=Native Fixture", "-c", "user.email=fixture@example.invalid", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const workspace = () => path.join(fixtureRootDir(), "workspace");

async function probes(): Promise<Probe[]> {
  return browser.execute(() => (window as unknown as { __architectureProbes?: Probe[] }).__architectureProbes ?? []);
}

async function waitForProbe(count: number): Promise<Probe> {
  await browser.waitUntil(async () => (await probes()).length >= count, {
    timeout: 30_000,
    timeoutMsg: `expected blueprint probe message #${count}`,
  });
  return (await probes())[count - 1];
}

describe("native 설계도 mode", () => {
  // Seeded once for this file's single test: wdio's beforeTest reset wipes
  // the workspace from the second test on, so a new test must seed again.
  before(async () => {
    const source = path.join(fixtureRootDir(), "blueprint-src");
    await fs.mkdir(path.join(source, "docs", "architecture"), { recursive: true });
    await fs.writeFile(path.join(source, "docs", "architecture", "probe-rendered.html"), PROBE_HTML);
    await fs.writeFile(
      path.join(source, "docs", "architecture", "probe.architecture.json"),
      JSON.stringify({ meta: { title: "Probe Blueprint" } }),
    );
    git(source, ["init", "-q"]);
    git(source, ["add", "."]);
    git(source, ["commit", "-qm", "probe"]);
    git(workspace(), ["init", "-q"]);
    git(workspace(), ["submodule", "add", "-q", source, "dev/probe"]);
  });

  after(async () => {
    for (const entry of [".git", ".gitmodules", "dev"]) {
      await fs.rm(path.join(workspace(), entry), { recursive: true, force: true });
    }
  });

  it("runs the viewer sandboxed, themed, and cut off from the app", async () => {
    await browser.execute(() => {
      const w = window as unknown as { __architectureProbes?: unknown[] };
      w.__architectureProbes = [];
      window.addEventListener("message", (event) => {
        if ((event.data as { source?: string } | null)?.source === "architecture-probe") {
          w.__architectureProbes!.push(event.data);
        }
      });
    });
    const appUrl = await browser.getUrl();

    const button = await browser.$('.activity-rail button[aria-label="설계도"]');
    await button.waitForDisplayed({ timeout: 30_000 });
    await button.click();
    const item = await browser.$(".architecture-item");
    await item.waitForDisplayed({ timeout: 30_000 });
    assert.match(await item.getText(), /Probe Blueprint/);

    const theme = await browser.execute(() => document.documentElement.dataset.theme ?? "light");
    const first = await waitForProbe(1);
    assert.equal(first.theme, theme, "the viewer must receive the app theme");
    assert.equal(first.ipc, "undefined", "the frame must not see Tauri internals");
    assert.equal(first.parent, "blocked", "the frame must not read the app document");

    const toggled = theme === "dark" ? "light" : "dark";
    await browser.execute((next: string) => {
      document.documentElement.dataset.theme = next;
    }, toggled);
    const second = await waitForProbe(2);
    assert.equal(second.theme, toggled, "a live theme toggle must reload the viewer");
    await browser.execute((previous: string) => {
      document.documentElement.dataset.theme = previous;
    }, theme);

    assert.equal(await browser.getUrl(), appUrl, "the app webview must stay on the app");
  });
});
