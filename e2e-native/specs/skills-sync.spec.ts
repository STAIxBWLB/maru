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
    const result = await browser.executeAsync((sourceId: string, done: (result: { ok: boolean; stage: string; log: string; notice?: string; syncClicks?: number; noticeCount?: number }) => void) => {
      let stage = "settings";
      let syncClicks = 0;
      // Return diagnostic state before WebDriver can replay the UI script.
      const deadline = Date.now() + 25_000;
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
          if (sync) { syncClicks += 1; sync.click(); stage = "confirm"; }
        } else if (stage === "confirm") {
          const proceed = buttons.find((button) => button.closest('[role="dialog"]') && button.textContent?.trim() === "진행");
          if (proceed) { proceed.click(); stage = "completion"; }
        } else {
          const log = document.querySelector(".skills-operation")?.textContent ?? "";
// IPC settlement and event delivery have no final-event ordering contract.
          // The notice plus persisted Git result is the completion authority.
          const notices = document.querySelectorAll("[data-skill-operation]");
          const notice = notices[0]?.textContent ?? "";
          if (log.includes("[info]") && log.includes(sourceId) && notice.includes(sourceId) && notice.includes("동기화를 완료")) {
            clearInterval(timer); done({ ok: true, stage, log, notice, syncClicks, noticeCount: notices.length }); return;
          }
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          done({ ok: false, stage, log: document.body.innerText.slice(-6000) });
        }
      }, 100);
    }, FIXTURE_SKILL_SOURCE);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.syncClicks, 1);
    assert.equal(result.noticeCount, 1);
    const after = await readFixtureSkillRegistry();
    assert.ok(after.sources.find((source) => source.id === FIXTURE_SKILL_SOURCE)?.lastSyncedAt);
    assert.ok(after.skills.some((skill) => skill.sourceId === FIXTURE_SKILL_SOURCE && skill.title === FIXTURE_SKILL_TITLE && skill.valid));
    const home = process.env.MARU_NATIVE_E2E_HOME;
    assert.ok(home);
    const realHome = await fs.realpath(home);
    for (const source of after.sources) {
      assert.ok(source.path);
      const relative = path.relative(realHome, await fs.realpath(source.path));
      assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), "every discovered source must stay inside the native fixture home");
    }
    // Preserve synthetic evidence outside the disposable run root.
    const evidenceDir = path.resolve("test-results/native-e2e");
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, "phase08-01-skills-sync.json"), JSON.stringify({
      sourceId: FIXTURE_SKILL_SOURCE, title: FIXTURE_SKILL_TITLE,
      realGit: true, persisted: true, fixtureHomeOnly: true, progress: result.log, successNotice: result.notice, syncClicks: result.syncClicks, noticeCount: result.noticeCount,
    }, null, 2));
  });
});
