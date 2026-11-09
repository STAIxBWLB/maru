//! Remote-only export of the pinned fonts' actual glyph-zero outlines.

use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use ttf_parser::{Face, GlyphId, OutlineBuilder};

fn fail(cause: impl Into<String>, next: &str) -> io::Error {
    io::Error::other(format!("{}; {next}", cause.into()))
}

fn number(value: f32) -> String {
    if value == 0.0 {
        "0".to_owned()
    } else {
        value.to_string()
    }
}

#[derive(Default)]
struct SvgPath(String);

impl SvgPath {
    fn command(&mut self, name: char, values: &[f32]) {
        if !self.0.is_empty() {
            self.0.push(' ');
        }
        self.0.push(name);
        for value in values {
            self.0.push(' ');
            self.0.push_str(&number(*value));
        }
    }
}

impl OutlineBuilder for SvgPath {
    fn move_to(&mut self, x: f32, y: f32) {
        self.command('M', &[x, y]);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.command('L', &[x, y]);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.command('Q', &[x1, y1, x, y]);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.command('C', &[x1, y1, x2, y2, x, y]);
    }

    fn close(&mut self) {
        if !self.0.is_empty() {
            self.0.push_str(" Z");
        }
    }
}

fn export(path: &PathBuf, expected_weight: u16) -> io::Result<serde_json::Value> {
    let bytes = fs::read(path).map_err(|error| {
        fail(
            format!("cannot read font input {}: {error}", path.display()),
            "download the pinned font into the remote cache and retry",
        )
    })?;
    let face = Face::parse(&bytes, 0).map_err(|error| {
        fail(
            format!("cannot parse pinned font {}: {error:?}", path.display()),
            "verify the downloaded OTF is complete and matches the source URL",
        )
    })?;
    if face.units_per_em() == 0 || face.weight().to_number() != expected_weight {
        return Err(fail(
            "font units/weight do not match the pinned font input",
            "restore the correct regular-400 or bold-700 OTF and retry",
        ));
    }
    let mut path_data = SvgPath::default();
    face.outline_glyph(GlyphId(0), &mut path_data)
        .filter(|_| !path_data.0.is_empty())
        .ok_or_else(|| {
            fail(
                format!("pinned font {} has no glyph 0 outline", path.display()),
                "verify the pinned original font files before regenerating",
            )
        })?;
    Ok(json!({
        "path": path_data.0,
        "unitsPerEm": face.units_per_em(),
        "sourceSha256": format!("{:x}", Sha256::digest(&bytes)),
    }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(target_os = "linux") {
        return Err(fail(
            "font generation is remote-only",
            "run this tool through the workspace remote-dev runner",
        )
        .into());
    }
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() != 2 {
        return Err(fail(
            "expected regular OTF and bold OTF",
            "run cargo run --features font-tools --bin export-notdef -- REGULAR.otf BOLD.otf through the remote runner",
        )
        .into());
    }
    let regular = export(&args[0], 400)?;
    let bold = export(&args[1], 700)?;
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut stdout, &json!({ "400": regular, "700": bold }))?;
    writeln!(stdout)?;
    Ok(())
}
