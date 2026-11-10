//! Glyph outlines from the pinned Noto Sans CJK KR faces.
//!
//! The SVG writer names a font family only, so an exported SVG renders with a
//! system fallback wherever the pinned face is absent and labels can overflow
//! the boxes E2 measured (`maru#552`). This module supplies the same outlines
//! the PNG rasterizer already uses, so a label can be drawn as geometry and no
//! font has to resolve at view time.
//!
//! Coordinates are quantized to whole font units before serialization. The
//! pinned faces are 1000 units per em, so the rounding error is below one
//! thousandth of an em, and the emitted path data no longer depends on how a
//! platform formats a float.

use super::{error, Diagnostic};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use ttf_parser::{Face, GlyphId, OutlineBuilder};

/// The two pinned faces, checked against the same SHA-256 values the PNG
/// rasterizer loads.
const PINNED: [(&str, &[u8], u16, &str); 2] = [
    (
        "regular",
        include_bytes!("fonts/NotoSansCJKkr-Regular.otf"),
        400,
        "6bcb2a0703aa137e874fc2dffa85f6c21ba9a67fa329e81b8c801663af7e992a",
    ),
    (
        "bold",
        include_bytes!("fonts/NotoSansCJKkr-Bold.otf"),
        700,
        "26d0c6748500a0444844280b308f5b62c7ae92ac6c6ac88148e502dd211eb52a",
    ),
];

pub struct PinnedFace {
    face: Face<'static>,
    units_per_em: u16,
    glyphs: BTreeMap<char, Option<String>>,
}

impl PinnedFace {
    /// The face for `weight`, verified against its pinned hash.
    pub fn load(weight: u16) -> Result<Self, Diagnostic> {
        let Some((name, bytes, _, expected)) = PINNED.iter().find(|entry| entry.2 == weight) else {
            return Err(error(
                "font-weight",
                "/font",
                format!("no pinned face carries weight {weight}"),
                "use the pinned Noto weights 400 or 700",
            ));
        };
        let actual = format!("{:x}", Sha256::digest(bytes));
        if actual != *expected {
            return Err(error(
                "font-data",
                "/font",
                format!("pinned {name} face does not match its recorded SHA-256"),
                "restore the pinned NotoSansCJKkr OTF under src/render/fonts and retry",
            ));
        }
        let face = Face::parse(bytes, 0).map_err(|cause| {
            error(
                "font-data",
                "/font",
                format!("pinned {name} face cannot be parsed: {cause:?}"),
                "restore the pinned Noto OTF and retry",
            )
        })?;
        let units_per_em = face.units_per_em();
        if units_per_em == 0 {
            return Err(error(
                "font-data",
                "/font",
                format!("pinned {name} face reports no units per em"),
                "restore the pinned Noto OTF and retry",
            ));
        }
        Ok(Self {
            face,
            units_per_em,
            glyphs: BTreeMap::new(),
        })
    }

    /// Units per em of the pinned face; 1000 for both Noto CJK KR faces.
    pub fn units_per_em(&self) -> u16 {
        self.units_per_em
    }

    /// Path data for `ch` in font units, or `None` when the face has no glyph
    /// for it. Repeated characters are served from the per-document map.
    pub fn path_data(&mut self, ch: char) -> Result<Option<String>, Diagnostic> {
        if let Some(cached) = self.glyphs.get(&ch) {
            return Ok(cached.clone());
        }
        let glyph = self.face.glyph_index(ch).unwrap_or(GlyphId(u16::MAX));
        let mut path = UnitsPath::default();
        let outlined = glyph.0 != u16::MAX && self.face.outline_glyph(glyph, &mut path).is_some();
        let value = outlined.then(|| path.into_data()).filter(|d| !d.is_empty());
        self.glyphs.insert(ch, value.clone());
        Ok(value)
    }
}

/// Builds absolute path data in font units, y pointing up like the face does.
#[derive(Default)]
struct UnitsPath {
    data: String,
}

impl UnitsPath {
    fn number(value: f32) -> i32 {
        // `.round()` on a finite f32 that came from a 1000-unit face.
        value.round() as i32
    }

    fn command(&mut self, name: char, values: &[i32]) {
        if !self.data.is_empty() {
            self.data.push(' ');
        }
        self.data.push(name);
        for value in values {
            self.data.push(' ');
            self.data.push_str(&value.to_string());
        }
    }

    fn into_data(self) -> String {
        self.data
    }
}

impl OutlineBuilder for UnitsPath {
    fn move_to(&mut self, x: f32, y: f32) {
        self.command('M', &[Self::number(x), Self::number(y)]);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.command('L', &[Self::number(x), Self::number(y)]);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.command(
            'Q',
            &[
                Self::number(x1),
                Self::number(y1),
                Self::number(x),
                Self::number(y),
            ],
        );
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.command(
            'C',
            &[
                Self::number(x1),
                Self::number(y1),
                Self::number(x2),
                Self::number(y2),
                Self::number(x),
                Self::number(y),
            ],
        );
    }

    fn close(&mut self) {
        if !self.data.is_empty() {
            self.data.push_str(" Z");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_faces_report_their_units_and_reject_another_weight() {
        let face = PinnedFace::load(400).expect("pinned regular face loads");
        assert_eq!(face.units_per_em(), 1000);
        assert!(PinnedFace::load(900).is_err());
    }

    #[test]
    fn hangul_and_latin_paths_are_whole_font_units_and_repeat_identically() {
        let mut face = PinnedFace::load(400).expect("pinned regular face loads");
        let hangul = face.path_data('주').expect("path lookup succeeds");
        let latin = face.path_data('A').expect("path lookup succeeds");
        let hangul = hangul.expect("Hangul has a glyph");
        let latin = latin.expect("Latin has a glyph");
        for data in [&hangul, &latin] {
            assert!(data.starts_with('M'), "path data starts with a moveto");
            for token in data
                .split([' ', 'M', 'L', 'Q', 'C', 'Z'])
                .filter(|t| !t.is_empty())
            {
                let number: i32 = token.parse().expect("every coordinate is a whole unit");
                assert!(
                    (-200..=1200).contains(&number),
                    "coordinate {number} stays near the em"
                );
            }
        }
        assert_eq!(
            face.path_data('주')
                .expect("second lookup succeeds")
                .unwrap(),
            hangul,
            "a repeated character is served from the per-document map"
        );
        assert_ne!(hangul, latin);
    }

    #[test]
    fn a_space_and_a_control_character_carry_no_outline() {
        let mut face = PinnedFace::load(700).expect("pinned bold face loads");
        assert_eq!(face.path_data(' ').expect("lookup succeeds"), None);
        assert_eq!(face.path_data('\u{7}').expect("lookup succeeds"), None);
    }
}
