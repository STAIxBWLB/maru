import { describe, expect, it } from "vitest";

import { getModeDescriptor } from "./modeRegistry";

describe("modeRegistry", () => {
  it("registers PKM as a primary-only lazy surface with a stable fallback identity", () => {
    const descriptor = getModeDescriptor("pkm");

    expect(descriptor).toMatchObject({
      id: "pkm",
      placements: ["primary"],
      fallback: "mode-loading",
    });
    expect(typeof descriptor?.load).toBe("function");
    expect(descriptor?.isAvailable()).toBe(true);
  });

  it("keeps E2E lazy, feature-gated, and available in both workbench placements", () => {
    const descriptor = getModeDescriptor("e2e");

    expect(descriptor).toMatchObject({
      id: "e2e",
      placements: ["primary", "right"],
      fallback: "mode-loading",
    });
    expect(typeof descriptor?.load).toBe("function");
  });

  it("registers Diagram as a primary/right lazy surface without moving rail metadata", () => {
    const descriptor = getModeDescriptor("diagram");

    expect(descriptor).toMatchObject({
      id: "diagram",
      placements: ["primary", "right"],
      fallback: "mode-loading",
    });
    expect(typeof descriptor?.load).toBe("function");
  });
});
