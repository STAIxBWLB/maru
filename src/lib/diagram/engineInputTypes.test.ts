import { describe, expect, it } from "vitest";
import type { ArchitectureSpec } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";

// The registered plugin's minimal input, deliberately without casts, null
// placeholders, or defaulted fields. tsc must reject any required-field drift.
const minimal: ArchitectureSpec = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Test", output: "test.html" },
  components: [{ id: "api", type: "backend", label: "API" }],
};

// Also exercise defaults below an explicitly present layout/connection. The
// minimal fixture alone cannot detect cols or id/label becoming required.
const nestedDefaults: ArchitectureSpec = {
  ...minimal,
  layout: { mode: "grid" },
  connections: [{ from: "api", to: "api" }],
};

// Rust Option inputs also accept explicit null; defaulted Vec inputs do not.
const nullableInputs: ArchitectureSpec = {
  ...minimal,
  meta: { ...minimal.meta, locale: null },
  layout: { mode: "grid", cols: null },
  components: [{ ...minimal.components[0]!, row: null, col: null }],
  connections: [{ id: null, from: "api", to: "api", label: null }],
};

describe("generated engine input compile fixtures", () => {
  it("retains the actual omitted-field shapes checked by tsc", () => {
    expect(minimal).not.toHaveProperty("layout");
    expect(minimal).not.toHaveProperty("connections");
    expect(minimal).not.toHaveProperty("boundaries");
    expect(nestedDefaults.layout).toEqual({ mode: "grid" });
    expect(nestedDefaults.connections).toEqual([{ from: "api", to: "api" }]);
    expect(nullableInputs.components[0]?.row).toBeNull();
  });
});
