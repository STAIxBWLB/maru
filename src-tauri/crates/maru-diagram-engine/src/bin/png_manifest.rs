//! Host-only pinned PNG determinism manifest writer.
use maru_diagram_engine::render::png_corpus::png_corpus_manifest_with_sinks;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

struct Arguments {
    output: PathBuf,
    png_dir: Option<PathBuf>,
    svg_parity_dir: Option<PathBuf>,
}

fn parse_args(args: &[OsString]) -> Result<Arguments, String> {
    if args.is_empty() {
        return Err("Expected OUTPUT_JSON and optional --png-dir PNG_DIR or --svg-parity-dir SVG_DIR; provide a writable manifest path".into());
    }
    let mut result = Arguments {
        output: PathBuf::from(&args[0]),
        png_dir: None,
        svg_parity_dir: None,
    };
    let mut index = 1;
    if args
        .get(index)
        .is_some_and(|value| !value.to_string_lossy().starts_with("--"))
    {
        result.png_dir = Some(PathBuf::from(&args[index]));
        index += 1;
    }
    while index < args.len() {
        let option = args[index].to_string_lossy();
        if index + 1 >= args.len() {
            return Err(format!("{option} requires an output directory"));
        }
        let directory = PathBuf::from(&args[index + 1]);
        match option.as_ref() {
            "--png-dir" => {
                if result.png_dir.replace(directory).is_some() {
                    return Err(format!("{option} was supplied more than once"));
                }
            }
            "--svg-parity-dir" => {
                if result.svg_parity_dir.replace(directory).is_some() {
                    return Err(format!("{option} was supplied more than once"));
                }
            }
            _ => {
                return Err(
                    "Unknown option; use --png-dir or --svg-parity-dir with a writable directory"
                        .into(),
                )
            }
        }
        index += 2;
    }
    Ok(result)
}

fn write_manifest(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{contents}\n"))?;
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    let raw_args: Vec<_> = std::env::args_os().skip(1).collect();
    let arguments = parse_args(&raw_args)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let output = arguments.output;
    let png_dir = arguments.png_dir;
    let svg_parity_dir = arguments.svg_parity_dir;
    if let Some(directory) = &png_dir {
        fs::create_dir_all(directory)?;
    }
    if let Some(directory) = &svg_parity_dir {
        fs::create_dir_all(directory)?;
    }
    let mut png_sink = |name: &str, bytes: &[u8]| match &png_dir {
        Some(directory) => fs::write(directory.join(format!("{name}.png")), bytes)
            .map_err(|cause| format!("could not write PNG artifact {name:?}: {cause}")),
        None => Ok(()),
    };
    let mut svg_sink = |name: &str, bytes: &[u8]| match &svg_parity_dir {
        Some(directory) => fs::write(directory.join(format!("{name}.json")), bytes)
            .map_err(|cause| format!("could not write SVG parity fixture {name:?}: {cause}")),
        None => Ok(()),
    };
    let contents =
        png_corpus_manifest_with_sinks(&mut png_sink, &mut svg_sink).map_err(|diagnostic| {
            format!(
                "{} at {}: {}; fix: {}",
                diagnostic.code, diagnostic.path, diagnostic.message, diagnostic.fix
            )
        })?;
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

#[cfg(test)]
mod tests {
    use super::parse_args;
    use std::{ffi::OsString, path::PathBuf};

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn accepts_manifest_only_positional_png_and_svg_parity_outputs() {
        let plain = parse_args(&args(&["report.json"])).unwrap();
        assert_eq!(plain.output, PathBuf::from("report.json"));
        assert!(plain.png_dir.is_none());
        assert!(plain.svg_parity_dir.is_none());

        let png = parse_args(&args(&["report.json", "artifacts"])).unwrap();
        assert_eq!(png.png_dir, Some(PathBuf::from("artifacts")));

        let parity = parse_args(&args(&["report.json", "--svg-parity-dir", "fixtures"])).unwrap();
        assert_eq!(parity.svg_parity_dir, Some(PathBuf::from("fixtures")));
    }

    #[test]
    fn accepts_both_named_directories_and_refuses_ambiguous_arguments() {
        let both = parse_args(&args(&[
            "report.json",
            "--png-dir",
            "artifacts",
            "--svg-parity-dir",
            "fixtures",
        ]))
        .unwrap();
        assert_eq!(both.png_dir, Some(PathBuf::from("artifacts")));
        assert_eq!(both.svg_parity_dir, Some(PathBuf::from("fixtures")));

        assert!(parse_args(&[]).is_err());
        assert!(parse_args(&args(&["report.json", "--png-dir"])).is_err());
        assert!(parse_args(&args(&[
            "report.json",
            "--svg-parity-dir",
            "fixtures",
            "--svg-parity-dir",
            "other",
        ]))
        .is_err());
        assert!(parse_args(&args(&["report.json", "--unknown", "directory"])).is_err());
    }
}
