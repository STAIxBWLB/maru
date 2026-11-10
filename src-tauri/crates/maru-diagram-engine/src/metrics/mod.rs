//! Deterministic, per-scalar horizontal metrics from pinned font tables.
//!
//! This module is reachable only with `geometry`. It performs no font lookup,
//! parsing, normalization, kerning, ligature or locale-specific substitution.
//! E3 must use these original-font glyph IDs and positions with the same pinned
//! fonts. Unsupported scalars use the font's actual glyph 0 (.notdef), never
//! Unicode substitution or OS fallback. Default-ignorable scalars are skipped.
mod format;
mod wrap;

use crate::geometry::{FontIdentity, GeometryBox, GeometryPoint};
use crate::layout::fixed::Coord;
use crate::Diagnostic;
use format::{CMAP_LEN, GLYPH_LEN, HEADER_LEN, MAGIC, MISSING_GLYPH};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const REVISION: &str = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
/// Unicode property data from the pinned DerivedCoreProperties.txt, not text
/// encodings. See UNICODE-LICENSE.txt for the associated data license.
pub const IGNORABLE_UNICODE_VERSION: &str = "17.0.0";
const DEFAULT_IGNORABLE_RANGES: &[(u32, u32)] = &[
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x061C, 0x061C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
];
/// Unicode 17 Default_Ignorable_Code_Point (4,174 scalars).
/// Source: https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt
pub fn is_default_ignorable(scalar: char) -> bool {
    let value = scalar as u32;
    DEFAULT_IGNORABLE_RANGES
        .iter()
        .any(|&(first, last)| first <= value && value <= last)
}

const REGULAR_BYTES: &[u8] = include_bytes!("data/noto-cjk-kr-400.bin");
const BOLD_BYTES: &[u8] = include_bytes!("data/noto-cjk-kr-700.bin");
static REGULAR: OnceLock<Result<FontTable, Diagnostic>> = OnceLock::new();
static BOLD: OnceLock<Result<FontTable, Diagnostic>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct GlyphPosition {
    /// Original scalar, retained for attribution when replacement was needed.
    pub input: String,
    /// The mapped scalar, or empty when no Unicode mapping is claimed.
    /// For nonignored .notdef entries, E3 renders glyph_id 0 directly.
    pub rendered: String,
    pub glyph_id: u16,
    pub position: GeometryPoint,
    /// Difference of rounded prefix advances, avoiding per-glyph drift.
    pub advance: Coord,
    pub left_side_bearing: Coord,
    /// Ink relative to the run baseline, with outward-rounded bounds.
    pub ink: GeometryBox,
    pub replaced: bool,
    /// Default-ignorable input: skip drawing even though glyph_id is 0.
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct TextMetrics {
    pub font: FontIdentity,
    /// Requested size in 1/64 pixel units.
    pub size: Coord,
    pub advance: Coord,
    /// Empty runs and inkless runs have a zero box at the baseline origin.
    pub ink: GeometryBox,
    pub ascender: Coord,
    /// Signed, normally negative below the baseline.
    pub descender: Coord,
    pub line_gap: Coord,
    pub glyphs: Vec<GlyphPosition>,
    pub replacements: u32,
    /// Nonfatal replacement notices; successful metrics remain available.
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Copy)]
struct GlyphUnits {
    id: u16,
    advance: u16,
    bearing: i16,
    x_min: i16,
    y_min: i16,
    x_max: i16,
    y_max: i16,
    has_ink: bool,
}
struct FontTable {
    bytes: &'static [u8],
    upem: u16,
    ascender: i16,
    descender: i16,
    line_gap: i16,
    glyph_count: usize,
    map_count: usize,
    weight: u16,
    replacement: u16,
}

fn error(suffix: &str, path: &str, cause: impl Into<String>, fix: &str) -> Diagnostic {
    Diagnostic {
        code: format!("document/font-{suffix}"),
        path: path.into(),
        rule: format!("font-v1/{suffix}"),
        message: cause.into(),
        fix: fix.into(),
    }
}
fn bad_table() -> Diagnostic {
    error(
        "table",
        "/font",
        "the bundled font metric table is malformed or inconsistent",
        "regenerate the pinned font tables and rebuild the geometry module",
    )
}
fn overflow() -> Diagnostic {
    error(
        "overflow",
        "/text",
        "text metrics exceed the fixed-point coordinate range",
        "use a smaller font size or split the text into shorter runs",
    )
}
fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}
fn i16_at(bytes: &[u8], offset: usize) -> i16 {
    i16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}
impl FontTable {
    fn parse(bytes: &'static [u8], expected_weight: u16) -> Result<Self, Diagnostic> {
        if bytes.len() < HEADER_LEN || &bytes[..8] != MAGIC {
            return Err(bad_table());
        }
        let glyph_count = u32_at(bytes, 16) as usize;
        let map_count = u32_at(bytes, 20) as usize;
        let expected = glyph_count
            .checked_mul(GLYPH_LEN)
            .and_then(|n| n.checked_add(HEADER_LEN))
            .and_then(|n| {
                map_count
                    .checked_mul(CMAP_LEN)
                    .and_then(|m| n.checked_add(m))
            })
            .ok_or_else(bad_table)?;
        let table = Self {
            bytes,
            upem: u16_at(bytes, 8),
            ascender: i16_at(bytes, 10),
            descender: i16_at(bytes, 12),
            line_gap: i16_at(bytes, 14),
            glyph_count,
            map_count,
            weight: u16_at(bytes, 56),
            replacement: u16_at(bytes, 58),
        };
        if expected != bytes.len()
            || table.upem == 0
            || glyph_count == 0
            || table.weight != expected_weight
        {
            return Err(bad_table());
        }
        let mut previous = None;
        for index in 0..glyph_count {
            let glyph = table.record(index);
            if previous.is_some_and(|id| id >= glyph.id)
                || glyph.x_min > glyph.x_max
                || glyph.y_min > glyph.y_max
            {
                return Err(bad_table());
            }
            previous = Some(glyph.id);
        }
        let mut previous = None;
        for index in 0..map_count {
            let (scalar, glyph) = table.mapping(index);
            if char::from_u32(scalar).is_none()
                || previous.is_some_and(|cp| cp >= scalar)
                || table.glyph(glyph).is_none()
            {
                return Err(bad_table());
            }
            previous = Some(scalar);
        }
        if table.glyph(0).is_none() {
            return Err(bad_table());
        }
        let mapped_replacement = table.lookup('�');
        if mapped_replacement.map(|g| g.id).unwrap_or(MISSING_GLYPH) != table.replacement {
            return Err(bad_table());
        }
        Ok(table)
    }
    fn record(&self, index: usize) -> GlyphUnits {
        let at = HEADER_LEN + index * GLYPH_LEN;
        GlyphUnits {
            id: u16_at(self.bytes, at),
            advance: u16_at(self.bytes, at + 2),
            bearing: i16_at(self.bytes, at + 4),
            x_min: i16_at(self.bytes, at + 6),
            y_min: i16_at(self.bytes, at + 8),
            x_max: i16_at(self.bytes, at + 10),
            y_max: i16_at(self.bytes, at + 12),
            has_ink: u16_at(self.bytes, at + 14) & 1 == 1,
        }
    }
    fn mapping(&self, index: usize) -> (u32, u16) {
        let at = HEADER_LEN + self.glyph_count * GLYPH_LEN + index * CMAP_LEN;
        (u32_at(self.bytes, at), u16_at(self.bytes, at + 4))
    }
    fn glyph(&self, id: u16) -> Option<GlyphUnits> {
        let (mut low, mut high) = (0, self.glyph_count);
        while low < high {
            let mid = low + (high - low) / 2;
            let glyph = self.record(mid);
            match glyph.id.cmp(&id) {
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Greater => high = mid,
                std::cmp::Ordering::Equal => return Some(glyph),
            }
        }
        None
    }
    fn lookup(&self, scalar: char) -> Option<GlyphUnits> {
        let target = scalar as u32;
        let (mut low, mut high) = (0, self.map_count);
        while low < high {
            let mid = low + (high - low) / 2;
            let (cp, id) = self.mapping(mid);
            match cp.cmp(&target) {
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Greater => high = mid,
                std::cmp::Ordering::Equal => return self.glyph(id),
            }
        }
        None
    }
    fn identity(&self) -> FontIdentity {
        FontIdentity {
            id: "noto-sans-cjk-kr".into(),
            revision: REVISION.into(),
            font_sha256: self.bytes[24..56]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            weight: self.weight,
            units_per_em: self.upem,
            license: "OFL-1.1".into(),
        }
    }
}
fn table(weight: u16) -> Result<&'static FontTable, Diagnostic> {
    let stored = match weight {
        400 => REGULAR.get_or_init(|| FontTable::parse(REGULAR_BYTES, 400)),
        700 => BOLD.get_or_init(|| FontTable::parse(BOLD_BYTES, 700)),
        _ => {
            return Err(error(
                "weight",
                "/weight",
                "only the pinned regular and bold font weights are supported",
                "choose weight 400 or 700",
            ))
        }
    };
    stored.as_ref().map_err(Clone::clone)
}

pub fn font_identity(weight: u16) -> Result<FontIdentity, Diagnostic> {
    Ok(table(weight)?.identity())
}

/// Wrap `text` to a measured box. See [`wrap::wrap_label_lines`].
pub use wrap::wrap_label_lines;

pub fn font_manifest() -> &'static str {
    include_str!("data/manifest.json")
}

fn scaled(units: i64, size: Coord, upem: u16, rounding: i8) -> Result<Coord, Diagnostic> {
    let numerator = units.checked_mul(i64::from(size)).ok_or_else(overflow)?;
    let denominator = i64::from(upem);
    let value = match rounding {
        -1 => numerator.div_euclid(denominator),
        1 => -numerator
            .checked_neg()
            .ok_or_else(overflow)?
            .div_euclid(denominator),
        _ if numerator >= 0 => {
            numerator
                .checked_add(denominator / 2)
                .ok_or_else(overflow)?
                / denominator
        }
        _ => {
            -numerator
                .checked_neg()
                .and_then(|n| n.checked_add(denominator / 2))
                .ok_or_else(overflow)?
                / denominator
        }
    };
    Coord::try_from(value).map_err(|_| overflow())
}
fn box_from_bounds(
    left: Coord,
    top: Coord,
    right: Coord,
    bottom: Coord,
) -> Result<GeometryBox, Diagnostic> {
    Ok(GeometryBox {
        x: left,
        y: top,
        width: Coord::try_from(i64::from(right) - i64::from(left)).map_err(|_| overflow())?,
        height: Coord::try_from(i64::from(bottom) - i64::from(top)).map_err(|_| overflow())?,
    })
}
fn zero_box() -> GeometryBox {
    GeometryBox {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
    }
}

/// Measure one unshaped horizontal scalar run. Prefix advances are rounded
/// nearest (ties away from zero); ink bounds round outward to 1/64 pixel.
pub fn measure_text(text: &str, weight: u16, size: Coord) -> Result<TextMetrics, Diagnostic> {
    if size <= 0 {
        return Err(error(
            "size",
            "/size",
            "font size must be positive fixed-point pixels",
            "use a positive font size in 1/64 pixel units",
        ));
    }
    let table = table(weight)?;
    let mut glyphs = Vec::new();
    glyphs.try_reserve(text.chars().count()).map_err(|_| {
        error(
            "allocation",
            "/text",
            "glyph positions could not be allocated",
            "split the text into shorter runs and retry",
        )
    })?;
    let mut pen_units: i64 = 0;
    let mut replacements: u32 = 0;
    let mut ink: Option<(Coord, Coord, Coord, Coord)> = None;
    let notdef = table.glyph(0).ok_or_else(bad_table)?;
    for input in text.chars() {
        let position = GeometryPoint {
            x: scaled(pen_units, size, table.upem, 0)?,
            y: 0,
        };
        if is_default_ignorable(input) {
            glyphs.push(GlyphPosition {
                input: input.to_string(),
                rendered: String::new(),
                glyph_id: 0,
                position,
                advance: 0,
                left_side_bearing: 0,
                ink: zero_box(),
                replaced: false,
                ignored: true,
            });
            continue;
        }
        let (glyph, rendered, replaced) = match table.lookup(input) {
            Some(glyph) => (glyph, input.to_string(), false),
            None => (notdef, String::new(), true),
        };
        let next_pen = pen_units
            .checked_add(i64::from(glyph.advance))
            .ok_or_else(overflow)?;
        let advance = scaled(next_pen, size, table.upem, 0)?
            .checked_sub(position.x)
            .ok_or_else(overflow)?;
        let glyph_ink = if glyph.has_ink {
            let left = scaled(
                pen_units
                    .checked_add(i64::from(glyph.x_min))
                    .ok_or_else(overflow)?,
                size,
                table.upem,
                -1,
            )?;
            let top = scaled(-i64::from(glyph.y_max), size, table.upem, -1)?;
            let right = scaled(
                pen_units
                    .checked_add(i64::from(glyph.x_max))
                    .ok_or_else(overflow)?,
                size,
                table.upem,
                1,
            )?;
            let bottom = scaled(-i64::from(glyph.y_min), size, table.upem, 1)?;
            ink = Some(match ink {
                None => (left, top, right, bottom),
                Some((l, t, r, b)) => (l.min(left), t.min(top), r.max(right), b.max(bottom)),
            });
            box_from_bounds(left, top, right, bottom)?
        } else {
            zero_box()
        };
        if replaced {
            replacements = replacements.checked_add(1).ok_or_else(overflow)?;
        }
        glyphs.push(GlyphPosition {
            input: input.to_string(),
            rendered,
            glyph_id: glyph.id,
            position,
            advance,
            left_side_bearing: scaled(i64::from(glyph.bearing), size, table.upem, 0)?,
            ink: glyph_ink,
            replaced,
            ignored: false,
        });
        pen_units = next_pen;
    }
    let diagnostics = if replacements == 0 {
        Vec::new()
    } else {
        vec![error("replacement-notice", "/text",
            format!("the pinned font used its actual .notdef glyph for {replacements} unsupported text scalars"),
            "render the returned glyph IDs, including glyph 0 boxes, or use covered characters; never substitute a system font")]
    };
    Ok(TextMetrics {
        font: table.identity(),
        size,
        advance: scaled(pen_units, size, table.upem, 0)?,
        ink: match ink {
            Some((l, t, r, b)) => box_from_bounds(l, t, r, b)?,
            None => zero_box(),
        },
        ascender: scaled(i64::from(table.ascender), size, table.upem, 0)?,
        descender: scaled(i64::from(table.descender), size, table.upem, 0)?,
        line_gap: scaled(i64::from(table.line_gap), size, table.upem, 0)?,
        glyphs,
        replacements,
        diagnostics,
    })
}

#[cfg(feature = "typegen")]
pub fn declarations(cfg: &ts_rs::Config) -> Vec<String> {
    use ts_rs::TS;
    vec![GlyphPosition::decl(cfg), TextMetrics::decl(cfg)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    const SAMPLE: &str = "한글漢字日本語あアLatin";

    #[test]
    fn pinned_tables_cover_literal_latin_and_cjk_at_both_weights() {
        for weight in [400, 700] {
            let metrics = measure_text(SAMPLE, weight, 14 * 64).unwrap();
            assert_eq!(metrics.replacements, 0);
            assert!(metrics.diagnostics.is_empty());
            assert!(metrics
                .glyphs
                .iter()
                .all(|glyph| !glyph.ignored && !glyph.replaced));
            assert_eq!(metrics.glyphs.len(), SAMPLE.chars().count());
            assert!(metrics.advance > 0 && metrics.ink.width > 0 && metrics.ink.height > 0);
            assert_eq!(metrics.font.weight, weight);
            assert_eq!(metrics.font.license, "OFL-1.1");
            assert_eq!(metrics.font.revision, REVISION);
        }
    }
    #[test]
    fn table_hashes_and_source_identity_match_the_generated_manifest() {
        let manifest: serde_json::Value = serde_json::from_str(font_manifest()).unwrap();
        assert_eq!(
            manifest["defaultIgnorables"]["unicodeVersion"],
            IGNORABLE_UNICODE_VERSION
        );
        assert_eq!(manifest["defaultIgnorables"]["scalarCount"], 4174);
        assert_eq!(manifest["unknownGlyph"]["glyphId"], 0);
        assert_eq!(manifest["unknownGlyph"]["noticeFatal"], false);
        for (weight, bytes) in [(400, REGULAR_BYTES), (700, BOLD_BYTES)] {
            let entry = manifest["fonts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["weight"] == weight)
                .unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(bytes)),
                entry["tableSha256"].as_str().unwrap()
            );
            assert_eq!(
                font_identity(weight).unwrap().font_sha256,
                entry["sourceSha256"].as_str().unwrap()
            );
        }
    }
    #[test]
    fn prefix_positions_are_deterministic_and_do_not_accumulate_rounding_drift() {
        for weight in [400, 700] {
            let a = measure_text("Latin 한글 日本語", weight, 13 * 64 + 7).unwrap();
            let b = measure_text("Latin 한글 日本語", weight, 13 * 64 + 7).unwrap();
            assert_eq!(
                serde_json::to_vec(&a).unwrap(),
                serde_json::to_vec(&b).unwrap()
            );
            assert_eq!(
                a.glyphs
                    .iter()
                    .map(|glyph| i64::from(glyph.advance))
                    .sum::<i64>(),
                i64::from(a.advance)
            );
            let last = a.glyphs.last().unwrap();
            assert_eq!(last.position.x + last.advance, a.advance);
        }
    }
    #[test]
    fn default_ignorable_property_is_pinned_to_unicode_17_and_4174_scalars() {
        assert_eq!(IGNORABLE_UNICODE_VERSION, "17.0.0");
        assert_eq!(
            DEFAULT_IGNORABLE_RANGES
                .iter()
                .map(|(first, last)| u64::from(last - first + 1))
                .sum::<u64>(),
            4174
        );
        for &(first, last) in DEFAULT_IGNORABLE_RANGES {
            assert!(is_default_ignorable(char::from_u32(first).unwrap()));
            assert!(is_default_ignorable(char::from_u32(last).unwrap()));
        }
        assert!(SAMPLE.chars().all(|scalar| !is_default_ignorable(scalar)));
    }
    #[test]
    fn unknown_scalar_uses_actual_notdef_metrics_and_a_nonfatal_notice() {
        let unknown = char::MAX.to_string();
        for weight in [400, 700] {
            let font = table(weight).unwrap();
            let notdef = font.glyph(0).unwrap();
            let metrics = measure_text(&unknown, weight, 14 * 64).unwrap();
            assert_eq!(metrics.replacements, 1);
            assert_eq!(metrics.glyphs[0].glyph_id, 0);
            assert_eq!(metrics.glyphs[0].rendered, "");
            assert!(metrics.glyphs[0].replaced && !metrics.glyphs[0].ignored);
            assert_eq!(
                metrics.advance,
                scaled(i64::from(notdef.advance), 14 * 64, font.upem, 0).unwrap()
            );
            assert!(notdef.has_ink && metrics.ink.width > 0 && metrics.ink.height > 0);
            let source_ink = box_from_bounds(
                scaled(i64::from(notdef.x_min), 14 * 64, font.upem, -1).unwrap(),
                scaled(-i64::from(notdef.y_max), 14 * 64, font.upem, -1).unwrap(),
                scaled(i64::from(notdef.x_max), 14 * 64, font.upem, 1).unwrap(),
                scaled(-i64::from(notdef.y_min), 14 * 64, font.upem, 1).unwrap(),
            )
            .unwrap();
            assert_eq!(metrics.ink, source_ink);
            assert_eq!(metrics.glyphs[0].ink, source_ink);
            assert_eq!(
                metrics.glyphs[0].left_side_bearing,
                scaled(i64::from(notdef.bearing), 14 * 64, font.upem, 0).unwrap()
            );
            assert_eq!(metrics.diagnostics.len(), 1);
            assert_eq!(
                metrics.diagnostics[0].code,
                "document/font-replacement-notice"
            );
            assert!(
                !metrics.diagnostics[0].message.is_empty()
                    && !metrics.diagnostics[0].fix.is_empty()
            );
        }
    }
    #[test]
    fn emoji_and_mixed_symbols_never_refuse_coverage_or_use_an_os_fallback() {
        for weight in [400, 700] {
            let font = table(weight).unwrap();
            for input in ["🚀", "😀", "✔", "⚠️", "👩‍💻"] {
                let metrics = measure_text(input, weight, 14 * 64).unwrap();
                assert_eq!(metrics.glyphs.len(), input.chars().count());
                let mut expected_replacements = 0;
                for (scalar, glyph) in input.chars().zip(&metrics.glyphs) {
                    if is_default_ignorable(scalar) {
                        assert!(glyph.ignored && !glyph.replaced);
                        assert_eq!(glyph.advance, 0);
                        assert_eq!(glyph.ink, zero_box());
                        assert_eq!(glyph.rendered, "");
                        assert_eq!(glyph.glyph_id, 0);
                    } else if let Some(mapped) = font.lookup(scalar) {
                        assert!(!glyph.ignored && !glyph.replaced);
                        assert_eq!(glyph.glyph_id, mapped.id);
                        assert_eq!(glyph.rendered, scalar.to_string());
                    } else {
                        expected_replacements += 1;
                        assert!(glyph.replaced && !glyph.ignored);
                        assert_eq!(glyph.glyph_id, 0);
                        assert_eq!(glyph.rendered, "");
                    }
                }
                assert_eq!(metrics.replacements, expected_replacements);
                assert_eq!(
                    metrics.diagnostics.len(),
                    usize::from(expected_replacements > 0)
                );
            }
            let warning = measure_text("⚠️", weight, 14 * 64).unwrap();
            let base = measure_text("⚠", weight, 14 * 64).unwrap();
            assert_eq!(warning.advance, base.advance);
            assert_eq!(warning.ink, base.ink);
            let joined = measure_text("👩‍💻", weight, 14 * 64).unwrap();
            assert!(joined.glyphs[1].ignored);
        }
    }
    #[test]
    fn invalid_weight_size_and_overflow_are_actionable_errors() {
        assert_eq!(
            measure_text("A", 600, 64).unwrap_err().code,
            "document/font-weight"
        );
        assert_eq!(
            measure_text("A", 400, 0).unwrap_err().code,
            "document/font-size"
        );
        assert_eq!(
            measure_text("한글", 400, Coord::MAX).unwrap_err().code,
            "document/font-overflow"
        );
    }
}
