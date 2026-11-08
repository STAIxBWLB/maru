# tauri-plugin-maru-diagram

Version 0.1.0 is the standalone Tauri 2 adapter for `maru-diagram-engine`.
`Builder::new(host, sources).build::<R>()` installs one asynchronous `validate`
command. The command dispatches the pure validator to Tauri's blocking pool.

`DiagramHost` supplies a workspace root and a write-authorization hook for
later store commands. `DiagramSources` exposes bounded snapshots for document
relations, workspace structure, and vault concepts. E0 defines those seams but
does not connect them to Maru files or data. `FixtureSources` contains only
synthetic examples.

The crate has no dependency on the Maru application crate. Its standalone Cargo
workspace is `src-tauri/crates/Cargo.toml`; run
`cargo test -p tauri-plugin-maru-diagram` from that directory.
