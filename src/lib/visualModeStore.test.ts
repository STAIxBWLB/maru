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
      activeDocument: { path: "notes/diagram.md", title: "Diagram", revision: "revision-1" },
      recentDocuments: [],
    });

    expect(diagramUpdates).toBe(1);
    expect(graphUpdates).toBe(0);
    unsubscribeDiagram();
    unsubscribeGraph();
  });

  it("keeps Graph focus and Sites request queues isolated and acknowledges each request once", () => {
    const controller = createVisualModeController();
    let graphUpdates = 0;
    let siteUpdates = 0;
    const unsubscribeGraph = controller.subscribe("graph", () => {
      graphUpdates += 1;
    });
    const unsubscribeSites = controller.subscribe("sites", () => {
      siteUpdates += 1;
    });

    controller.setGraphFocusTarget({ source: "workspace", localTarget: { ownerWorkspacePath: null, relPath: "notes/a.md" } });
    controller.enqueueSiteUrls(["https://example.com", "https://example.com/docs"]);
    const requests = controller.getSitesModeSlice().openedUrls;
    controller.acknowledgeSiteUrls([requests[0]!.id]);

    expect(graphUpdates).toBe(1);
    expect(siteUpdates).toBe(2);
    expect(controller.getSitesModeSlice().openedUrls).toEqual([requests[1]]);
    unsubscribeGraph();
    unsubscribeSites();
  });
});
