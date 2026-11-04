// Native selection/handoff proof with a synthetic installed console. Runtime execution is separate from compile validation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import { fixtureRootDir } from "../helpers/fixtureWorkspace";
import { consoleFixture } from "../helpers/consoleFixture";
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

interface FamilyToolProbe {
  ready: boolean;
  selected: string | null;
  loading: boolean;
  packageVisible: boolean;
  launchPresent: boolean;
  launchEnabled: boolean;
  diagnostics: string[];
}

function waitForFamilyTool(tool: "ahub" | "acon"): Promise<FamilyToolProbe> {
  return browser.executeAsync(
    (
      expectedTool: string,
      timeoutMs: number,
      loadingText: string,
      expectedPackage: string,
      launchText: string,
      done: (probe: FamilyToolProbe) => void,
    ) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const content = document.querySelector<HTMLElement>(".settings-content");
        const select = content?.querySelector<HTMLSelectElement>("select");
        const loading = Array.from(content?.querySelectorAll<HTMLElement>('[role="status"]') ?? [])
          .some((item) => item.textContent?.trim() === loadingText);
        const launch = Array.from(content?.querySelectorAll<HTMLButtonElement>("button") ?? [])
          .find((button) => button.textContent?.trim() === launchText);
        const probe: FamilyToolProbe = {
          ready: false,
          selected: select?.value ?? null,
          loading,
          packageVisible: content?.textContent?.includes(expectedPackage) ?? false,
          launchPresent: Boolean(launch),
          launchEnabled: launch !== undefined && !launch.disabled,
          diagnostics: Array.from(content?.querySelectorAll<HTMLElement>('[role="status"], [role="alert"], dl') ?? [])
            .map((item) => item.textContent?.trim().slice(0, 1000) ?? ""),
        };
        probe.ready = probe.selected === expectedTool
          && !probe.loading
          && probe.packageVisible
          && (expectedTool !== "acon" || probe.launchEnabled);
        if (probe.ready || Date.now() >= deadline) {
          done(probe);
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    },
    tool,
    20_000,
    "버전과 지원 manifest 확인 중...",
    tool === "acon" ? "@staix/agent-console" : "@staix/agent-hub",
    "Agent Console 열기",
  );
}

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
    const initialInventory = await waitForFamilyTool("ahub");
    assert.ok(initialInventory.ready, `initial inventory did not settle: ${JSON.stringify(initialInventory)}`);
    // Driver 1.3.0's option click only runs option.click(); it does not
    // deliver the select change event needed by this controlled React input.
    const selected = await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(".settings-content select");
      if (!select) return false;
      select.value = "acon";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return select.value === "acon";
    });
    assert.equal(selected, true, "the inventory tool selector must accept acon");
    const selectedAcon = await waitForFamilyTool("acon");
    assert.ok(selectedAcon.ready, `selected acon package did not resolve to an enabled launch control: ${JSON.stringify(selectedAcon)}`);
    const launch = await browser.$('.settings-content').$('button*=Agent Console 열기');
    await assert.rejects(fs.access(path.join(home, "acon-starts.log")), "refresh/selection must not start a console");
    await launch.click();
    await browser.waitUntil(async () => { try { return JSON.parse(await fs.readFile(path.join(home, "acon-proof.json"), "utf8")).topLevel === true; } catch { return false; } }, { timeout: 30000 });
    const calls = (await fs.readFile(path.join(home, "acon-starts.log"), "utf8")).trim().split("\n"); assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0]), ["ui", "--no-open", "--json"]);
  });
});
