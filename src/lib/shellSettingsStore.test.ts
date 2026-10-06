import { beforeEach, describe, expect, it } from "vitest";

import {
  applyIncomingShellSettings,
  bindShellSettingsRead,
  captureShellSettingsRevision,
  getPendingShellSettingsRevision,
  getShellSettingsSaveOrigin,
  getShellSettingsReadOrigin,
  getShellSettings,
  hydrateShellSettings,
  resetShellSettingsStoreForTests,
  updateShellSettings,
  shellSettingsSaveBase,
} from "./shellSettingsStore";
import { DEFAULT_MARU_SETTINGS, normalizeMaruSettings, serializeMaruSettings, type MaruSettings } from "./settings";
import { createContextualDebouncedSaver } from "./debouncedSave";

function layout(patch: Partial<MaruSettings["ui"]["layout"]>): MaruSettings {
  return updateShellSettings((current) => ({ ...current, ui: { ...current.ui, layout: { ...current.ui.layout, ...patch } } }));
}
function copied(value: MaruSettings): MaruSettings { return normalizeMaruSettings(value); }
beforeEach(() => resetShellSettingsStoreForTests());

describe("shellSettingsStore", () => {
  it("keeps existing normalized settings keys through a same-key update", () => {
    resetShellSettingsStoreForTests();
    const before = getShellSettings();

    updateShellSettings((current) => ({
      ...current,
      ui: { ...current.ui, themeMode: "dark" },
    }));

    const after = getShellSettings();
    expect(after.ui.themeMode).toBe("dark");
    expect(Object.keys(serializeMaruSettings(after) as object)).toEqual(
      Object.keys(serializeMaruSettings(before) as object),
    );
  });

  it("rejects hydration from an obsolete workspace request", () => {
    resetShellSettingsStoreForTests();
    const applied = hydrateShellSettings(
      { ...DEFAULT_MARU_SETTINGS, ui: { ...DEFAULT_MARU_SETTINGS.ui, themeMode: "dark" } },
      4,
      5,
    );

    expect(applied).toBe(false);
    expect(getShellSettings().ui.themeMode).toBe(DEFAULT_MARU_SETTINGS.ui.themeMode);
  });

  it("keeps explicit default mode and layout through unacknowledged hydration, preserving other domains", () => {
    updateShellSettings((current) => current, ["ui.activeAppMode"]);
    layout({ terminalSplitOpen: true });
    const incoming = copied(DEFAULT_MARU_SETTINGS);
    incoming.ui.activeAppMode = "today";
    incoming.ui.themeMode = "dark";
    incoming.ui.collapsedTreeFolders = ["incoming-workspace-folder"];
    incoming.ui.layout.outlineOpen = !DEFAULT_MARU_SETTINGS.ui.layout.outlineOpen;
    const effective = applyIncomingShellSettings(incoming);
    expect(effective.ui.activeAppMode).toBe("pkm");
    expect(effective.ui.layout.terminalSplitOpen).toBe(true);
    expect(effective.ui.layout.outlineOpen).toBe(incoming.ui.layout.outlineOpen);
    expect(effective.ui.collapsedTreeFolders).toEqual(["incoming-workspace-folder"]);
    expect(effective.ui.themeMode).toBe("dark");
    expect(getPendingShellSettingsRevision()).toBeGreaterThan(0);
  });

  it("does not let an old matching ABA echo acknowledge the latest intent", () => {
    const firstOn = layout({ terminalSplitOpen: true });
    layout({ terminalSplitOpen: false });
    const latestOn = layout({ terminalSplitOpen: true });
    applyIncomingShellSettings(copied(firstOn), getShellSettingsSaveOrigin(firstOn));
    expect(getPendingShellSettingsRevision()).toBe(getShellSettingsSaveOrigin(latestOn)!.revision);
    applyIncomingShellSettings(copied(DEFAULT_MARU_SETTINGS));
    expect(getShellSettings().ui.layout.terminalSplitOpen).toBe(true);
    applyIncomingShellSettings(copied(latestOn), getShellSettingsSaveOrigin(latestOn));
    expect(getPendingShellSettingsRevision()).toBe(0);
    applyIncomingShellSettings(copied(DEFAULT_MARU_SETTINGS));
    expect(getShellSettings().ui.layout.terminalSplitOpen).toBe(false);
  });

  it("rejects a late read begun before a local write even after its acknowledgement", () => {
    const start = captureShellSettingsRevision();
    const late = bindShellSettingsRead(copied(DEFAULT_MARU_SETTINGS), start);
    const on = layout({ terminalSplitOpen: true });
    applyIncomingShellSettings(copied(on), getShellSettingsSaveOrigin(on));
    expect(getPendingShellSettingsRevision()).toBe(0);
    applyIncomingShellSettings(late);
    expect(getShellSettings().ui.layout.terminalSplitOpen).toBe(true);
  });

  it("uses serialized read origins only as fences, never as save acknowledgements", () => {
    const chosen = layout({ terminalSplitOpen: true });
    const read = bindShellSettingsRead(copied(chosen), captureShellSettingsRevision());
    const serialized = JSON.parse(JSON.stringify(read)) as MaruSettings;
    applyIncomingShellSettings(serialized, undefined, getShellSettingsReadOrigin(read));
    expect(getPendingShellSettingsRevision()).toBeGreaterThan(0);
    applyIncomingShellSettings(serialized, { actorId: "another-window", revision: 1000 });
    expect(getPendingShellSettingsRevision()).toBeGreaterThan(0);
    applyIncomingShellSettings(serialized, getShellSettingsSaveOrigin(chosen));
    expect(getPendingShellSettingsRevision()).toBe(0);
  });

  it("learns the actual Today baseline for an explicit unchanged Documents pick before hydration", () => {
    const started = captureShellSettingsRevision();
    const first = updateShellSettings((current) => current, ["ui.activeAppMode"]);
    const oldRevision = getShellSettingsSaveOrigin(first)!.revision;
    const disk = copied(DEFAULT_MARU_SETTINGS);
    disk.ui.activeAppMode = "today";
    applyIncomingShellSettings(bindShellSettingsRead(disk, started));
    expect(getShellSettings().ui.activeAppMode).toBe("pkm");
    expect(getPendingShellSettingsRevision()).toBeGreaterThan(oldRevision);
    const retry = updateShellSettings((current) => current);
    expect(shellSettingsSaveBase(first, retry).ui.activeAppMode).toBe("today");
    expect(retry.ui.activeAppMode).toBe("pkm");
    // Learning must not mutate the first scheduled snapshot's guessed base.
    expect(shellSettingsSaveBase(DEFAULT_MARU_SETTINGS, first).ui.activeAppMode).toBe("pkm");
    const learnedRevision = getPendingShellSettingsRevision();
    applyIncomingShellSettings(bindShellSettingsRead(copied(disk), started));
    expect(getPendingShellSettingsRevision()).toBe(learnedRevision);
    applyIncomingShellSettings(copied(retry), getShellSettingsSaveOrigin(retry));
    expect(getPendingShellSettingsRevision()).toBe(0);
  });

  it("binds the latest coalesced value to its own origin and pending base, not the first context", async () => {
    const seen: Array<{ revision: number; baseSplit: boolean; firstContext: string }> = [];
    const saver = createContextualDebouncedSaver<MaruSettings, { base: MaruSettings; name: string }>(async (value, context) => {
      seen.push({ revision: getShellSettingsSaveOrigin(value)!.revision, baseSplit: shellSettingsSaveBase(context.base, value).ui.layout.terminalSplitOpen, firstContext: context.name });
      applyIncomingShellSettings(copied(value), getShellSettingsSaveOrigin(value));
    }, 60_000);
    const base = getShellSettings();
    const first = layout({ terminalSplitOpen: true });
    saver.schedule(first, { base, name: "first" });
    layout({ terminalSplitOpen: false });
    const last = layout({ terminalSplitOpen: true });
    saver.schedule(last, { base: first, name: "last" });
    await saver.flush();
    expect(seen).toEqual([{ revision: getShellSettingsSaveOrigin(last)!.revision, baseSplit: false, firstContext: "first" }]);
    expect(getPendingShellSettingsRevision()).toBe(0);
    saver.cancel();
  });

  it("keeps a queued split visible while an earlier open-save echo settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const afterOldEcho: boolean[] = [];
    let count = 0;
    const saver = createContextualDebouncedSaver<MaruSettings, MaruSettings>(async (value) => {
      count += 1;
      if (count === 1) { started(); await blocked; }
      applyIncomingShellSettings(copied(value), getShellSettingsSaveOrigin(value));
      afterOldEcho.push(getShellSettings().ui.layout.terminalSplitOpen);
    }, 60_000);
    const before = getShellSettings();
    const opened = layout({ terminalOpen: true });
    saver.schedule(opened, before);
    const firstFlush = saver.flush();
    await begun;
    const split = layout({ terminalSplitOpen: true });
    saver.schedule(split, opened);
    const secondFlush = saver.flush();
    release();
    await Promise.all([firstFlush, secondFlush]);
    expect(afterOldEcho).toEqual([true, true]);
    expect(getPendingShellSettingsRevision()).toBe(0);
    saver.cancel();
  });
});
