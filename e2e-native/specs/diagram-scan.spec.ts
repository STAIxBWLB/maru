// Real-app proof of the read-only repository scan (issue #553, E5 T3): the
// Diagram File ribbon opens the scan, the native plugin proposes a map from a
// synthetic folder in the fixture workspace, the proposal opens as an unsaved
// document, a folder outside the workspace is refused with a next step, and
// the scanned tree is unchanged. Chromium cannot reach the native plugin.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import { fixtureRootDir } from "../helpers/fixtureWorkspace";

async function listing(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      out.push(`${path.relative(root, full)}:${stat.size}:${stat.mtimeMs}`);
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return out.sort();
}

describe("native repository scan", () => {
  it("proposes a map from a workspace folder, opens it unsaved and refuses an outside folder", async () => {
    await browser.switchToWindow(await browser.getWindowHandle());
    const workspace = path.join(fixtureRootDir(), "workspace");
    const repo = path.join(workspace, "scan-sample");
    const files: Record<string, string> = {
      "web/src/main.ts": "import { b } from './ui/button';\nimport { u } from '../../shared/util';\n",
      "web/src/ui/button.tsx": "export const b = 1;\n",
      "shared/util.ts": "export const u = 1;\n",
      "core/Cargo.toml": "[package]\nname = \"core\"\n",
      "core/src/lib.rs": "mod parse;\n",
      "core/src/parse.rs": "",
    };
    for (const [relative, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
      await fs.writeFile(path.join(repo, relative), body);
    }
    const outside = path.join(fixtureRootDir(), "outside-scan");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "a.ts"), "");
    const diagramsBefore = await fs.readdir(path.join(workspace, "diagrams")).catch(() => [] as string[]);
    const before = await listing(repo);
    // Everything Maru keeps per workspace (snapshot history, workspace state and
    // settings) lives under .maru; opening a proposal must change none of it.
    const maruDir = path.join(workspace, ".maru");

    const rail = await browser.$('.activity-rail button[aria-label="다이어그램"]');
    await rail.waitForDisplayed({ timeout: 30_000 });
    await (await browser.$('.activity-rail button[aria-label="다이어그램"]')).click();
    await (await browser.$('[role="tab"]*=파일')).click();
    await (await browser.$("button*=리포지토리 스캔")).click();
    const dialog = await browser.$('[data-testid="diagram-scan-dialog"]');
    await dialog.waitForDisplayed({ timeout: 30_000 });

    const setPath = async (value: string) => {
      const input = await browser.$('[data-testid="diagram-scan-path"]');
      await input.clearValue();
      await input.setValue(value);
    };

    // A folder outside the open workspace is refused with its cause and next step.
    await setPath(outside);
    await (await browser.$('[data-testid="diagram-scan-run"]')).click();
    const refusal = await browser.$('[data-testid="diagram-scan-error"]');
    await refusal.waitForDisplayed({ timeout: 30_000, timeoutMsg: "An outside folder was not refused; inspect scan_repository's workspace confinement" });
    const refusalText = await refusal.getText();
    assert.match(refusalText, /diagram_scan_outside_workspace/, "Refusal lost its code; inspect the plugin's IpcError mapping");
    assert.match(refusalText, /pick a folder inside the open workspace/, "Refusal has no next step; restore ScanError.next_step in the dialog");

    // A folder inside the workspace proposes the recorded modules and import edges
    // (the same tree is pinned in scan_tests.rs: 5 folders, 1 cross-folder import).
    await setPath(repo);
    await (await browser.$('[data-testid="diagram-scan-run"]')).click();
    const summary = await browser.$('[data-testid="diagram-scan-summary"]');
    await summary.waitForDisplayed({ timeout: 60_000, timeoutMsg: "The scan produced no proposal; inspect scan_repository and the host's scan_root" });
    const summaryText = await summary.getText();
    assert.match(summaryText, /폴더 5개/, `Unexpected module count: ${summaryText}`);
    assert.match(summaryText, /가져오기 연결 1개/, `Unexpected import edge count: ${summaryText}`);
    assert.match(summaryText, /파일 6개/, `Unexpected file count: ${summaryText}`);
    assert.deepEqual(await listing(repo), before, "The scan changed the scanned tree; the scanner must stay read-only");

    // Opening the proposal is not saving it. The .maru baseline is taken here,
    // after the scan and with the dialog still open, so only writes caused by
    // opening the proposal can change it.
    await browser.pause(3_000);
    const maruBefore = await listing(maruDir).catch(() => [] as string[]);
    await (await browser.$('[data-testid="diagram-scan-open"]')).click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 30_000 });
    // Wait past the 2.5 s auto-snapshot debounce: no history snapshot, settings
    // or workspace-state write may follow the opened proposal before Save.
    await browser.pause(4_000);
    const diagramsAfter = await fs.readdir(path.join(workspace, "diagrams")).catch(() => [] as string[]);
    assert.deepEqual(diagramsAfter.sort(), diagramsBefore.sort(), "Opening the proposal wrote a document; saving must stay the user's step");
    assert.deepEqual(await listing(maruDir).catch(() => [] as string[]), maruBefore, "Opening the proposal wrote under .maru (history or settings); nothing may be written before Save");
    assert.deepEqual(await listing(repo), before);
  }).timeout(180_000);
});
