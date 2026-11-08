# maru-diagram-engine

Version 0.1.0 is an independent, pure-Rust E1 document-validity engine for
architecture, workflow, sequence, dataflow, and lifecycle JSON documents.
`validate_json` dispatches by `diagram_type` and returns a diagnostic report
plus an engine-neutral receipt. The crate has no Tauri, application, Node, or
filesystem dependency.

E1 validates document shapes (schema-version 1 for architecture, sequence and
dataflow, and versions 1/2 for workflow/lifecycle), required fields, unknown fields,
shared metadata and decorations, enums, scalar bounds, IDs, references, and
mode-specific semantic rules. Workflow checks include lane/group membership,
phase ranges, main-path edges and order, and the optional root, terminal,
required-edge, and required-path contract. Lifecycle checks include lane and
transition references. Workflow/lifecycle v2 authored-coordinate restrictions are document rules;
their readable layout calculation is outside E1.

This is document validity only. It does not compute layout, route relationships,
check geometry or label/legend fit, or render artifacts. A passed schema gate
does not imply those checks passed. Generated TypeScript declarations describe
the Serde model, including optional fields; they do not validate runtime JSON.
Defaulted Option inputs accept omission and null; defaulted Vec inputs accept
omission but reject null. Runtime applies the same scalar and document rules
regardless of the TypeScript shape. Use
`validate_json` for runtime validation.

Optional features:

- `wasm` exports the multi-type `validate_diagram_json` dispatcher and
  `parse_receipt_json` through wasm-bindgen. `validate_architecture_json`
  remains as a compatibility alias to the dispatcher.
- `geometry` enables S1 fixed-point DTOs, pin preflight and pinned Noto Sans CJK
  KR metrics. This stage exposes no scene-layout success function. Coordinate
  units are 1/64 pixel; runtime font tables are integer-only and separately OFL
  licensed under `src/metrics/data/`.
- `wasm-layout` exports actual text metrics as a separate lazy WASM binary;
  default `wasm` validation excludes both geometry and metric tables.
- `font-tools` enables the host-only pinned-font generator. It is never a
  dependency of the runtime geometry or validation path.
- `typegen` enables `export-types`, which prints a deterministic TypeScript
  declaration module to stdout.
- `bindgen-web` enables the `bindgen-web <input.wasm> <output-dir>` tooling bin;
  it uses `wasm-bindgen-cli-support` and installs no CLI executable.

The standalone Cargo workspace lives at `src-tauri/crates/Cargo.toml`.
Run `cargo test -p maru-diagram-engine` from that directory.
