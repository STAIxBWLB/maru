//! Versioned generated metric-table wire format (all integers little-endian).
//! Header: magic, upem/ascender/descender/line-gap, glyph/map counts,
//! source SHA-256, weight and replacement glyph ID. Sorted glyph records
//! contain id/advance/side-bearing/ink bounds/flags; sorted cmap records
//! contain Unicode scalar and original font glyph ID.
pub const MAGIC: &[u8; 8] = b"MDFONT01";
pub const HEADER_LEN: usize = 60;
pub const GLYPH_LEN: usize = 16;
pub const CMAP_LEN: usize = 6;
pub const MISSING_GLYPH: u16 = u16::MAX;
