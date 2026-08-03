import { describe, expect, it } from "vitest";
import { bootAppMode } from "./startupAppMode";
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
