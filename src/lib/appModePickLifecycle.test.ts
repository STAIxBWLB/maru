import { describe, expect, it } from "vitest";

import {
  pickSurvivesSettingsPathChange,
  shouldReapplyAppModePick,
  withActiveAppMode,
} from "./appModePickLifecycle";
import { DEFAULT_MARU_SETTINGS } from "./settings";

describe("withActiveAppMode", () => {
  it("patches the active mode without touching other ui settings", () => {
    const next = withActiveAppMode(DEFAULT_MARU_SETTINGS, "meetings");
    expect(next.ui.activeAppMode).toBe("meetings");
    expect(next.ui.explorerPaneMode).toBe(DEFAULT_MARU_SETTINGS.ui.explorerPaneMode);
    expect(next.tasks).toBe(DEFAULT_MARU_SETTINGS.tasks);
  });

  it("maps the explorer pane for the files and pkm modes", () => {
    expect(withActiveAppMode(DEFAULT_MARU_SETTINGS, "files").ui.explorerPaneMode).toBe("files");
    expect(withActiveAppMode(DEFAULT_MARU_SETTINGS, "pkm").ui.explorerPaneMode).toBe("documents");
  });
});

describe("pickSurvivesSettingsPathChange", () => {
  it("survives the boot transition from no settings path", () => {
    expect(pickSurvivesSettingsPathChange(null, "/work/a")).toBe(true);
  });

  it("survives a same-path re-render", () => {
    expect(pickSurvivesSettingsPathChange("/work/a", "/work/a")).toBe(true);
  });

  it("does not survive a workspace switch", () => {
    expect(pickSurvivesSettingsPathChange("/work/a", "/work/b")).toBe(false);
    expect(pickSurvivesSettingsPathChange("/work/a", null)).toBe(false);
  });
});

describe("shouldReapplyAppModePick", () => {
  const base = {
    settingsWorkPath: "/work/a",
    settingsWritable: true,
    storedAppMode: "pkm",
  } as const;

  it("does nothing without a pending pick or a settings path", () => {
    expect(shouldReapplyAppModePick({ ...base, picked: null })).toBe(false);
    expect(shouldReapplyAppModePick({ ...base, picked: "meetings", settingsWorkPath: null })).toBe(false);
  });

  it("re-applies while the stored settings still differ from the pick", () => {
    expect(shouldReapplyAppModePick({ ...base, picked: "meetings" })).toBe(true);
    expect(
      shouldReapplyAppModePick({ ...base, picked: "meetings", settingsWritable: false }),
    ).toBe(true);
  });

  it("re-applies an already-matching pick once a save is possible", () => {
    // The pick reached the in-memory settings before they were writable but
    // never reached disk; a writable settings path means save it now.
    expect(shouldReapplyAppModePick({ ...base, picked: "pkm" })).toBe(true);
  });

  it("leaves read-only settings alone once they already show the pick", () => {
    expect(
      shouldReapplyAppModePick({ ...base, picked: "pkm", settingsWritable: false }),
    ).toBe(false);
  });
});
