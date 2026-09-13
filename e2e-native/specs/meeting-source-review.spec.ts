import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {} from "webdriverio";

import { fixtureRootDir } from "../helpers/fixtureWorkspace";

const plaudNote = [
  "# 제품 전략 회의",
  "참석자: 김민서(제품팀), 박준호(파트너사)",
  "김민서: 9월 출시 범위를 확정한다.",
  "박준호: 베타 일정은 9월 18일로 제안했다.",
  "결정: 다음 회의 전까지 비용안을 검토한다.",
].join("\n");
const correction = "추가 확인: 비용안 담당자는 다음 회의에서 확정한다.";

async function waitFor(selector: string, timeout = 30_000): Promise<void> {
  const ready = await browser.executeAsync(
    (target: string, limit: number, done: (value: boolean) => void) => {
      const deadline = Date.now() + limit;
      const tick = () => {
        const element = document.querySelector(target);
        if (element && (element instanceof HTMLElement ? element.offsetParent !== null : true)) {
          done(true);
          return;
        }
        if (Date.now() >= deadline) {
          done(false);
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    },
    selector,
    timeout,
  );
  assert.equal(ready, true, `timed out waiting for ${selector}`);
}

async function click(selector: string): Promise<void> {
  await browser.execute((target: string) => {
    const element = document.querySelector<HTMLElement>(target);
    if (!element) throw new Error(`missing ${target}`);
    element.click();
  }, selector);
}

async function fill(selector: string, value: string): Promise<void> {
  const element = await browser.$(selector);
  await element.waitForDisplayed({ timeout: 30_000 });
  await element.setValue(value);
}

async function stateFile(): Promise<string> {
  const root = path.join(fixtureRootDir(), "workspace", ".maru", "meetings", "source-reviews");
  const entries = await fs.readdir(root);
  const session = entries.find((entry) => entry !== "correction-examples.json");
  assert.ok(session, `no source-review session under ${root}`);
  return path.join(root, session, "state.json");
}

async function waitForState(
  file: string,
  predicate: (state: { versions?: unknown[]; confirmedVersionId?: string }) => boolean,
  timeout = 30_000,
): Promise<{ versions?: unknown[]; confirmedVersionId?: string }> {
  const deadline = Date.now() + timeout;
  let latest: { versions?: unknown[]; confirmedVersionId?: string } = {};
  while (Date.now() < deadline) {
    try {
      latest = JSON.parse(await fs.readFile(file, "utf8")) as typeof latest;
      if (predicate(latest)) return latest;
    } catch {
      // The atomic state file may be between creation and its first rename.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`timed out waiting for durable state update in ${file}`);
}

describe("native Plaud meeting-note source review", () => {
  it("persists the original, corrected version, participant context, and confirmation", async () => {
    await waitFor(".activity-rail");
    await click('.activity-rail button[aria-label="회의록"]');
    await waitFor(".meetings-pane");
    // The external item is first in the create group. Use its text-bearing
    // button directly so this remains valid for both Korean and English UI.
    await browser.execute(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".meetings-sidebar-item")]
        .find((item) => /외부 회의록 교정|Review external meeting note/.test(item.textContent ?? ""));
      if (!button) throw new Error("external meeting-note review item is missing");
      button.click();
    });
    await waitFor(".meeting-source-create");
    await fill(".meeting-source-create textarea", plaudNote);
    await click(".meeting-source-create button");
    await waitFor(".meeting-source-editors");

    const editors = await browser.$$(".meeting-source-editors textarea");
    assert.equal(await editors.length, 2, "source review must show original and corrected editors");
    assert.equal(await editors[0].getValue(), plaudNote);
    await editors[1].setValue(`${plaudNote}\n${correction}`);

    await browser.execute(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".meeting-source-context button")]
        .find((item) => /참석자 추가|Add participant/.test(item.textContent ?? ""));
      if (!button) throw new Error("add participant button is missing");
      button.click();
    });
    await fill('.meeting-source-person input', "김민서");
    await click('.meeting-source-person button.certainty');
    await fill('.meeting-source-context-label textarea', "9월 출시 범위를 결정하는 제품 전략 회의");
    await click('.meeting-source-editors + .meeting-source-reference-import summary');
    await fill('.meeting-source-reference-import textarea', "참고 녹취록: 비용안은 다음 회의에서 확정");
    await click('.meeting-source-reference-import button');

    await fill('.meeting-source-version-bar input', "비용안 담당자 확정 여부를 원문과 구분해 기록");
    await waitFor('.meeting-source-editor-body:not([disabled])');
    await click('.meeting-source-version-bar button');
    await waitFor('.save-state:not(.dirty)');

    const statePath = await stateFile();
    const state = await waitForState(statePath, (value) => (value.versions?.length ?? 0) >= 1) as {
      draft: { sources: Array<{ originalText: string; text: string; originalHash: string }>; participants: Array<{ name: string }>; context?: string };
      versions: Array<{ draft: { sources: Array<{ text: string }> } }>;
      confirmedVersionId?: string;
    };
    const source = state.draft.sources[0];
    assert.equal(source.originalText, plaudNote);
    assert.equal(source.text, `${plaudNote}\n${correction}`);
    assert.equal(source.originalHash, createHash("sha256").update(plaudNote).digest("hex"));
    assert.equal(state.draft.context, "9월 출시 범위를 결정하는 제품 전략 회의");
    assert.ok(state.versions.length >= 1, "saving a version must create a durable checkpoint");

    const checks = await browser.$$(".meeting-source-check input[type=checkbox]");
    assert.ok((await checks.length) >= 2, "participant and note review acknowledgements are required");
    for (const checkbox of checks) {
      if (!(await checkbox.isSelected())) await checkbox.click();
    }
    await click(".meeting-source-review-button");
    await waitFor(".meeting-source-sessions");

    const confirmed = await waitForState(statePath, (value) => Boolean(value.confirmedVersionId)) as typeof state;
    assert.ok(confirmed.confirmedVersionId, "confirmation must pin an immutable version");
    const confirmedVersion = confirmed.versions.find((version) =>
      version.draft.sources[0]?.text.includes(correction),
    );
    assert.ok(confirmedVersion, "the confirmed immutable snapshot must include the correction");

    // Reopen the native webview and prove the file-backed review survives a
    // real application reload with the original still beside the correction.
    await browser.reloadSession();
    await waitFor(".activity-rail");
    await click('.activity-rail button[aria-label="회의록"]');
    await waitFor(".meetings-pane");
    await click('.meetings-sidebar-item button, .meetings-sidebar-item');
    await waitFor(".meeting-source-editors");
    const reopened = await browser.$$(".meeting-source-editors textarea");
    assert.equal(await reopened[0].getValue(), plaudNote);
    assert.equal(await reopened[1].getValue(), `${plaudNote}\n${correction}`);
  }).timeout(180_000);
});
