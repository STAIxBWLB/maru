# Changelog

## Unreleased

- Expanded `validate_json` from the E0 architecture slice to document validity
  for all five types, with identity, reference and semantic checks. Workflow
  and lifecycle admit schema versions 1/2; the other types admit version 1.
- Added typed per-family Serde/TypeScript models and the generic
  `validate_diagram_json` WebAssembly export; retained the architecture-named
  export as a compatibility alias.

## 0.1.0

- Initial E0 architecture validation slice, generic receipts, optional wasm
  entrypoints, and Rust-derived TypeScript declarations.
