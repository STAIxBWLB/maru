import { describe, expect, it } from "vitest";

import { exportJson, suggestedFileName } from "./export";
import { DIAGRAM_SCHEMA_VERSION, createEmptyDoc } from "./types";

describe("export helpers", () => {
  it("suggestedFileName slugifies the docTitle and appends ext", () => {
    const doc = createEmptyDoc("doc", 1);
    doc.docTitle = "  Project / Plan v2 !! ";
    expect(suggestedFileName(doc, "png")).toMatch(/^Project-Plan-v2\.png$/);
  });

  it("suggestedFileName falls back when title is empty", () => {
    const doc = createEmptyDoc("doc", 1);
    expect(suggestedFileName(doc, "svg")).toBe("diagram.svg");
  });

  it("exportJson returns a JSON blob with the doc body", async () => {
    const doc = createEmptyDoc("doc", 1);
    doc.docTitle = "Hi";
    const result = exportJson(doc);
    expect(result.mimeType).toBe("application/json");
    const text = await result.blob.text();
    const parsed = JSON.parse(text);
    expect(parsed.docTitle).toBe("Hi");
    expect(parsed.v).toBe(DIAGRAM_SCHEMA_VERSION);
  });
});
