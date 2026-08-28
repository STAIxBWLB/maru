import { describe, expect, it } from "vitest";

import { getModeDescriptor, getRegisteredModeIds } from "./modeRegistry";

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

  it("registers Agents as a lazy surface in both workbench placements", () => {
    expect(getModeDescriptor("agents")).toMatchObject({
      id: "agents",
      placements: ["primary", "right"],
      fallback: "mode-loading",
    });
    expect(typeof getModeDescriptor("agents")?.load).toBe("function");
  });

  it("registers Inbox as a dedicated lazy surface in both workbench placements", () => {
    expect(getModeDescriptor("inbox")).toMatchObject({ id: "inbox", placements: ["primary", "right"] });
    expect(typeof getModeDescriptor("inbox")?.load).toBe("function");
  });

  it("registers Comms as a dedicated lazy surface in both workbench placements", () => {
    expect(getModeDescriptor("comms")).toMatchObject({ id: "comms", placements: ["primary", "right"] });
    expect(typeof getModeDescriptor("comms")?.load).toBe("function");
  });

  it("registers Meetings, Today, Tasks, and Dashboard as dedicated lazy planning surfaces", () => {
    for (const mode of ["meetings", "today", "tasks", "dashboard"] as const) {
      expect(getModeDescriptor(mode)).toMatchObject({ id: mode, fallback: "mode-loading" });
      expect(typeof getModeDescriptor(mode)?.load).toBe("function");
    }
  });

  it("registers Drafts and Gap as dedicated lazy surfaces in both workbench placements", () => {
    expect(getModeDescriptor("drafts")).toMatchObject({ id: "drafts", placements: ["primary", "right"] });
    expect(getModeDescriptor("gap")).toMatchObject({ id: "gap", placements: ["primary", "right"] });
    expect(typeof getModeDescriptor("drafts")?.load).toBe("function");
    expect(typeof getModeDescriptor("gap")?.load).toBe("function");
  });

  it("registers Files as a dedicated lazy surface in both workbench placements", () => {
    expect(getModeDescriptor("files")).toMatchObject({
      id: "files",
      placements: ["primary", "right"],
    });
    expect(typeof getModeDescriptor("files")?.load).toBe("function");
  });

  it("registers Studio and Catalog as dedicated lazy surfaces in both workbench placements", () => {
    expect(getModeDescriptor("studio")).toMatchObject({ id: "studio", placements: ["primary", "right"] });
    expect(getModeDescriptor("catalog")).toMatchObject({ id: "catalog", placements: ["primary", "right"] });
    expect(typeof getModeDescriptor("studio")?.load).toBe("function");
    expect(typeof getModeDescriptor("catalog")?.load).toBe("function");
  });

  it("covers every Maru app mode exactly once with a dedicated lazy descriptor", () => {
    expect(getRegisteredModeIds()).toEqual([
      "pkm", "scratchpad", "files", "inbox", "comms", "meetings", "today", "tasks", "dashboard",
      "catalog", "studio", "e2e", "diagram", "sites", "graph", "drafts", "gap", "agents",
    ]);
  });
});
