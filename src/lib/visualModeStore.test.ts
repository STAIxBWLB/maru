import { describe, expect, it } from "vitest";

import { createVisualModeController } from "./visualModeStore";

describe("visualModeStore", () => {
  it("publishes Diagram updates only to Diagram subscribers", () => {
    const controller = createVisualModeController();
    let diagramUpdates = 0;
    let graphUpdates = 0;

    const unsubscribeDiagram = controller.subscribe("diagram", () => {
      diagramUpdates += 1;
    });
    const unsubscribeGraph = controller.subscribe("graph", () => {
      graphUpdates += 1;
    });

    controller.setDiagramActiveDocument({
      workPath: "/workspace",
      activeDocument: { path: "notes/diagram.md", title: "Diagram", body: "# Diagram", revision: 1 },
      recentDocuments: [],
    });

    expect(diagramUpdates).toBe(1);
    expect(graphUpdates).toBe(0);
    unsubscribeDiagram();
    unsubscribeGraph();
  });
});
