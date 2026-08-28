import { describe, expect, it } from "vitest";

import {
  getShellSettings,
  hydrateShellSettings,
  resetShellSettingsStoreForTests,
  updateShellSettings,
} from "./shellSettingsStore";
import { DEFAULT_MARU_SETTINGS, serializeMaruSettings } from "./settings";

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
});
