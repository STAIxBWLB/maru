//! Remote-only source generator for the bundled, OFL-licensed metric data.
#[path = "../metrics/format.rs"]
mod format;

use format::{CMAP_LEN, GLYPH_LEN, HEADER_LEN, MAGIC, MISSING_GLYPH};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use ttf_parser::{Face, GlyphId};

const REVISION: &str = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const SOURCE_ROOT: &str =
    "https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const SAMPLE: &str = "한글漢字日本語あアLatin";

fn fail(cause: impl Into<String>, next: &str) -> io::Error {
    io::Error::other(format!("{}; {next}", cause.into()))
}
fn write_generated(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    fs::write(path, contents).map_err(|error| {
        fail(
            format!("cannot write generated font artifact {}: {error}", path.display()),
            "check output-directory permissions and free disk space, then rerun node scripts/diagram-engine-e2-fonts.mjs through the remote runner",
        )
    })
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend(value.to_le_bytes());
}
fn push_i16(out: &mut Vec<u8>, value: i16) {
    out.extend(value.to_le_bytes());
}
fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend(value.to_le_bytes());
}
fn ranges(mappings: &BTreeMap<u32, u16>) -> Vec<[u32; 2]> {
    let mut result: Vec<[u32; 2]> = Vec::new();
    for scalar in mappings.keys().copied() {
        if let Some(last) = result.last_mut() {
            if last[1].checked_add(1) == Some(scalar) {
                last[1] = scalar;
                continue;
            }
        }
        result.push([scalar, scalar]);
    }
    result
}
fn glyph_json(face: &Face<'_>, scalar: char) -> io::Result<Value> {
    let id = face
        .glyph_index(scalar)
        .filter(|id| id.0 != 0)
        .ok_or_else(|| {
            fail(
                format!("pinned font does not cover required sample character {scalar}"),
                "verify the downloaded font against its pinned source URL",
            )
        })?;
    let advance = face.glyph_hor_advance(id).ok_or_else(|| {
        fail(
            "sample glyph has no horizontal advance",
            "verify the pinned font hmtx table",
        )
    })?;
    let ink = face.glyph_bounding_box(id).ok_or_else(|| {
        fail(
            "sample glyph has no ink bounds",
            "verify ttf-parser supports the pinned CFF font",
        )
    })?;
    Ok(
        json!({ "scalar": scalar.to_string(), "glyphId": id.0, "advance": advance,
        "leftSideBearing": face.glyph_hor_side_bearing(id).unwrap_or(0),
        "ink": [ink.x_min, ink.y_min, ink.x_max, ink.y_max] }),
    )
}
fn build(input: &Path, output: &Path, weight: u16) -> io::Result<(Value, BTreeSet<String>)> {
    let bytes = fs::read(input).map_err(|error| {
        fail(
            format!("cannot read font input {}: {error}", input.display()),
            "download the pinned font into the remote cache and retry",
        )
    })?;
    let face = Face::parse(&bytes, 0).map_err(|error| {
        fail(
            format!("cannot parse pinned font {}: {error:?}", input.display()),
            "verify the downloaded OTF is complete and matches the source URL",
        )
    })?;
    if face.units_per_em() == 0 || face.weight().to_number() != weight {
        return Err(fail(
            "font units/weight do not match the pinned metric input",
            "restore the correct regular-400 or bold-700 OTF and retry",
        ));
    }
    let mut mappings = BTreeMap::new();
    let mut glyphs = BTreeSet::new();
    glyphs.insert(0_u16);
    // Iterate Unicode scalars, then use Face's own preferred cmap lookup. This
    // avoids selecting a different glyph from competing Unicode subtables.
    for value in 0..=char::MAX as u32 {
        let Some(scalar) = char::from_u32(value) else {
            continue;
        };
        if let Some(id) = face.glyph_index(scalar).filter(|id| id.0 != 0) {
            mappings.insert(value, id.0);
            glyphs.insert(id.0);
        }
    }
    let probes: Vec<_> = SAMPLE
        .chars()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|scalar| glyph_json(&face, scalar))
        .collect::<io::Result<_>>()?;
    let source_hash = Sha256::digest(&bytes);
    let replacement = face
        .glyph_index('�')
        .filter(|id| id.0 != 0)
        .map(|id| id.0)
        .unwrap_or(MISSING_GLYPH);
    let mut table = Vec::new();
    table.extend(MAGIC);
    push_u16(&mut table, face.units_per_em());
    push_i16(&mut table, face.ascender());
    push_i16(&mut table, face.descender());
    push_i16(&mut table, face.line_gap());
    push_u32(
        &mut table,
        u32::try_from(glyphs.len()).map_err(|_| {
            fail(
                "glyph count exceeds table format",
                "review the metric-table format before adding a larger font",
            )
        })?,
    );
    push_u32(
        &mut table,
        u32::try_from(mappings.len()).map_err(|_| {
            fail(
                "cmap count exceeds table format",
                "review the metric-table format before adding a larger font",
            )
        })?,
    );
    table.extend(source_hash);
    push_u16(&mut table, weight);
    push_u16(&mut table, replacement);
    assert_eq!(table.len(), HEADER_LEN);
    for glyph in &glyphs {
        let id = GlyphId(*glyph);
        let advance = face.glyph_hor_advance(id).ok_or_else(|| {
            fail(
                format!("glyph {glyph} has no horizontal metrics"),
                "verify the pinned OTF hmtx table and regenerate",
            )
        })?;
        let bearing = face.glyph_hor_side_bearing(id).ok_or_else(|| {
            fail(
                format!("glyph {glyph} has no side bearing"),
                "verify the pinned OTF hmtx table and regenerate",
            )
        })?;
        let bbox = face.glyph_bounding_box(id);
        push_u16(&mut table, *glyph);
        push_u16(&mut table, advance);
        push_i16(&mut table, bearing);
        let bounds = bbox
            .map(|rect| [rect.x_min, rect.y_min, rect.x_max, rect.y_max])
            .unwrap_or([0, 0, 0, 0]);
        for value in bounds {
            push_i16(&mut table, value);
        }
        push_u16(&mut table, u16::from(bbox.is_some()));
    }
    for (scalar, glyph) in &mappings {
        push_u32(&mut table, *scalar);
        push_u16(&mut table, *glyph);
    }
    assert_eq!(
        table.len(),
        HEADER_LEN + GLYPH_LEN * glyphs.len() + CMAP_LEN * mappings.len()
    );
    let file = format!("noto-cjk-kr-{weight}.bin");
    fs::write(output.join(&file), &table).map_err(|error| {
        fail(
            format!("cannot write derived metric table: {error}"),
            "check the owned output directory and regenerate",
        )
    })?;
    let font_name = if weight == 400 { "Regular" } else { "Bold" };
    let copyrights: BTreeSet<_> = face
        .names()
        .into_iter()
        .filter(|name| name.name_id == 0)
        .filter_map(|name| name.to_string())
        .collect();
    let entry = json!({
        "id": "noto-sans-cjk-kr", "weight": weight, "unitsPerEm": face.units_per_em(),
        "sourceUrl": format!("{SOURCE_ROOT}/Sans/OTF/Korean/NotoSansCJKkr-{font_name}.otf"),
        "sourceSha256": sha(&bytes), "sourceBytes": bytes.len(), "tableFile": file,
        "tableSha256": sha(&table), "tableBytes": table.len(), "mappedScalars": mappings.len(),
        "metricGlyphs": glyphs.len(), "sourceGlyphs": face.number_of_glyphs(),
        "ascender": face.ascender(), "descender": face.descender(), "lineGap": face.line_gap(),
        "replacementCovered": replacement != MISSING_GLYPH,
        "coverageRanges": ranges(&mappings), "requiredSample": SAMPLE, "probes": probes,
    });
    Ok((entry, copyrights))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(target_os = "linux") {
        return Err(fail(
            "font generation is remote-only",
            "run this tool through the workspace remote-dev runner",
        )
        .into());
    }
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() != 4 {
        return Err(fail(
            "expected regular OTF, bold OTF, source license and output directory",
            "run node scripts/diagram-engine-e2-fonts.mjs through the remote-dev runner",
        )
        .into());
    }
    let output = &args[3];
    fs::create_dir_all(output).map_err(|error| {
        fail(
            format!("cannot create metric output directory: {error}"),
            "check permissions and retry",
        )
    })?;
    let license = fs::read(&args[2]).map_err(|error| {
        fail(
            format!("cannot read source font license: {error}"),
            "download Sans/LICENSE from the pinned source revision",
        )
    })?;
    if !String::from_utf8_lossy(&license).contains("SIL OPEN FONT LICENSE Version 1.1") {
        return Err(fail(
            "source license is not the expected OFL 1.1 text",
            "restore Sans/LICENSE from the pinned revision before regenerating",
        )
        .into());
    }
    let (regular, mut notices) = build(&args[0], output, 400)?;
    let (bold, bold_notices) = build(&args[1], output, 700)?;
    notices.extend(bold_notices);
    if notices.is_empty() {
        return Err(fail(
            "font copyright name records were unavailable",
            "verify the pinned original font files before distributing derived tables",
        )
        .into());
    }
    write_generated(&output.join("LICENSE.OFL"), &license)?;
    let notice = format!("Maru derived font metric data\n\nThe .bin tables and this manifest are derived from the pinned Noto Sans CJK KR regular/bold fonts. They remain under OFL-1.1, separately from the SDK's code license. The original font binaries are not included here.\n\nSource revision: {REVISION}\nSource license: {SOURCE_ROOT}/Sans/LICENSE\n\nOriginal font copyright records:\n{}\n\nSee LICENSE.OFL for the complete license. The source family name is retained for attribution and renderer identity, not as an endorsement.\n", notices.into_iter().collect::<Vec<_>>().join("\n"));
    write_generated(&output.join("NOTICE.md"), notice)?;
    let manifest = json!({ "formatVersion": 1, "format": "MDFONT01 little-endian integer font units", "sourceRevision": REVISION,
        "generator": { "parser": "ttf-parser", "version": "0.25.1" },
        "license": { "spdx": "OFL-1.1", "sourceUrl": format!("{SOURCE_ROOT}/Sans/LICENSE"), "sha256": sha(&license) },
        "shaping": { "kerning": false, "ligatures": false, "localizedSubstitution": false, "normalization": false,
            "policy": "one Unicode scalar maps through the pinned preferred cmap; E3 uses these glyph IDs and positions" },
        "unknownGlyph": "use the covered replacement character �; otherwise return an explicit diagnostic, never OS fallback",
        "fonts": [regular, bold],
    });
    write_generated(
        &output.join("manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    println!(
        "FONT_METRICS_GENERATED {}",
        serde_json::to_string(&json!({ "fonts": 2, "sourceRevision": REVISION,
        "tableBytes": manifest["fonts"].as_array().unwrap().iter().map(|font| font["tableBytes"].as_u64().unwrap()).sum::<u64>(),
        "mappedScalars": manifest["fonts"].as_array().unwrap().iter().map(|font| font["mappedScalars"].as_u64().unwrap()).collect::<Vec<_>>() }))?
    );
    Ok(())
}
