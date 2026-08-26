import { describe, expect, it, vi } from "vitest";

import { createDocumentOpsModeController } from "./documentOpsModeStore";

describe("documentOpsModeStore", () => {
  it("rejects stale Files preview results and keeps selection-local state immutable", () => {
    const controller = createDocumentOpsModeController();
    const notify = vi.fn();
    controller.subscribe("files", notify);

    const first = controller.beginFilesPreview("first.md");
    const second = controller.beginFilesPreview("second.md");

    expect(controller.resolveFilesPreview(first, { path: "first.md", content: "old" })).toBe(false);
    expect(controller.resolveFilesPreview(second, { path: "second.md", content: "current" })).toBe(true);
    expect(controller.getFilesSlice()).toMatchObject({
      selectedPath: "second.md",
      preview: { path: "second.md", content: "current" },
    });
    expect(Object.isFrozen(controller.getFilesSlice())).toBe(true);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("publishes Files, Studio, and Catalog domains independently", () => {
    const controller = createDocumentOpsModeController();
    const files = vi.fn();
    const studio = vi.fn();
    const catalog = vi.fn();
    controller.subscribe("files", files);
    controller.subscribe("studio", studio);
    controller.subscribe("catalog", catalog);

    controller.publishFiles({ filter: "notes" });
    expect(files).toHaveBeenCalledOnce();
    expect(studio).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();

    controller.publishStudio({ workspacePath: "/workspace" });
    expect(studio).toHaveBeenCalledOnce();
    expect(catalog).not.toHaveBeenCalled();

    controller.publishCatalog({ workspacePath: "/workspace" });
    expect(catalog).toHaveBeenCalledOnce();
  });
});
