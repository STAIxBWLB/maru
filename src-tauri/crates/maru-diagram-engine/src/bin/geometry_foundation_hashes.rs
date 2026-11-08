//! Native whole-scene corpus runner. The historical binary name stays compatible
//! with S1 tooling; both native and WASM use the same SDK implementation.
use maru_diagram_engine::geometry_corpus::scene_corpus_hashes;
use std::{error::Error, fs};

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Expected corpus and output paths; pass testdata/parity.json and a writable scene-report JSON path".into());
    }
    let input = fs::read_to_string(&args[1])?;
    let report = scene_corpus_hashes(&input).map_err(|diagnostic| {
        format!(
            "{} at {}: {}; {}",
            diagnostic.code, diagnostic.path, diagnostic.message, diagnostic.fix
        )
    })?;
    fs::write(&args[2], format!("{report}\n"))?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("Scene corpus hashing failed: {error}; verify the corpus path, SDK layout diagnostics and writable output folder, then rerun geometry-foundation-hashes.");
        std::process::exit(1);
    }
}
