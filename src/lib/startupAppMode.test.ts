import { describe, expect, it } from "vitest";
import { applyStoredAppMode, bootAppMode } from "./startupAppMode";
import type { MaruAppMode } from "./settings";

describe("bootAppMode", () => {
  it("keeps the stored mode in the default build", () => {
    for (const storedMode of ["pkm", "files", "tasks", "sites"] as MaruAppMode[]) {
      expect(bootAppMode({ storedMode, browserPasskeyBuild: false })).toBe(storedMode);
    }
  });

  it("starts the provisioned passkey build on the Sites browser surface", () => {
    for (const storedMode of ["pkm", "files", "tasks", "graph"] as MaruAppMode[]) {
      expect(bootAppMode({ storedMode, browserPasskeyBuild: true })).toBe("sites");
    }
  });
});

describe("applyStoredAppMode", () => {
  it("applies the stored mode when no pick is pending", () => {
    const pick: { current: MaruAppMode | null } = { current: null };
    expect(applyStoredAppMode(pick, "tasks")).toBe("tasks");
    expect(pick.current).toBeNull();
  });

  it("keeps a pending pick over a stale stored mode", () => {
    const pick: { current: MaruAppMode | null } = { current: "meetings" };
    expect(applyStoredAppMode(pick, "pkm")).toBe("meetings");
    expect(pick.current).toBe("meetings");
  });

  it("lifts the guard once the stored settings catch up with the pick", () => {
    const pick: { current: MaruAppMode | null } = { current: "meetings" };
    expect(applyStoredAppMode(pick, "meetings")).toBe("meetings");
    expect(pick.current).toBeNull();
    expect(applyStoredAppMode(pick, "pkm")).toBe("pkm");
  });
});
