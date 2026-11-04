import { describe, expect, it } from "vitest";
import { familyPackageCommand, familyRollbackCommand, type FamilyToolId, type FamilyToolStatus } from "./familyTools";
import { createVisualModeController } from "./visualModeStore";
import { ACON_SITE_LAUNCH } from "./sites";
describe("family tool handoffs", () => {
  it("pins exact supported package versions and refuses shell-shaped input", () => {
    expect(familyPackageCommand("acon", "0.1.1", "dot-family")).toBe("dot ai family install acon --version 0.1.1");
    expect(familyPackageCommand("sh" as FamilyToolId, "1.0.0", "dot-family")).toBeNull();
    for (const version of [null, "latest", "1.0.0; touch /tmp/x", "1.0.0-beta", "$(echo x)"]) expect(familyPackageCommand("amem", version, "dot-family")).toBeNull();
  });
  it("routes update and recovery handoffs to the owning manager only", () => {
    expect(familyPackageCommand("ahub", "0.30.0", "ahub-upgrade")).toBe("ahub upgrade --to 0.30.0");
    expect(familyPackageCommand("vmem", "0.4.0", "bun-global")).toBe("dot ai family install vmem --version 0.4.0");
    expect(familyPackageCommand("vmem", "0.4.0", "external")).toBeNull();
    expect(familyRollbackCommand({ id: "vmem", ownership: "dot-family", previousVersion: "0.3.3" } as FamilyToolStatus)).toBe("dot ai rollback vmem");
    expect(familyRollbackCommand({ id: "vmem", ownership: "external", previousVersion: "0.3.3" } as FamilyToolStatus)).toBeNull();
  });
  it("queues only the fixed console launcher without executing it or changing ordinary URL requests", () => {
    const controller = createVisualModeController();
    controller.enqueueSiteUrls(["https://example.com"]);
    controller.enqueueFamilyConsole();
    expect(controller.getSitesModeSlice().openedUrls).toEqual([{ id: 1, url: "https://example.com" }, { id: 2, url: "http://127.0.0.1", launch: ACON_SITE_LAUNCH }]);
    controller.acknowledgeSiteUrls([1,2]);
    expect(controller.getSitesModeSlice().openedUrls).toEqual([]);
    controller.enqueueFamilyConsole();
    expect(controller.getSitesModeSlice().openedUrls[0].id).toBe(3);
  });
});
