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

  it("registers Graph and Sites as separate lazy surfaces in their required placements", () => {
    expect(getModeDescriptor("graph")).toMatchObject({
      id: "graph",
      placements: ["primary", "right", "panel"],
      fallback: "mode-loading",
    });
    expect(getModeDescriptor("sites")).toMatchObject({
      id: "sites",
      placements: ["primary", "right"],
      fallback: "mode-loading",
    });
    expect(typeof getModeDescriptor("graph")?.load).toBe("function");
    expect(typeof getModeDescriptor("sites")?.load).toBe("function");
  });

  it("registers Agents as a primary-only lazy surface", () => {
    expect(getModeDescriptor("agents")).toMatchObject({
      id: "agents",
      placements: ["primary"],
      fallback: "mode-loading",
    });
    expect(typeof getModeDescriptor("agents")?.load).toBe("function");
  });

  it("registers Inbox as a dedicated primary lazy surface", () => {
    expect(getModeDescriptor("inbox")).toMatchObject({ id: "inbox", placements: ["primary"] });
    expect(typeof getModeDescriptor("inbox")?.load).toBe("function");
  });

  it("registers Comms as a dedicated primary lazy surface", () => {
    expect(getModeDescriptor("comms")).toMatchObject({ id: "comms", placements: ["primary"] });
    expect(typeof getModeDescriptor("comms")?.load).toBe("function");
  });
});
