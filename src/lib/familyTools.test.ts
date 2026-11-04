import { describe, expect, it } from "vitest";
import { familyPackageCommand, type FamilyToolId } from "./familyTools";
import { createVisualModeController } from "./visualModeStore";
import { ACON_SITE_LAUNCH } from "./sites";
describe("family tool handoffs", () => {
  it("pins exact supported package versions and refuses shell-shaped input", () => {
    expect(familyPackageCommand("acon", "0.1.1")).toBe("bun add -g @staix/agent-console@0.1.1");
    expect(familyPackageCommand("sh" as FamilyToolId, "1.0.0")).toBeNull();
    for (const version of [null, "latest", "1.0.0; touch /tmp/x", "1.0.0-beta", "$(echo x)"]) expect(familyPackageCommand("amem", version)).toBeNull();
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
