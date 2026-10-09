/**
 * One engine-valid Archify spec per semantic diagram type (issue #433 P2).
 *
 * The sequence, dataflow and lifecycle specs are the issue's fixtures
 * verbatim (validated with the pinned `archify validate`); relations carry no
 * ids, so ingest mints them. Shared by the unit tests and the e2e specs.
 */

import type { SemanticDiagramType } from "../reportTypes";

export const SEMANTIC_FIXTURES: Record<SemanticDiagramType, Record<string, unknown>> = {
  architecture: {
    schema_version: 1,
    diagram_type: "architecture",
    meta: { title: "Shop", output: "shop.html", locale: "en" },
    layout: { mode: "grid" },
    components: [
      { id: "web", type: "frontend", label: "Web", row: 0, col: 0 },
      { id: "api", type: "backend", label: "API", row: 0, col: 1 },
      { id: "db", type: "database", label: "DB", row: 0, col: 2 },
    ],
    boundaries: [{ kind: "region", label: "Cloud", wraps: ["api", "db"] }],
    connections: [
      { from: "web", to: "api", label: "HTTPS" },
      { from: "api", to: "db" },
    ],
  },
  workflow: {
    schema_version: 2,
    diagram_type: "workflow",
    meta: { title: "Review", output: "review.html", locale: "en" },
    lanes: [
      { id: "author", label: "Author" },
      { id: "reviewer", label: "Reviewer" },
    ],
    nodes: [
      { id: "draft", lane: "author", col: 0, type: "frontend", label: "Draft" },
      { id: "review", lane: "reviewer", col: 1, type: "backend", label: "Review" },
      { id: "merge", lane: "author", col: 2, type: "backend", label: "Merge" },
    ],
    edges: [
      { from: "draft", to: "review", role: "main" },
      { from: "review", to: "merge", label: "approve", role: "main" },
    ],
  },
  sequence: {
    schema_version: 1,
    diagram_type: "sequence",
    meta: { title: "Login", output: "login.html", locale: "en" },
    participants: [
      { id: "web", type: "frontend", label: "Web" },
      { id: "api", type: "backend", label: "API" },
      { id: "db", type: "database", label: "DB" },
    ],
    messages: [
      { from: "web", to: "api", y: 180, label: "POST /login" },
      { from: "api", to: "db", y: 230, label: "find user" },
      { from: "db", to: "api", y: 280, label: "row", variant: "return" },
      { from: "api", to: "web", y: 330, label: "200 OK", variant: "return" },
    ],
  },
  dataflow: {
    schema_version: 1,
    diagram_type: "dataflow",
    meta: { title: "Events", output: "events.html", locale: "en" },
    stages: [{ label: "Collect" }, { label: "Store" }],
    nodes: [
      { id: "app", type: "frontend", label: "App", stage: 0, row: 0 },
      { id: "wh", type: "database", label: "Warehouse", stage: 1, row: 0 },
    ],
    flows: [{ from: "app", to: "wh", label: "events", classification: "PII" }],
  },
  lifecycle: {
    schema_version: 2,
    diagram_type: "lifecycle",
    meta: { title: "Run", output: "run.html", locale: "en" },
    lanes: [{ id: "main", label: "Main" }],
    states: [
      { id: "queued", type: "start", label: "Queued", lane: "main", col: 0 },
      { id: "running", type: "active", label: "Running", lane: "main", col: 1 },
      { id: "done", type: "success", label: "Done", lane: "main", col: 2 },
    ],
    transitions: [
      { from: "queued", to: "running", label: "start" },
      { from: "running", to: "done", label: "finish" },
    ],
  },
};
