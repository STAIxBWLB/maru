use std::env;
use std::fs;
use std::io;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let wasm = args.next().map(PathBuf::from).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: bindgen-web <input.wasm> <output-dir>; pass the wasm32-unknown-unknown engine artifact",
        )
    })?;
    let output = args.next().map(PathBuf::from).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: bindgen-web <input.wasm> <output-dir>; choose a generated-bindings directory",
        )
    })?;
    if args.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: bindgen-web <input.wasm> <output-dir>; pass exactly two paths",
        )
        .into());
    }
    if !wasm.is_file() {
        return Err(format!(
            "wasm-bindgen input does not exist: {}; build the engine for wasm32-unknown-unknown and retry",
            wasm.display()
        )
        .into());
    }
    fs::create_dir_all(&output).map_err(|error| {
        format!(
            "cannot create bindgen output directory {}: {error}; check permissions and retry",
            output.display()
        )
    })?;
    let mut bindgen = wasm_bindgen_cli_support::Bindgen::new();
    bindgen.input_path(&wasm);
    bindgen.web(true).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "cannot select wasm-bindgen web output: {error}; check the wasm target settings and retry"
            ),
        )
    })?;
    bindgen.generate(&output).map_err(|error| {
        format!(
            "wasm-bindgen generation failed: {error}; check the wasm artifact and rerun bindgen-web"
        )
    })?;
    Ok(())
}
