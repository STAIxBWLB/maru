# tauri-plugin-maru-diagram

Version 0.1.0 is the standalone Tauri 2 adapter for `maru-diagram-engine`.
`Builder::new(host, sources).build::<R>()` installs one asynchronous `validate`
command. It delegates to the core `validate_json` dispatcher for architecture,
workflow, sequence, dataflow, and lifecycle documents, and runs validation on
Tauri's blocking pool. Architecture/sequence/dataflow use schema-version 1;
workflow/lifecycle accept versions 1 and 2.

The command accepts document JSON and returns the core diagnostic report and
engine receipt. It does not write files, render diagrams, or switch the host
application to this transport. `DiagramHost` provides a workspace-root and
write-authorization seam for later store operations; validation does not use
it. `DiagramSources` defines bounded snapshot interfaces, but this release does
not connect them to workspace or vault data. `FixtureSources` contains only
synthetic examples.

The crate has no dependency on the Maru application crate. Its standalone Cargo
workspace is `src-tauri/crates/Cargo.toml`; run
`cargo test -p tauri-plugin-maru-diagram` from that directory.
