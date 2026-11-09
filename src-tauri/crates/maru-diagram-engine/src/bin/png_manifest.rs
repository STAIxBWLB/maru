//! Host-only pinned PNG determinism manifest writer.
use maru_diagram_engine::render::png_corpus::{
    png_corpus_manifest, png_corpus_manifest_with_sink,
};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

fn write_manifest(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{contents}\n"))?;
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !(2..=3).contains(&args.len()) {
        return Err("Expected OUTPUT_JSON and optional PNG_DIR; pass a writable manifest path and, when retaining PNGs for diagnosis, an artifact directory".into());
    }
    let output = PathBuf::from(&args[0]);
    let png_dir = args.get(1).map(PathBuf::from);
    let contents = if let Some(directory) = png_dir {
        fs::create_dir_all(&directory)?;
        png_corpus_manifest_with_sink(&mut |name, bytes| {
            fs::write(directory.join(format!("{name}.png")), bytes)
                .map_err(|cause| format!("could not write PNG artifact {name:?}: {cause}"))
        })?
    } else {
        png_corpus_manifest()?
    };
    write_manifest(&output, &contents)?;
    println!("PNG determinism manifest written: {}", output.display());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("PNG determinism manifest failed: {error}; inspect the cause and fix in the diagnostic, then rerun png-manifest with a writable output path.");
        std::process::exit(1);
    }
}
