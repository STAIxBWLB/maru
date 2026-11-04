// Real native child-webview proof with an isolated console-contract fixture.
// The fixture enforces the published top-level/CSP/Origin/session contract;
// it does not claim to exercise the published acon package or its plugins.
import assert from "node:assert/strict";
import { consoleFixture } from "../helpers/consoleFixture";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import { fixtureRootDir } from "../helpers/fixtureWorkspace";

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;

describe("native console site launch", () => {
  let home: string;
  after(async () => {
    if (!home) return;
    try { const ready = JSON.parse(await fs.readFile(path.join(home, "acon-ready.json"), "utf8")) as { origin: string }; await fetch(`${ready.origin}/stop`, { signal: AbortSignal.timeout(2000) }); } catch { /* owned fixture may already have stopped */ }
  });
  it("runs fixed argv and proves a top-level session under frame-ancestors none, then opens a manual URL without acon", async () => {
    home = path.join(fixtureRootDir(), "home");
    const bin = path.join(home, ".bun", "bin");
    const pkg = path.join(home, ".bun", "install", "global", "node_modules", "@staix", "agent-console");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(path.join(pkg, "bin"), { recursive: true });
    await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@staix/agent-console", version: "0.1.0", bin: { acon: "bin/acon.js" } }));
    await fs.writeFile(path.join(pkg, "bin", "acon.js"), consoleFixture);
    await fs.writeFile(path.join(bin, "bun"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });
    await fs.symlink(path.join(pkg, "bin", "acon.js"), path.join(bin, "acon"));
    await fs.writeFile(path.join(home, ".maru", "sites.json"), JSON.stringify({ version: 1, sites: [{ id: "native-console", label: "Native Console", url: "http://127.0.0.1", launch: "acon ui --no-open --json" }] }));
    const sites = await browser.$('.activity-rail button[aria-label="사이트"]');
    await sites.waitForDisplayed({ timeout: 30_000 }); await sites.click();
    const entry = await browser.$(".sites-item-primary");
    await entry.waitForDisplayed({ timeout: 30_000 }); await entry.click();
    const proofFile = path.join(home, "acon-proof.json");
    await browser.waitUntil(async () => { try { return JSON.parse(await fs.readFile(proofFile, "utf8")).count >= 1; } catch { return false; } }, { timeout: 30_000, timeoutMsg: "console child must execute its CSP-protected same-origin cookie bootstrap" });
    const proof = JSON.parse(await fs.readFile(proofFile, "utf8")) as { origin: string; requestOrigin: string; topLevel: boolean; ipcDenied: boolean; httpOnlyHidden: boolean; cookie: boolean };
    assert.equal(proof.topLevel, true, "the console document must be a top-level native webview, not a frame");
    assert.equal(proof.ipcDenied, true, "the console document must not receive Tauri IPC");
    assert.equal(proof.httpOnlyHidden, true, "the console document must not read its HttpOnly session cookie");
    assert.equal(proof.cookie, true, "the same-origin bootstrap must set its session cookie");
    assert.equal(proof.requestOrigin, proof.origin, "the console bootstrap request must keep its declared origin");

    const consoleShown = async () => Boolean(await browser.execute(() => {
      const selected = document.querySelector<HTMLButtonElement>('.sites-tab.active [role="tab"]');
      const surface = document.querySelector<HTMLElement>(".sites-surface");
      const rect = surface?.getBoundingClientRect();
      return selected?.getAttribute("aria-selected") === "true"
        && selected.textContent?.includes("Native console") === true
        && Boolean(rect && rect.width > 0 && rect.height > 0);
    }));
    await browser.waitUntil(consoleShown, {
      timeout: 30_000,
      timeoutMsg: "the launched console tab never became the selected, visible Sites surface",
    });
    assert.equal(await consoleShown(), true, "the launched console must be shown in the active Sites surface");

    await fs.unlink(path.join(bin, "acon"));
    const addressBeforeFocus = await browser.$(".sites-url input");
    await addressBeforeFocus.waitForDisplayed({ timeout: 15_000 });
    await addressBeforeFocus.click();
    const addressAfterFocus = await browser.$(".sites-url input");
    await addressAfterFocus.setValue(`${proof.origin}/`);
    await browser.keys("Enter");
    await browser.waitUntil(async () => JSON.parse(await fs.readFile(proofFile, "utf8")).count >= 2, { timeout: 15_000, timeoutMsg: "manual URL must still load without a console executable" });
    assert.equal((await fs.readFile(path.join(home, "acon-starts.log"), "utf8")).trim().split("\n").length, 1);
    const stored = await fs.readFile(path.join(home, ".maru", "sites.json"), "utf8");
    assert.ok(!stored.includes("fixture-ticket"), "one-time launch URL must not be persisted in Sites");
  });
});
