// Native selection/handoff proof with a synthetic installed console. Runtime execution is separate from compile validation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import { fixtureRootDir } from "../helpers/fixtureWorkspace";
import { consoleFixture } from "../helpers/consoleFixture";
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
describe("native family tool registry", () => {
  let home = "";
  after(async () => { if (!home) return; try { const ready = JSON.parse(await fs.readFile(path.join(home, "acon-ready.json"), "utf8")); await fetch(`${ready.origin}/stop`, { signal: AbortSignal.timeout(2000) }); } catch { /* owned fixture already stopped or never started */ } });
  it("selects installed tools without executing them, then launches only explicit acon with fixed argv", async () => {
    home = path.join(fixtureRootDir(), "home");
    const bin = path.join(home, ".bun/bin"); const pkg = path.join(home, ".bun/install/global/node_modules/@staix/agent-console");
    await fs.mkdir(bin, { recursive: true }); await fs.mkdir(path.join(pkg, "bin"), { recursive: true });
    await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@staix/agent-console", version: "0.1.0", bin: { acon: "bin/acon.js" } }));
    await fs.writeFile(path.join(pkg, "bin/acon.js"), consoleFixture);
    await fs.writeFile(path.join(bin, "bun"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });
    await fs.symlink(path.join(pkg, "bin/acon.js"), path.join(bin, "acon"));
    const settings = await browser.$('.activity-rail button[aria-label="설정"]'); await settings.waitForDisplayed({ timeout: 30000 }); await settings.click();
    const tab = await browser.$('.settings-nav-item*=패밀리 도구'); await tab.waitForDisplayed({ timeout: 30000 }); await tab.click();
    const select = await browser.$('.settings-content select'); await select.waitForDisplayed({ timeout: 30000 }); await select.selectByAttribute("value", "acon");
    const launch = await browser.$('.settings-content').$('button*=Agent Console 열기'); await launch.waitForEnabled({ timeout: 30000 });
    await assert.rejects(fs.access(path.join(home, "acon-starts.log")), "refresh/selection must not start a console");
    await launch.click();
    await browser.waitUntil(async () => { try { return JSON.parse(await fs.readFile(path.join(home, "acon-proof.json"), "utf8")).topLevel === true; } catch { return false; } }, { timeout: 30000 });
    const calls = (await fs.readFile(path.join(home, "acon-starts.log"), "utf8")).trim().split("\n"); assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0]), ["ui", "--no-open", "--json"]);
  });
});
