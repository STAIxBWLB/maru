import { describe, expect, it } from "vitest";
import type { ArchitectureSpec } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";

// The registered plugin's minimal input, deliberately without casts, null
// placeholders, or defaulted fields. tsc must reject any required-field drift.
const minimal: ArchitectureSpec = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Test", output: "test.html" },
  components: [{ id: "api", type: "backend", label: "API", pos: [50, 160] }],
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

// Each document family has an omission fixture; tsc includes this file in the
// ordinary gate, independently of runtime fixture assertions.
import type {
  WorkflowSpec, SequenceSpec, DataflowSpec, LifecycleSpec,
} from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";

const workflow: WorkflowSpec = {
  schema_version: 1, diagram_type: "workflow", meta: { title: "Workflow", output: "workflow.html" },
  lanes: [{ id: "main", label: "Main" }],
  nodes: [{ id: "a", lane: "main", col: 0, type: "backend", label: "A" }], edges: [],
};
const sequence: SequenceSpec = {
  schema_version: 1, diagram_type: "sequence", meta: { title: "Sequence", output: "sequence.html" },
  participants: [{ id: "client", type: "frontend", label: "Client" }, { id: "api", type: "backend", label: "API" }],
  messages: [{ from: "client", to: "api", y: 180, label: "Call" }],
};
const dataflow: DataflowSpec = {
  schema_version: 1, diagram_type: "dataflow", meta: { title: "Dataflow", output: "dataflow.html" },
  stages: [{ label: "Input" }, { label: "Output" }],
  nodes: [{ id: "input", type: "frontend", label: "Input", stage: 0, row: 0 }, { id: "output", type: "backend", label: "Output", stage: 1, row: 0 }],
  flows: [{ from: "input", to: "output", label: "Data" }],
};
const lifecycle: LifecycleSpec = {
  schema_version: 1, diagram_type: "lifecycle", meta: { title: "Lifecycle", output: "lifecycle.html" },
  lanes: [{ id: "main", label: "Main" }],
  states: [{ id: "a", type: "start", label: "Start", lane: "main", col: 0 }, { id: "b", type: "success", label: "Done", lane: "main", col: 1 }],
  transitions: [{ from: "a", to: "b" }],
};
it("keeps a typed minimal fixture for every dispatched family", () => {
  expect([minimal, workflow, sequence, dataflow, lifecycle].map((spec) => spec.diagram_type))
    .toEqual(["architecture", "workflow", "sequence", "dataflow", "lifecycle"]);
});

// S1's new input models retain Serde defaults and explicit nullable Options.
import type { LayoutRequest, PinSet, GeometryPin } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
const layoutRequest: LayoutRequest = { specJson: JSON.stringify(minimal) };
const emptyPins: PinSet = { sourceSpecSha256: "a".repeat(64) };
const geometryPin: GeometryPin = { targetId: "dataset:component:api", targetKind: "node", position: { x: 64, y: -64 } };
const nullableLayout: LayoutRequest = { ...layoutRequest, pinSet: null };
it("keeps geometry request defaults optional and nullable without casts", () => {
  expect(layoutRequest).not.toHaveProperty("pinSet");
  expect(emptyPins).not.toHaveProperty("pins");
  expect(geometryPin).not.toHaveProperty("role");
  expect(nullableLayout.pinSet).toBeNull();
});
