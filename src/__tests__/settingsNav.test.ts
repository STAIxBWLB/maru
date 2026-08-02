import { describe, expect, it } from "vitest";

import { t } from "../lib/i18n";
import {
  SETTINGS_NAV,
  SETTINGS_NAV_GROUPS,
  isSettingsTabId,
} from "../components/settings/settingsNav";

describe("settingsNav", () => {
  it("gives every nav id ko + en labels and a valid group", () => {
    for (const item of SETTINGS_NAV) {
      expect(t("ko", item.labelKey), item.labelKey).not.toBe(item.labelKey);
      expect(t("en", item.labelKey), item.labelKey).not.toBe(item.labelKey);
      expect(SETTINGS_NAV_GROUPS).toContain(item.group);
    }
  });

  it("gives every group ko + en labels", () => {
    for (const group of SETTINGS_NAV_GROUPS) {
      const key = `system.group.${group}`;
      expect(t("ko", key), key).not.toBe(key);
      expect(t("en", key), key).not.toBe(key);
    }
  });

  it("isSettingsTabId accepts exactly the nav ids", () => {
    for (const item of SETTINGS_NAV) {
      expect(isSettingsTabId(item.id)).toBe(true);
    }
    expect(isSettingsTabId("not-a-tab")).toBe(false);
    expect(isSettingsTabId(null)).toBe(false);
    expect(isSettingsTabId(undefined)).toBe(false);
    // No duplicates: the accepted set is exactly the array's ids.
    expect(new Set(SETTINGS_NAV.map((item) => item.id)).size).toBe(SETTINGS_NAV.length);
  });
});
