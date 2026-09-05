import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import { FIXTURE_SKILL_SOURCE, FIXTURE_SKILL_TITLE, readFixtureSkillRegistry } from "../helpers/fixtureWorkspace";

describe("native Skills synchronization", () => {
  it("syncs a changed local Git skill through the existing Skills control", async () => {
    const before = await readFixtureSkillRegistry();
    assert.ok(before.sources.some((source) => source.id === FIXTURE_SKILL_SOURCE));
    assert.ok(!before.skills.some((skill) => skill.title === FIXTURE_SKILL_TITLE));
    const result = await browser.executeAsync((sourceId: string, done: (result: { ok: boolean; stage: string; log: string }) => void) => {
      let stage = "settings";
      const deadline = Date.now() + 60_000;
      const timer = setInterval(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
        if (stage === "settings") {
          const settings = document.querySelector<HTMLButtonElement>('.activity-rail button[aria-label="설정"]');
          if (settings) { settings.click(); stage = "skills"; }
        } else if (stage === "skills") {
          const tab = buttons.find((button) => button.getAttribute("role") === "tab" && button.textContent?.trim() === "Skills");
          if (tab) { tab.click(); stage = "source"; }
        } else if (stage === "source") {
          const card = Array.from(document.querySelectorAll(".source-card")).find((element) => element.querySelector(".system-skill-name")?.textContent === sourceId);
          const sync = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent?.trim() === "Sync" && !button.disabled);
          if (sync) { sync.click(); stage = "confirm"; }
        } else if (stage === "confirm") {
          const proceed = buttons.find((button) => button.closest('[role="dialog"]') && button.textContent?.trim() === "진행");
          if (proceed) { proceed.click(); stage = "completion"; }
        } else {
          const log = document.querySelector(".skills-operation")?.textContent ?? "";
          if (log.includes(`Git pull complete for ${sourceId}`) && log.includes(`Sync complete for ${sourceId}`)) {
            clearInterval(timer); done({ ok: true, stage, log }); return;
          }
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          done({ ok: false, stage, log: document.body.innerText.slice(-6000) });
        }
      }, 100);
    }, FIXTURE_SKILL_SOURCE);
    assert.equal(result.ok, true, JSON.stringify(result));
    const after = await readFixtureSkillRegistry();
    assert.ok(after.sources.find((source) => source.id === FIXTURE_SKILL_SOURCE)?.lastSyncedAt);
    assert.ok(after.skills.some((skill) => skill.sourceId === FIXTURE_SKILL_SOURCE && skill.title === FIXTURE_SKILL_TITLE));
    // Preserve synthetic evidence outside the disposable run root.
    const evidenceDir = path.resolve("test-results/native-e2e");
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, "phase08-01-skills-sync.json"), JSON.stringify({
      sourceId: FIXTURE_SKILL_SOURCE, title: FIXTURE_SKILL_TITLE,
      realGit: true, persisted: true, progress: result.log,
    }, null, 2));
  });
});
