# maru-diagram-engine

Version 0.1.0 is an independent, pure-Rust E0 validation slice for typed
architecture diagrams. It has no Tauri, Maru-app, Archify, Floorplan, Node, or
filesystem dependency. Input is JSON text; `validate_json` returns a bounded
diagnostic report and a generic engine receipt.

The E0 contract validates the architecture header, required metadata, unique
component IDs and connection references, plus declared grid column bounds. It
does not validate complete Archify schemas, layout, routing, geometry, or
rendering. The receipt's schema gate names this limited scope.

Optional features:

- `wasm` exports `validate_architecture_json` and `parse_receipt_json` through
  wasm-bindgen.
- `typegen` enables `export-types`, which prints a deterministic TypeScript
  declaration module to stdout.
- `bindgen-web` enables the `bindgen-web <input.wasm> <output-dir>` tooling bin;
  it uses `wasm-bindgen-cli-support` and installs no CLI executable.

The standalone Cargo workspace lives at `src-tauri/crates/Cargo.toml`.
Run `cargo test -p maru-diagram-engine` from that directory.
