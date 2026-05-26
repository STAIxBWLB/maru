import { describe, expect, it } from "vitest";

import {
  DIAGRAM_SCHEMA_VERSION,
  createEmptyDoc,
  createInitialEphemeral,
} from "./types";

describe("diagram types", () => {
  it("createEmptyDoc fills the v:7 envelope", () => {
    const doc = createEmptyDoc("doc-1", 1700000000000);
    expect(doc.v).toBe(DIAGRAM_SCHEMA_VERSION);
    expect(doc.v).toBe(7);
    expect(doc.id).toBe("doc-1");
    expect(doc.createdAt).toBe(1700000000000);
    expect(doc.updatedAt).toBe(1700000000000);
    expect(doc.nodes).toEqual([]);
    expect(doc.edges).toEqual([]);
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0]?.id).toBe("default");
  });

  it("createInitialEphemeral seeds reasonable UI defaults", () => {
    const ephemeral = createInitialEphemeral();
    expect(ephemeral.tool).toBe("select");
    expect(ephemeral.viewport.zoom).toBe(1);
    expect(ephemeral.ui.snapSize).toBe(10);
    expect(ephemeral.ui.activeRibbon).toBe("edit");
    expect(ephemeral.selection.nodes.size).toBe(0);
    expect(ephemeral.selection.edges.size).toBe(0);
  });
});
